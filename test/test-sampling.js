'use strict';

const assert = require('node:assert');
const http = require('node:http');
const { after, before, describe, it } = require('node:test');
const {
  startTracing,
  startOTelCollector,
  startHTTPServer,
  flushAndCollect,
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
});
