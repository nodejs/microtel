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
    request.headers?.host === getCollectorHost()
  ) {
    return;
  }

  const traceparent = request.headers?.traceparent;
  const parent =
    traceparent != null ? Span.fromTraceparent(traceparent) : undefined;
  // Per the W3C Trace Context spec, tracestate is only meaningful
  // alongside a valid traceparent. It is discarded when the traceparent
  // is absent or rejected.
  const tracestate = parent != null ? request.headers?.tracestate : undefined;

  const method = request.method || 'GET';
  const rawUrl = request.url || '/';
  const qIdx = rawUrl.indexOf('?');
  const path = qIdx === -1 ? rawUrl : rawUrl.slice(0, qIdx);
  // Per the OTel semantic conventions span names must be low cardinality.
  // Core has no route concept, so only the method is used; the path lives
  // in an attribute.
  const span = new Span(method, SPAN_KIND_SERVER, {
    parent,
    // The tracestate is forwarded verbatim; it is never parsed.
    tracestate,
  });

  span.setAttribute('http.request.method', method);
  span.setAttribute('url.path', path);
  if (qIdx !== -1) span.setAttribute('url.query', rawUrl.slice(qIdx + 1));

  span.setAttribute('url.scheme', socket?.encrypted ? 'https' : 'http');
  span.setAttribute('network.protocol.version', request.httpVersion || '1.1');

  const host = request.headers?.host;
  if (host) span.setAttribute('server.address', host);

  // The span is stashed on the request so the response handlers do not
  // need a second AsyncLocalStorage lookup.
  request[kSpan] = span;

  // The span deliberately stays in the AsyncLocalStorage after the request
  // ends, so work started while handling it still links to the server
  // span as its parent.
  spanStorage.enterWith(span);

  // Response 'close' without 'finish' means the connection was terminated
  // before the response completed. Request 'close' cannot be used for
  // this: it also fires when the request stream is merely consumed, which
  // can happen long before a delayed response is sent.
  response.on('close', () => {
    if (span.endTime === undefined && !response.writableEnded) {
      span.setStatus(STATUS_ERROR, 'request closed before response');
      span.end();
    }
  });
}

function onHttpServerResponseFinish({ request, response }) {
  const span = request[kSpan];
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

  request.setHeader('traceparent', span.toTraceparent());
  // A stale tracestate from an unrelated trace must not travel with the
  // new trace context.
  if (span.tracestate) request.setHeader('tracestate', span.tracestate);
  else request.removeHeader('tracestate');
}

function onHttpClientResponseFinish({ request, response }) {
  const span = request[kSpan];
  if (span == null) return;

  span.setAttribute('network.protocol.version', response.httpVersion || '1.1');
  applyClientResponse(span, response.statusCode);

  // 'end' fires only when the body has been fully read; 'close' covers
  // aborted responses.
  const endSpan = () => span.end();
  response.once('end', endSpan);
  response.once('close', endSpan);
}

function onClientRequestError({ request, error }) {
  const span = request[kSpan];
  if (span == null) return;

  failClientSpan(span, error);
}

// TODO(bengl): undici/fetch instrumentation. Subscribing to the
// undici:request:create, undici:request:headers, undici:request:trailers,
// and undici:request:error channels yields one CLIENT span per fetch()
// or request() call, with the same shape as the node:http client spans
// above: http.request.method and url.full (origin + path) attributes,
// server.address set to the origin, server.port derived from it, and the
// span ended on trailers, which fire once the response body completes.
// The headers channel applies the response status; the error channel
// reuses failClientSpan. Trace context injection must replace rather than
// append headers: undici's addHeader appends, so a caller-supplied
// traceparent has to be updated in place or it arrives duplicated. The
// filter values node:undici and node:fetch enable it, as an alias pair.
// A working implementation, including its test, exists in
// nodejs/node#66587 (lib/internal/otel/instrumentations.js and
// test/parallel/test-otel-undici.js); the PR's diff stays viewable even
// once it is closed.

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
}

module.exports = {
  enableInstrumentations,
};
