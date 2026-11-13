'use strict';

const assert = require('node:assert');
const { after, before, describe, it } = require('node:test');
const { context } = require('..');
const {
  startTracing,
  startHTTPServer,
  flushAndCollect,
  getServerSpan,
  getClientSpan,
  rawRequest,
  httpGet,
  spanAttrs,
  closeAll,
} = require('./common/otel');

describe('context outside a request', () => {
  it('reports an empty context', () => {
    const ctx = context.active();
    assert.strictEqual(ctx, undefined);
    assert.strictEqual(context.getTraceContext(ctx), undefined);
    assert.strictEqual(context.getOperation(ctx), undefined);
    assert.strictEqual(context.getTraceContext(null), undefined);
  });
});

describe('context with tracing', () => {
  let collector;

  before(async () => {
    collector = await startTracing();
  });

  after(() => collector.close());

  it('exposes the server request context to the handler', async () => {
    const received = {};
    const backend = await startHTTPServer((req, res) => {
      received[req.url] = req.headers;
      res.end('ok');
    });

    let traceContext;
    let target;
    const frontend = await startHTTPServer(async (req, res) => {
      const ctx = context.active();
      traceContext = context.getTraceContext(ctx);
      context.getOperation(ctx).target = '/users/:id';
      target = context.getOperation(ctx).target;
      await httpGet(backend.port, '/child');
      res.end('ok');
    });

    await rawRequest(frontend.port, '/users/1', {
      traceparent: `00-${'a'.repeat(32)}-${'1'.repeat(16)}-01`,
      tracestate: 'vendor=state',
      baggage: 'user=alice',
    });
    const spans = await flushAndCollect(collector);
    await closeAll(frontend, backend);

    const server = getServerSpan(spans, '/users/1');
    const { traceState, ...ids } = traceContext;
    assert.deepStrictEqual(ids, {
      traceId: server.traceId,
      spanId: server.spanId,
      traceFlags: 1,
      isRemote: false,
    });
    assert.strictEqual(traceState.serialize(), 'vendor=state');
    assert.ok(Object.isFrozen(traceContext));

    assert.strictEqual(target, '/users/:id');
    assert.strictEqual(server.name, 'GET /users/:id');
    assert.strictEqual(spanAttrs(server)['http.route'], '/users/:id');

    assert.strictEqual(
      getClientSpan(spans, '/child').parentSpanId,
      server.spanId,
    );
    assert.strictEqual(received['/child'].tracestate, 'vendor=state');
    assert.strictEqual(received['/child'].baggage, 'user=alice');
  });
});
