'use strict';

const assert = require('node:assert');
const http = require('node:http');
const { after, before, describe, it } = require('node:test');
const {
  startTracing,
  startHTTPServer,
  flushAndCollect,
  getServerSpan,
  getClientSpan,
  rawRequest,
  closeAll,
} = require('./common/otel');

// W3C trace context propagation: child spans share the incoming trace ID,
// and outgoing requests carry the traceparent.

describe('otel context propagation', () => {
  let collector;

  before(async () => {
    collector = await startTracing();
  });

  after(() => collector.close());

  it('propagates trace context across HTTP hops', async () => {
    const incomingTraceId = 'abcdef0123456789abcdef0123456789';
    const incomingSpanId = '0123456789abcdef';
    const incomingTraceparent = `00-${incomingTraceId}-${incomingSpanId}-01`;
    const incomingTracestate = 'vendor=value';

    let outgoingTraceparent = null;
    let outgoingTracestate = null;

    // Backend records the outgoing trace context headers.
    const backend = await startHTTPServer((req, res) => {
      outgoingTraceparent = req.headers.traceparent || null;
      outgoingTracestate = req.headers.tracestate || null;
      res.writeHead(200);
      res.end('backend-ok');
    });

    // Frontend makes an outgoing call to the backend, carrying a stale
    // tracestate that the span's inherited tracestate must override.
    const frontend = await startHTTPServer((req, res) => {
      http.get(
        `http://127.0.0.1:${backend.port}/backend`,
        {
          headers: { tracestate: 'stale=will-be-overridden' },
        },
        (backendRes) => {
          backendRes.resume();
          backendRes.on('end', () => {
            res.writeHead(200);
            res.end('frontend-ok');
          });
        },
      );
    });

    // A raw request bypasses the client instrumentation, which would
    // overwrite the headers.
    await rawRequest(frontend.port, '/frontend', {
      traceparent: incomingTraceparent,
      tracestate: incomingTracestate,
    });

    const spans = await flushAndCollect(collector);

    await closeAll(frontend, backend);

    assert.ok(
      spans.length >= 1,
      `Expected at least 1 span, got: ${spans.length}`,
    );

    const serverSpan = getServerSpan(spans, '/frontend');
    assert.ok(serverSpan, 'Expected a frontend server span');
    assert.strictEqual(serverSpan.traceId, incomingTraceId);

    assert.strictEqual(serverSpan.parentSpanId, incomingSpanId);

    const clientSpan = getClientSpan(spans, '/backend');
    assert.ok(clientSpan, 'Expected a client span for outgoing backend call');
    assert.strictEqual(clientSpan.traceId, incomingTraceId);

    assert.ok(outgoingTraceparent);
    assert.ok(
      outgoingTraceparent.includes(incomingTraceId),
      'Outgoing traceparent should carry the original traceId',
    );

    // The tracestate must be forwarded verbatim to child requests.
    assert.strictEqual(outgoingTracestate, incomingTracestate);
  });

  it('discards tracestate when the traceparent is invalid', async () => {
    const rejectedTraceId = 'abcdef0123456789abcdef0123456789';

    let outgoingTraceparent = null;
    let outgoingTracestate = null;

    const backend = await startHTTPServer((req, res) => {
      outgoingTraceparent = req.headers.traceparent || null;
      outgoingTracestate = req.headers.tracestate || null;
      res.writeHead(200);
      res.end('backend-ok');
    });

    const frontend = await startHTTPServer((req, res) => {
      http.get(`http://127.0.0.1:${backend.port}/backend`, (backendRes) => {
        backendRes.resume();
        backendRes.on('end', () => {
          res.writeHead(200);
          res.end('frontend-ok');
        });
      });
    });

    // Version 01 is rejected per the W3C spec, so the tracestate that
    // arrived with it must not be forwarded to child requests.
    await rawRequest(frontend.port, '/frontend', {
      traceparent: `01-${rejectedTraceId}-0123456789abcdef-01`,
      tracestate: 'vendor=value',
    });

    await closeAll(frontend, backend);

    assert.ok(
      outgoingTraceparent,
      'Expected a traceparent on the outgoing request',
    );
    // A fresh trace was started, so the rejected trace ID must not leak.
    assert.ok(
      !outgoingTraceparent.includes(rejectedTraceId),
      'Outgoing traceparent must not carry the rejected traceId',
    );
    assert.strictEqual(
      outgoingTracestate,
      null,
      'tracestate must be discarded with an invalid ' + 'traceparent',
    );
  });
});
