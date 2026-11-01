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
// and outgoing requests carry the traceparent. The tracestate and
// baggage headers are forwarded verbatim.

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

  it('forwards baggage verbatim across HTTP hops', async () => {
    const incomingTraceId = 'abcdef0123456789abcdef0123456789';
    const incomingTraceparent = `00-${incomingTraceId}-0123456789abcdef-01`;
    // A value with arbitrary list members and extra spaces: baggage is
    // forwarded verbatim, so nothing may be parsed, trimmed, or reordered.
    const incomingBaggage = 'key1=value1,key2=value2, unpacked = value3';

    let outgoingBaggage = 'sentinel';

    const backend = await startHTTPServer((req, res) => {
      outgoingBaggage = req.headers.baggage;
      res.writeHead(200);
      res.end('backend-ok');
    });

    // The frontend makes an outgoing call to the backend, carrying a
    // stale baggage header that the span's inherited baggage must
    // override.
    const frontend = await startHTTPServer((req, res) => {
      http.get(
        `http://127.0.0.1:${backend.port}/backend`,
        {
          headers: { baggage: 'stale=will-be-overridden' },
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

    await rawRequest(frontend.port, '/frontend', {
      traceparent: incomingTraceparent,
      baggage: incomingBaggage,
    });

    const spans = await flushAndCollect(collector);

    await closeAll(frontend, backend);

    assert.strictEqual(
      outgoingBaggage,
      incomingBaggage,
      'The baggage must be forwarded verbatim to child requests',
    );

    // Baggage is a propagation header, not a span attribute: it must
    // not be emitted into the OTLP payload.
    const serverSpan = getServerSpan(spans, '/frontend');
    assert.ok(serverSpan, 'Expected a frontend server span');
    const attributeKeys = (serverSpan.attributes ?? []).map((a) => a.key);
    assert.ok(
      !attributeKeys.includes('baggage'),
      'baggage must not be emitted as a span attribute',
    );
  });

  it('forwards baggage without a traceparent', async () => {
    // Per the W3C Baggage spec, baggage propagates independently of
    // traceparent: a request with baggage but no traceparent starts a
    // fresh trace that still carries the baggage forward.
    const incomingBaggage = 'vendor=state,key=value';

    let outgoingTraceparent = null;
    let outgoingBaggage = 'sentinel';

    const backend = await startHTTPServer((req, res) => {
      outgoingTraceparent = req.headers.traceparent || null;
      outgoingBaggage = req.headers.baggage;
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

    await rawRequest(frontend.port, '/frontend', {
      baggage: incomingBaggage,
    });

    await flushAndCollect(collector);

    await closeAll(frontend, backend);

    // A fresh trace was started, and the baggage still travels with it.
    assert.ok(
      outgoingTraceparent,
      'Expected a traceparent on the outgoing request',
    );
    assert.strictEqual(
      outgoingBaggage,
      incomingBaggage,
      'baggage must be forwarded even without a traceparent',
    );
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

    // Version ff is invalid, so its tracestate is discarded.
    // https://www.w3.org/TR/trace-context/#version
    await rawRequest(frontend.port, '/frontend', {
      traceparent: `ff-${rejectedTraceId}-0123456789abcdef-01`,
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
