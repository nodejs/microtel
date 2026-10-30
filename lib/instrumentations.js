'use strict';

const dc = require('node:diagnostics_channel');

const {
  Span,
  SPAN_KIND_SERVER,
  SPAN_KIND_CLIENT,
  STATUS_ERROR,
  kSpan,
} = require('./span');
const {
  isModuleEnabled,
  getSpanStorage,
  getCollectorHost,
  getExportUrl,
} = require('./core');

// Cached at subscription time to avoid a per-event AsyncLocalStorage
// lookup.
let spanStorage;

// Shared client-span response handling. The caller decides when the span
// ends.
function applyClientResponse(span, statusCode) {
  span.setAttribute('http.response.status_code', statusCode);

  if (statusCode >= 400) {
    span.setStatus(STATUS_ERROR, `HTTP ${statusCode}`);
    span.setAttribute('error.type', `${statusCode}`);
  }
}

function failClientSpan(span, error) {
  span.setAttribute('error.type', error?.name || 'Error');
  span.setStatus(STATUS_ERROR, error?.message || 'unknown error');
  span.addEvent('exception', {
    'exception.type': error?.name || 'Error',
    'exception.message': error?.message || '',
    'exception.stacktrace': error?.stack || '',
  });
  span.end();
}

function onHttpServerRequestStart({ request, response, socket }) {
  // Skip the export request itself: tracing an in-process collector would
  // feed itself indefinitely. Both the authority and the resolved export
  // path must match, so a collector serving other paths stays traced.
  const exportUrl = getExportUrl();
  if (
    request.url === exportUrl.pathname &&
    request.headers.host === getCollectorHost()
  ) {
    return;
  }

  const traceparent = request.headers.traceparent;
  const parent =
    traceparent != null ? Span.fromTraceparent(traceparent) : undefined;
  // Per the W3C Trace Context spec, tracestate is only meaningful
  // alongside a valid traceparent. It is discarded when the traceparent
  // is absent or rejected.
  const tracestate = parent != null ? request.headers.tracestate : undefined;
  // Unlike tracestate, baggage propagates independently of traceparent
  // per the W3C Baggage spec, so it is read unconditionally. Like
  // tracestate it is forwarded verbatim; it is never parsed.
  const baggage = request.headers.baggage;

  const method = request.method || 'GET';
  const rawUrl = request.url || '/';
  const qIdx = rawUrl.indexOf('?');
  const path = qIdx === -1 ? rawUrl : rawUrl.slice(0, qIdx);
  // Per the OTel semantic conventions span names must be low cardinality.
  // Core has no route concept, so only the method is used; the path lives
  // in an attribute.
  const span = new Span(method, SPAN_KIND_SERVER, {
    parent,
    // The tracestate and baggage are forwarded verbatim; neither is
    // ever parsed.
    tracestate,
    baggage,
  });

  span.setAttribute('http.request.method', method);
  span.setAttribute('url.path', path);
  if (qIdx !== -1) span.setAttribute('url.query', rawUrl.slice(qIdx + 1));

  span.setAttribute('url.scheme', socket?.encrypted ? 'https' : 'http');
  span.setAttribute('network.protocol.version', request.httpVersion || '1.1');

  const host = request.headers.host;
  if (host) span.setAttribute('server.address', splitAuthority(host)[0]);

  // The span is stashed on the response so the response handlers do not
  // need a second AsyncLocalStorage lookup.
  response[kSpan] = span;

  // The span deliberately stays in the AsyncLocalStorage after the request
  // ends, so work started while handling it still links to the server
  // span as its parent.
  spanStorage.enterWith(span);

  // Response 'close' without 'finish' means the connection was terminated
  // before the response completed. Request 'close' cannot be used for
  // this: it also fires when the request stream is merely consumed, which
  // can happen long before a delayed response is sent.
  response.on('close', onServerResponseClose);
}

// Shared by every server response, so no closure is allocated per
// request. The span is read from the response itself, not through res.req,
// which application code can reassign.
function onServerResponseClose() {
  const span = this[kSpan];
  if (span.endTime === undefined && !this.writableEnded) {
    span.setStatus(STATUS_ERROR, 'request closed before response');
    span.end();
  }
}

function onHttpServerResponseFinish({ response }) {
  const span = response[kSpan];
  if (span == null) return;

  const statusCode = response.statusCode;
  span.setAttribute('http.response.status_code', statusCode);

  if (statusCode >= 500) {
    span.setStatus(STATUS_ERROR, `HTTP ${statusCode}`);
    span.setAttribute('error.type', `${statusCode}`);
  }

  span.end();
}

// Splits an authority (a Host header value) into host and port. The port
// is null when the authority omits it, meaning the scheme default.
function splitAuthority(authority) {
  if (authority.startsWith('[')) {
    // IPv6 literal: the port, if any, follows the closing bracket.
    const hostEnd = authority.indexOf(']');
    if (hostEnd !== -1) {
      const rest = authority.slice(hostEnd + 1);
      return [
        authority.slice(0, hostEnd + 1),
        rest.startsWith(':') ? rest.slice(1) : null,
      ];
    }
  }
  const colon = authority.lastIndexOf(':');
  if (colon === -1) return [authority, null];
  return [authority.slice(0, colon), authority.slice(colon + 1)];
}

function onHttpClientRequestCreated({ request }) {
  // Header APIs accept values of any type, so only a string Host header is
  // used as the authority.
  const rawHost = request.getHeader('host');
  const authority = typeof rawHost === 'string' ? rawHost : request.host || '';

  const { protocol, host } = request;
  const path = request.path;

  // Skip the export request itself: tracing an in-process collector would
  // feed itself indefinitely. Both the authority and the resolved export
  // path must match, so an application request to the collector's other
  // endpoints stays traced.
  const exportUrl = getExportUrl();
  if (authority === getCollectorHost() && path === exportUrl.pathname) return;

  const parent = spanStorage.getStore();

  const method = request.method || 'GET';
  const span = new Span(method, SPAN_KIND_CLIENT, { parent });

  span.setAttribute('http.request.method', method);

  const [hostPart, portPart] = splitAuthority(authority);
  span.setAttribute('server.address', host || hostPart);
  // A decimal port from the authority is recorded, a missing one means the
  // scheme default, and anything else is omitted: NaN would encode as an
  // invalid OTLP value.
  if (portPart == null) {
    span.setAttribute('server.port', protocol === 'https:' ? 443 : 80);
  } else if (/^\d+$/.test(portPart)) {
    span.setAttribute('server.port', Number(portPart));
  }

  span.setAttribute('url.full', `${protocol}//${authority}${path}`);

  request[kSpan] = span;

  // Node stores the headers inside the ClientRequest constructor when they
  // are given as an array or include Expect, so setHeader would throw
  // ERR_HTTP_HEADERS_SENT. The span is still recorded, without propagation.
  if (request.headersSent) return;

  request.setHeader('traceparent', span.toTraceparent());
  // A caller-supplied tracestate or baggage is replaced rather than
  // appended, and a stale value is removed when the span has none to
  // inherit, so it does not travel with the new trace context.
  if (span.tracestate) request.setHeader('tracestate', span.tracestate);
  else request.removeHeader('tracestate');
  if (span.baggage) request.setHeader('baggage', span.baggage);
  else request.removeHeader('baggage');
}

function onHttpClientResponseFinish({ request, response }) {
  const span = request[kSpan];
  if (span == null) return;

  span.setAttribute('network.protocol.version', response.httpVersion || '1.1');
  applyClientResponse(span, response.statusCode);

  // 'end' fires only when the body has been fully read, and 'close'
  // covers aborted responses. Ending a span twice is a no-op, so plain
  // listeners do what once() would without its wrappers.
  response[kSpan] = span;
  response.on('end', endClientResponseSpan);
  response.on('close', endClientResponseSpan);
}

// Shared by every client response, so no closure is allocated per
// request. The span is read from the response itself, not through res.req,
// which application code can reassign.
function endClientResponseSpan() {
  this[kSpan].end();
}

function onClientRequestError({ request, error }) {
  const span = request[kSpan];
  if (span == null) return;

  failClientSpan(span, error);
}

// HTTP/2 server spans. Only the server channels are instrumented: Node's
// http2 client channels publish a detached snapshot of the request headers
// after they have already been serialized for the wire, so there is no seam
// at which an outgoing traceparent could be injected.

function onHttp2ServerStreamStart({ stream, headers }) {
  // Exports travel over HTTP/1.1, so an export request can never arrive as
  // an HTTP/2 stream and the self-trace suppression the http handlers need
  // does not apply here.
  const traceparent = headers?.traceparent;
  const parent =
    traceparent != null ? Span.fromTraceparent(traceparent) : undefined;
  // Per the W3C Trace Context spec, tracestate is only meaningful
  // alongside a valid traceparent. It is discarded when the traceparent
  // is absent or rejected, same as for HTTP/1.1 requests.
  const tracestate = parent != null ? headers?.tracestate : undefined;

  const method = headers?.[':method'] || 'GET';
  const rawUrl = headers?.[':path'] || '/';
  const qIdx = rawUrl.indexOf('?');
  const path = qIdx === -1 ? rawUrl : rawUrl.slice(0, qIdx);

  const span = new Span(method, SPAN_KIND_SERVER, {
    parent,
    // The tracestate is forwarded verbatim; it is never parsed.
    tracestate,
  });

  span.setAttribute('http.request.method', method);
  span.setAttribute('url.path', path);
  if (qIdx !== -1) span.setAttribute('url.query', rawUrl.slice(qIdx + 1));

  // The :scheme pseudo-header carries the request scheme; requests that
  // omit it fall back to the session's encryption state, like the
  // socket check for HTTP/1.1.
  span.setAttribute(
    'url.scheme',
    headers?.[':scheme'] || (stream?.session?.encrypted ? 'https' : 'http'),
  );
  span.setAttribute('network.protocol.version', '2.0');

  const authority = headers?.[':authority'];
  if (authority) span.setAttribute('server.address', authority);

  // The span is stashed on the stream so the finish and close handlers do
  // not need a second AsyncLocalStorage lookup.
  stream[kSpan] = span;

  // The span deliberately stays in the AsyncLocalStorage after the stream
  // ends, so work started while handling it still links to the server
  // span as its parent.
  spanStorage.enterWith(span);
}

// Fires when the response headers are submitted, so the status code is
// known before the body transfers; the span itself ends when the stream
// closes, keeping the duration over the full transfer.
// stream.respond() accepts headers as either an object or a flat array of
// key/value pairs, and the channel publishes whichever form was used.
function getH2Header(headers, name) {
  if (Array.isArray(headers)) return headers[headers.indexOf(name) + 1];
  return headers?.[name];
}

function onHttp2ServerStreamFinish({ stream, headers }) {
  const span = stream[kSpan];
  if (span == null) return;

  const statusCode = Number(getH2Header(headers, ':status'));
  if (!Number.isFinite(statusCode)) return;

  span.setAttribute('http.response.status_code', statusCode);

  if (statusCode >= 500) {
    span.setStatus(STATUS_ERROR, `HTTP ${statusCode}`);
    span.setAttribute('error.type', `${statusCode}`);
  }
}

function onHttp2ServerStreamClose({ stream }) {
  const span = stream[kSpan];
  if (span == null) return;

  // 'close' without a completed response means the stream was terminated
  // before the response completed. The server stream is not ended through
  // the usual stream API on aborts, so writableEnded cannot distinguish
  // them; the aborted flag marks resets, and headersSent is false whenever
  // the server never responded at all.
  if (span.endTime === undefined && (stream.aborted || !stream.headersSent)) {
    span.setStatus(STATUS_ERROR, 'request closed before response');
  }

  span.end();
}

function onHttp2ServerStreamError({ stream, error }) {
  const span = stream[kSpan];
  if (span == null) return;

  if (span.endTime === undefined) {
    span.setStatus(STATUS_ERROR, error?.message || 'stream error');
    span.end();
  }
}

// Undici's addHeader appends rather than replaces; update an existing
// header in place so a caller-supplied value is overridden, not
// duplicated.
function setUndiciHeader(request, name, value) {
  const headers = request.headers;
  for (let i = 0; i < headers.length; i += 2) {
    if (headers[i] === name) {
      headers[i + 1] = value;
      return;
    }
  }
  request.addHeader(name, value);
}

function removeUndiciHeader(request, name) {
  const headers = request.headers;
  for (let i = headers.length - 2; i >= 0; i -= 2) {
    if (headers[i] === name) headers.splice(i, 2);
  }
}

// The last origin parsed, and what it yielded. Consecutive fetch requests
// usually go to the same origin, and new URL() is one of the costliest
// steps in this handler.
let lastOrigin;
let lastOriginAddress;
let lastOriginPort;

function onUndiciRequestCreate({ request }) {
  const parent = spanStorage.getStore();

  const method = request.method || 'GET';
  const span = new Span(method, SPAN_KIND_CLIENT, { parent });

  span.setAttribute('http.request.method', method);

  const { origin } = request;
  const path = request.path;
  if (origin) {
    if (origin !== lastOrigin) {
      // The origin omits the port when it is the scheme default.
      const parsed = new URL(origin);
      lastOriginAddress = parsed.hostname;
      lastOriginPort =
        Number(parsed.port) || (parsed.protocol === 'https:' ? 443 : 80);
      lastOrigin = origin;
    }
    span.setAttribute('server.address', lastOriginAddress);
    span.setAttribute('server.port', lastOriginPort);
  }
  span.setAttribute('url.full', `${origin}${path}`);

  request[kSpan] = span;

  if (request.addHeader) {
    setUndiciHeader(request, 'traceparent', span.toTraceparent());
    if (span.tracestate)
      setUndiciHeader(request, 'tracestate', span.tracestate);
    else removeUndiciHeader(request, 'tracestate');
    if (span.baggage) setUndiciHeader(request, 'baggage', span.baggage);
    else removeUndiciHeader(request, 'baggage');
  }
}

function onUndiciRequestHeaders({ request, response }) {
  const span = request[kSpan];
  if (span == null) return;

  applyClientResponse(span, response.statusCode);
}

// undici:request:trailers fires when the response completes, including its
// body, so the span duration covers the full transfer.
function onUndiciRequestTrailers({ request }) {
  const span = request[kSpan];
  if (span == null) return;

  span.end();
}

function enableInstrumentations() {
  spanStorage = getSpanStorage();

  if (isModuleEnabled('node:http/server')) {
    dc.subscribe('http.server.request.start', onHttpServerRequestStart);
    dc.subscribe('http.server.response.finish', onHttpServerResponseFinish);
  }

  if (isModuleEnabled('node:http/client')) {
    dc.subscribe('http.client.request.created', onHttpClientRequestCreated);
    dc.subscribe('http.client.response.finish', onHttpClientResponseFinish);
    dc.subscribe('http.client.request.error', onClientRequestError);
  }

  // A filter of node:http2 covers node:http2/server through the prefix
  // match in isModuleEnabled, the same way node:http covers its client and
  // server subscopes.
  if (isModuleEnabled('node:http2/server')) {
    dc.subscribe('http2.server.stream.start', onHttp2ServerStreamStart);
    dc.subscribe('http2.server.stream.finish', onHttp2ServerStreamFinish);
    dc.subscribe('http2.server.stream.close', onHttp2ServerStreamClose);
    dc.subscribe('http2.server.stream.error', onHttp2ServerStreamError);
  }

  // node:fetch is an alias for node:undici: both enable the same
  // channels, which cover every undici request, fetch() included.
  if (isModuleEnabled('node:undici') || isModuleEnabled('node:fetch')) {
    dc.subscribe('undici:request:create', onUndiciRequestCreate);
    dc.subscribe('undici:request:headers', onUndiciRequestHeaders);
    dc.subscribe('undici:request:trailers', onUndiciRequestTrailers);
    dc.subscribe('undici:request:error', onClientRequestError);
  }
}

module.exports = {
  enableInstrumentations,
};
