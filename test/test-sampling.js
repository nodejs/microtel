'use strict';

const assert = require('node:assert');
const http = require('node:http');
const { after, before, describe, it } = require('node:test');
const { Span, SPAN_KIND_SERVER } = require('../lib/span');
const {
  startTracing,
  startOTelCollector,
  startHTTPServer,
  flushAndCollect,
  getSpans,
  httpGet,
  rawRequest,
  fixture,
  spawnMicrotel,
} = require('./common/otel');

// At a ratio of 0.5 the threshold is 8 followed by 13 zeros, and sampled
// roots carry ot=th:8.
const kThreshold = '80000000000000';

describe('otel sampling', () => {
  let collector;

  before(async () => {
    collector = await startTracing({ sampleRatio: 0.5 });
  });

  after(() => collector.close());

  it('samples root traces by the randomness in their trace IDs', async () => {
    const received = {};
    const target = await startHTTPServer((req, res) => {
      received[req.url] = req.headers;
      res.end('ok');
    });

    for (let i = 0; i < 40; i++) await httpGet(target.port, `/root-${i}`);
    // An incoming sampled trace guarantees an export, even if every root
    // above was dropped.
    await rawRequest(target.port, '/anchor', {
      traceparent: `00-${'1'.repeat(32)}-0123456789abcdef-01`,
    });
    const spans = await flushAndCollect(collector);

    await target.close();

    const exported = new Set(spans.map((s) => s.traceId));
    for (let i = 0; i < 40; i++) {
      const { traceparent, tracestate } = received[`/root-${i}`];
      const [, traceId, , flags] = traceparent.split('-');
      if (traceId.slice(18) >= kThreshold) {
        assert.strictEqual(flags, '03');
        assert.strictEqual(tracestate, 'ot=th:8');
        assert.ok(exported.has(traceId), `${traceId} should be exported`);
        // The threshold and flags reach the collector too. The server span's
        // parent arrived over HTTP, so it is remote.
        for (const span of spans.filter((s) => s.traceId === traceId)) {
          assert.strictEqual(span.traceState, 'ot=th:8');
          assert.strictEqual(span.flags, span.kind === 2 ? 0x303 : 0x103);
        }
      } else {
        assert.strictEqual(flags, '02');
        assert.strictEqual(tracestate, undefined);
        assert.ok(!exported.has(traceId), `${traceId} should be dropped`);
      }
    }
  });

  it('follows the trace flags of an incoming traceparent', async () => {
    // Each trace ID's randomness points the other way from its sampled
    // flag, so only the flag can explain the outcome.
    const traceIdFor = (flags) =>
      `${flags}${'1'.repeat(14)}${(parseInt(flags, 16) & 1 ? '0' : 'f').repeat(16)}`;
    const allFlags = ['00', '01', '02', '03'];

    const outgoing = {};
    const backend = await startHTTPServer((req, res) => {
      outgoing[req.url] = req.headers;
      res.end('ok');
    });
    const frontend = await startHTTPServer((req, res) => {
      http.get(`http://127.0.0.1:${backend.port}${req.url}`, (r) => {
        r.resume();
        r.on('end', () => res.end('ok'));
      });
    });

    for (const flags of allFlags) {
      await rawRequest(frontend.port, `/flags-${flags}`, {
        traceparent: `00-${traceIdFor(flags)}-0123456789abcdef-${flags}`,
        tracestate: 'vendor=state',
        baggage: 'key=value',
      });
    }
    const spans = await flushAndCollect(collector);

    await frontend.close();
    await backend.close();

    // The flags pass through unchanged, random flag included, and the
    // tracestate stays as it arrived. These trace IDs did not come from
    // microtel, so it adds neither a random flag nor a threshold.
    const exported = new Set(spans.map((s) => s.traceId));
    for (const flags of allFlags) {
      const traceId = traceIdFor(flags);
      const { traceparent, tracestate } = outgoing[`/flags-${flags}`];
      assert.match(
        traceparent,
        RegExp(`^00-${traceId}-[0-9a-f]{16}-${flags}$`),
      );
      assert.strictEqual(tracestate, 'vendor=state');
      assert.strictEqual(
        exported.has(traceId),
        flags === '01' || flags === '03',
      );
    }
    // The flags and tracestate reach the collector unchanged. Each trace ID
    // starts with its flags. Both server spans have a parent from another
    // process, and the client span between them has a local one.
    const sampledSpans = spans.filter((s) => s.traceId.startsWith('0'));
    assert.strictEqual(sampledSpans.length, 6);
    for (const span of sampledSpans) {
      const inbound = parseInt(span.traceId.slice(0, 2), 16);
      const remote = span.kind === 2 ? 0x200 : 0;
      assert.strictEqual(span.flags, inbound | 0x100 | remote);
      assert.strictEqual(span.traceState, 'vendor=state');
    }
  });

  it('starts no sampled traces at a ratio of 0', async () => {
    // A child process, since this file already used its one activation.
    const zeroCollector = await startOTelCollector();
    const { code, stdout, stderr } = await spawnMicrotel([
      fixture('traced-request-child.js'),
      JSON.stringify({
        endpoint: `http://127.0.0.1:${zeroCollector.port}`,
        sampleRatio: 0,
      }),
    ]);

    assert.strictEqual(code, 0, stderr);
    assert.match(stdout, /done/);
    // The child has exited, so any export it started has completed.
    assert.strictEqual(zeroCollector.requests.length, 0);

    await zeroCollector.close();
  });

  it('gives an unsampled span no export state', () => {
    const span = new Span('GET', SPAN_KIND_SERVER, {
      parent: {
        traceId: '1'.repeat(32),
        spanId: '2'.repeat(16),
        traceFlags: 0,
      },
    });
    span.setAttribute('http.request.method', 'GET');
    span.addEvent('exception', { 'exception.message': 'boom' });
    span.end();

    assert.strictEqual(span.isSampled, false);
    assert.strictEqual(span.startTime, undefined);
    assert.strictEqual(span.getAttributes(), undefined);
    assert.deepStrictEqual(span.getEvents(), []);
    assert.strictEqual(span.endTime, 0);
  });

  it('skips export-only work while unsampled requests propagate', async () => {
    // A child process, since this file already used its one activation.
    // The fixture drives a sampled and an unsampled request through an
    // HTTP frontend, an unsampled fetch, and an unsampled HTTP/2 stream,
    // and reports what each hop saw.
    const zeroCollector = await startOTelCollector();
    const { code, stdout, stderr } = await spawnMicrotel([
      fixture('unsampled-child.js'),
      JSON.stringify({
        endpoint: `http://127.0.0.1:${zeroCollector.port}`,
        sampleRatio: 0,
      }),
    ]);

    assert.strictEqual(code, 0, stderr);
    try {
      const { saw, listeners, stashed } = JSON.parse(
        stdout.trim().split('\n').pop(),
      );

      // The HTTP/2 stream and the fetch hold no span for the export-only
      // handlers to find.
      assert.deepStrictEqual(stashed, { '/h2': false, '/fetch': false });

      // A sampled request gets microtel's own listeners: one 'close' on
      // the server response, one 'end' and one 'close' on the client
      // response. An unsampled request gets none, the same counts as a
      // process without tracing.
      assert.strictEqual(listeners['/sampled'].serverClose, 1);
      assert.strictEqual(listeners['/sampled'].clientEnd, 2);
      assert.strictEqual(listeners['/sampled'].clientClose, 1);
      assert.strictEqual(listeners['/unsampled'].serverClose, 0);
      assert.strictEqual(listeners['/unsampled'].clientEnd, 1);
      assert.strictEqual(listeners['/unsampled'].clientClose, 0);

      // Context still propagates on the unsampled requests: the outgoing
      // traceparent carries the incoming trace ID and flags, and the
      // span's inherited tracestate and baggage replace the stale headers
      // the caller sent.
      assert.match(
        saw['/unsampled'].traceparent,
        RegExp(`^00-${'2'.repeat(32)}-[0-9a-f]{16}-02$`),
      );
      assert.strictEqual(saw['/unsampled'].tracestate, 'kept=yes');
      assert.strictEqual(saw['/unsampled'].baggage, 'kept=yes');
      assert.strictEqual(saw['/sampled'].tracestate, 'kept=yes');

      // An HTTP/2 stream span is current while its stream is handled, so
      // the request it makes carries the stream's trace ID and flags.
      assert.match(
        saw['/h2-hop'].traceparent,
        RegExp(`^00-${'3'.repeat(32)}-[0-9a-f]{16}-02$`),
      );

      // A fetch with no trace context of its own starts a fresh
      // unsampled trace, and the stale propagation headers the caller
      // sent are removed rather than carried into it.
      assert.match(
        saw['/fetch'].traceparent,
        /^00-[0-9a-f]{32}-[0-9a-f]{16}-02$/,
      );
      assert.strictEqual(saw['/fetch'].tracestate, undefined);
      assert.strictEqual(saw['/fetch'].baggage, undefined);

      // The child has exited, so any export it started has completed.
      // Only the request that arrived sampled exported anything.
      const exported = new Set();
      for (const payload of zeroCollector.payloads)
        for (const span of getSpans(payload)) exported.add(span.traceId);
      assert.deepEqual([...exported], ['7'.repeat(32)]);
    } finally {
      // Closed even when an assertion fails, so the server does not
      // keep the process alive.
      await zeroCollector.close();
    }
  });
});
