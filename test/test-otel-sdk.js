'use strict';

const assert = require('node:assert');
const { before, describe, it } = require('node:test');
const {
  fixture,
  getClientSpan,
  getServerSpan,
  getSpans,
  spanAttrs,
  spawnMicrotel,
  startOTelCollector,
} = require('./common/otel');
const { BridgeSpan, TraceState } = require('../lib/context');
const { Span, SPAN_KIND_SERVER } = require('../lib/span');

const bridged = () => {
  const span = new Span('GET', SPAN_KIND_SERVER);
  return { span, bridge: new BridgeSpan(span) };
};

const kCallerTraceId = '0af7651916cd43dd8448eb211c80319c';
const kCallerSpanId = 'b7ad6b7169203331';
const kRemoteTraceId = '4bf92f3577b34da6a3ce929d0e0e4736';
const kRemoteSpanId = '00f067aa0ba902b7';
// The SDK's own SpanKind values, which differ from the OTLP wire values.
const kSdkServer = 1;

// Each setup runs in a child process, since the SDK registers itself
// globally and init() activates once per process.
async function run(mode, init = {}) {
  const collector = await startOTelCollector();
  const { code, stdout, stderr } = await spawnMicrotel([
    fixture('otel-sdk-child.js'),
    JSON.stringify({
      mode,
      init: { endpoint: `http://127.0.0.1:${collector.port}`, ...init },
    }),
  ]);
  await collector.close();
  assert.strictEqual(code, 0, stderr);

  const { spans, received } = JSON.parse(stdout);
  return {
    sdk: spans,
    microtel: collector.payloads.flatMap(getSpans),
    received,
  };
}

const sdkServerSpan = (spans, path) =>
  spans.find(
    (s) =>
      s.kind === kSdkServer &&
      (s.attributes['http.target'] ?? s.attributes['url.path']) === path,
  );

describe('otel sharing context with the OpenTelemetry SDK', () => {
  describe('when microtel traces inbound requests', () => {
    let result;

    before(async () => {
      result = await run('microtel-inbound');
    });

    it('chains spans from both sides into one trace', () => {
      const { sdk, microtel, received } = result;
      const server = getServerSpan(microtel, '/front');
      const work = sdk.find((s) => s.name === 'work');
      const client = getClientSpan(microtel, '/down');
      const backend = getServerSpan(microtel, '/down');

      assert.partialDeepStrictEqual(server, {
        traceId: kCallerTraceId,
        parentSpanId: kCallerSpanId,
      });
      assert.partialDeepStrictEqual(work, {
        traceId: kCallerTraceId,
        parentSpanId: server.spanId,
        traceState: 'vendor=state',
      });
      assert.partialDeepStrictEqual(client, {
        traceId: kCallerTraceId,
        parentSpanId: work.spanId,
      });
      assert.strictEqual(backend.parentSpanId, client.spanId);
      // The baggage microtel received still travels under the SDK's span.
      assert.strictEqual(received['/down'].baggage, 'user=alice');
    });

    it('marks a parent remote only when it came from another process', () => {
      const { microtel } = result;
      // The SDK span the handler started is in this process. The caller is
      // not, and neither is a span context the SDK extracted from one.
      assert.strictEqual(getClientSpan(microtel, '/down').flags, 0x101);
      assert.strictEqual(getServerSpan(microtel, '/front').flags, 0x301);
      assert.partialDeepStrictEqual(getClientSpan(microtel, '/remote'), {
        traceId: kRemoteTraceId,
        parentSpanId: kRemoteSpanId,
        flags: 0x301,
      });
    });

    it('takes writes from OTel code on its spans, except end()', () => {
      const { microtel } = result;
      const server = getServerSpan(microtel, '/front');
      const backend = getServerSpan(microtel, '/down');

      assert.strictEqual(server.name, 'GET /users/:id');
      assert.strictEqual(spanAttrs(server)['app.tier'], 'web');
      assert.deepStrictEqual(server.status, { code: 2, message: 'failed' });
      const exception = server.events.find((e) => e.name === 'exception');
      assert.partialDeepStrictEqual(spanAttrs(exception), {
        'exception.type': 'Error',
        'exception.message': 'boom',
      });
      // end() was ignored: the span ended with its response, after the
      // request the handler made.
      assert.ok(
        BigInt(server.endTimeUnixNano) >= BigInt(backend.endTimeUnixNano),
      );
      // A write after the span ended was ignored.
      assert.strictEqual(spanAttrs(server)['app.late'], undefined);
    });
  });

  describe('when the SDK traces inbound requests', () => {
    let result;

    before(async () => {
      result = await run('sdk-inbound', { exclude: 'node:http/server' });
    });

    it('chains spans from both sides into one trace', () => {
      const { sdk, microtel, received } = result;
      const server = sdkServerSpan(sdk, '/front');
      const work = sdk.find((s) => s.name === 'work');
      const client = getClientSpan(microtel, '/down');
      const backend = sdkServerSpan(sdk, '/down');

      assert.partialDeepStrictEqual(server, {
        traceId: kCallerTraceId,
        parentSpanId: kCallerSpanId,
      });
      assert.strictEqual(work.parentSpanId, server.spanId);
      assert.partialDeepStrictEqual(client, {
        traceId: kCallerTraceId,
        parentSpanId: work.spanId,
        // The SDK's span is a parent in this process.
        flags: 0x101,
      });
      assert.strictEqual(backend.parentSpanId, client.spanId);
      // microtel propagates the trace context it inherited from the SDK, but
      // not the baggage the SDK extracted.
      assert.strictEqual(received['/down'].tracestate, 'vendor=state');
      assert.strictEqual(received['/down'].baggage, undefined);
    });

    it('does not trace requests the SDK suppresses tracing for', () => {
      const { microtel } = result;
      assert.strictEqual(getClientSpan(microtel, '/front'), undefined);
      assert.strictEqual(microtel.length, 1);
    });
  });

  it('keeps its own context when the SDK cannot attach one', async () => {
    const { sdk, microtel } = await run('no-attach');
    const server = getServerSpan(microtel, '/front');
    const client = getClientSpan(microtel, '/down');
    const work = sdk.find((s) => s.name === 'work');

    assert.strictEqual(client.parentSpanId, server.spanId);
    assert.strictEqual(work.parentSpanId, undefined);
    assert.notStrictEqual(work.traceId, server.traceId);
  });

  it('hands the SDK tracestate unchanged, and changes it like the spec', () => {
    const traceState = new TraceState('a=1, b=2');
    assert.strictEqual(traceState.serialize(), 'a=1, b=2');
    assert.strictEqual(traceState.get('b'), '2');
    assert.strictEqual(traceState.set('b', '3').serialize(), 'b=3,a=1');
    assert.strictEqual(traceState.unset('a').serialize(), 'b=2');
  });

  it('follows the SDK rules for status', () => {
    for (const [writes, expected] of [
      [[1, 2], { code: 1, message: '' }],
      [[2, 0], { code: 2, message: 'oops' }],
      [[2, 1], { code: 1, message: '' }],
    ]) {
      const { span, bridge } = bridged();
      for (const code of writes) bridge.setStatus({ code, message: 'oops' });
      assert.deepStrictEqual({ ...span.status }, expected, `${writes}`);
    }
    const { span, bridge } = bridged();
    bridge.setStatus({ code: 2, message: 42 });
    assert.deepStrictEqual({ ...span.status }, { code: 2, message: '' });
  });

  it('maps exceptions the way the SDK does', () => {
    const { span, bridge } = bridged();
    bridge.recordException({ code: 'ECONNRESET', name: 'Error', message: 'x' });
    bridge.recordException('just a message');
    bridge.recordException({});

    const events = span.getEvents().map((e) => ({ ...e.attributes }));
    assert.deepStrictEqual(events, [
      { 'exception.type': 'ECONNRESET', 'exception.message': 'x' },
      { 'exception.message': 'just a message' },
    ]);
  });

  it('ignores writes once the span has ended', () => {
    const { span, bridge } = bridged();
    span.end();
    bridge
      .setAttribute('key', 'value')
      .setAttributes({ other: 'value' })
      .addEvent('event')
      .setStatus({ code: 2, message: 'late' })
      .updateName('late');
    bridge.recordException(new Error('late'));

    assert.strictEqual(bridge.isRecording(), false);
    assert.strictEqual(span.name, 'GET');
    assert.strictEqual(span.getAttributes().key, undefined);
    assert.strictEqual(span.getAttributes().other, undefined);
    assert.strictEqual(span.getEvents().length, 0);
    assert.strictEqual(span.status.code, 0);
  });

  it('records nothing on a span that is not sampled', () => {
    const span = new Span('GET', SPAN_KIND_SERVER, {
      parent: { traceId: kCallerTraceId, spanId: kCallerSpanId, traceFlags: 0 },
    });
    const bridge = new BridgeSpan(span);
    bridge.setAttribute('key', 'value');

    assert.strictEqual(bridge.isRecording(), false);
    assert.strictEqual(span.getAttributes().key, undefined);
  });

  it('caps the events on a span', () => {
    const { span, bridge } = bridged();
    for (let i = 0; i < 200; i++) bridge.addEvent(`event ${i}`);
    assert.strictEqual(span.getEvents().length, 128);
  });

  it('tells event attributes apart from event times', () => {
    const { span, bridge } = bridged();
    bridge.addEvent('with attributes', { key: 'value' });
    for (const time of [Date.now(), new Date(), [1, 2]])
      bridge.addEvent('with a time', time);

    const [first, ...rest] = span.getEvents();
    assert.strictEqual(first.attributes.key, 'value');
    for (const event of rest)
      assert.deepStrictEqual(Object.keys(event.attributes), []);
  });
});
