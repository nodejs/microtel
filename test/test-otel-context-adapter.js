'use strict';

const assert = require('node:assert');
const { after, before, describe, it } = require('node:test');
const { context, trace } = require('@opentelemetry/api');
const { getRPCMetadata } = require('@opentelemetry/core');
const {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  TracerProvider,
} = require('@opentelemetry/sdk-trace');
const microtel = require('..');
const { MicrotelContextManager } = require('./fixtures/otel-context-manager');
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

// This is a compatibility test.
// OpenTelemetry keeps its Contexts in microtel's store through a context
// adapter, so spans from either side parent spans from the other.

const exporter = new InMemorySpanExporter();
context.setGlobalContextManager(new MicrotelContextManager(microtel));
trace.setGlobalTracerProvider(
  new TracerProvider({
    spanProcessors: [new SimpleSpanProcessor({ exporter })],
  }),
);
const tracer = trace.getTracer('test');

const finishedSpan = (name) =>
  exporter.getFinishedSpans().find((span) => span.name === name);

describe('otel context adapter', () => {
  let collector;
  let backend;
  const received = {};

  before(async () => {
    collector = await startTracing();
    backend = await startHTTPServer((req, res) => {
      received[req.url] = req.headers;
      res.end('ok');
    });
  });

  after(() => closeAll(backend, collector));

  it('refuses a second adapter', () => {
    assert.throws(
      () => microtel.context.setAdapter({ getValue() {}, setValues() {} }),
      { code: 'ERR_INVALID_STATE' },
    );
  });

  it('shares a microtel server span with OpenTelemetry', async () => {
    let activeSpanContext;
    let microtelTarget;
    const frontend = await startHTTPServer((req, res) => {
      activeSpanContext = trace.getActiveSpan().spanContext();
      // Framework instrumentations report the route this way.
      getRPCMetadata(context.active()).route = '/users/:id';
      microtelTarget = microtel.context.getOperation(
        microtel.context.active(),
      ).target;
      tracer.startActiveSpan('work', async (work) => {
        await httpGet(backend.port, '/down');
        work.end();
        res.end('ok');
      });
    });

    await rawRequest(frontend.port, '/users/1', {
      traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
      tracestate: 'vendor=state',
    });
    const spans = await flushAndCollect(collector);
    await frontend.close();

    const server = getServerSpan(spans, '/users/1');
    assert.strictEqual(server.parentSpanId, 'b7ad6b7169203331');
    const { traceState, ...ids } = activeSpanContext;
    assert.deepStrictEqual(ids, {
      traceId: server.traceId,
      spanId: server.spanId,
      traceFlags: 1,
      isRemote: false,
    });
    assert.strictEqual(traceState.serialize(), 'vendor=state');
    assert.strictEqual(microtelTarget, '/users/:id');
    assert.strictEqual(server.name, 'GET /users/:id');
    assert.strictEqual(spanAttrs(server)['http.route'], '/users/:id');

    const work = finishedSpan('work');
    assert.strictEqual(work.spanContext().traceId, server.traceId);
    assert.strictEqual(work.parentSpanContext.spanId, server.spanId);
    assert.strictEqual(
      work.spanContext().traceState.serialize(),
      'vendor=state',
    );

    const down = getClientSpan(spans, '/down');
    assert.strictEqual(down.parentSpanId, work.spanContext().spanId);
    assert.strictEqual(
      received['/down'].traceparent,
      `00-${server.traceId}-${down.spanId}-01`,
    );
    assert.strictEqual(received['/down'].tracestate, 'vendor=state');
  });

  it('parents microtel client spans to OpenTelemetry spans', async () => {
    await tracer.startActiveSpan('root', async (root) => {
      assert.strictEqual(
        microtel.context.getTraceContext(microtel.context.active()).spanId,
        root.spanContext().spanId,
      );
      await httpGet(backend.port, '/root');
      root.end();
    });
    const spans = await flushAndCollect(collector);

    const root = finishedSpan('root').spanContext();
    const client = getClientSpan(spans, '/root');
    assert.strictEqual(client.traceId, root.traceId);
    assert.strictEqual(client.parentSpanId, root.spanId);
  });
});
