'use strict';

const assert = require('node:assert');
const { describe, it } = require('node:test');
const {
  configureSampler,
  getSampledTracestate,
  sampleRoot,
} = require('../lib/sampler');
const { Span, SPAN_KIND_CLIENT } = require('../lib/span');

// A trace ID whose rightmost 56 bits, the randomness a decision reads,
// are the given 14 hex digits.
const traceId = (randomness, prefix = 'f'.repeat(18)) => prefix + randomness;

describe('otel root sampler', () => {
  it('encodes thresholds the way the OpenTelemetry spec does', () => {
    // The spec's table for 1-in-N sampling at the default precision.
    for (const [ratio, th] of [
      [0.5, '8'],
      [1 / 3, 'aaab'],
      [0.25, 'c'],
      [0.2, 'cccd'],
      [0.125, 'e'],
      [0.1, 'e666'],
      [0.0625, 'f'],
      [0.01, 'fd70a'],
      [0.001, 'ffbe77'],
      [0.0001, 'fff9724'],
      [0.00001, 'ffff583a'],
      [0.000001, 'ffffef39'],
    ]) {
      configureSampler(ratio);
      assert.strictEqual(getSampledTracestate(), `ot=th:${th}`, `${ratio}`);
    }
  });

  it('samples a root when its randomness reaches the threshold', () => {
    configureSampler(0.25);
    assert.strictEqual(sampleRoot(traceId('c0000000000000')), true);
    assert.strictEqual(sampleRoot(traceId('ffffffffffffff')), true);
    assert.strictEqual(sampleRoot(traceId('bfffffffffffff')), false);
    // Only the randomness counts, not the rest of the trace ID.
    assert.strictEqual(
      sampleRoot(traceId('c0000000000000', '0'.repeat(18))),
      true,
    );
  });

  it('keeps every trace at 1 and none at 0', () => {
    configureSampler(1);
    assert.strictEqual(sampleRoot(traceId('00000000000000')), true);
    assert.strictEqual(getSampledTracestate(), undefined);

    configureSampler(0);
    assert.strictEqual(sampleRoot(traceId('ffffffffffffff')), false);
    assert.strictEqual(getSampledTracestate(), undefined);
  });

  it('rounds ratios at the edges of the range', () => {
    // Close enough to 1 that the threshold rounds to zero.
    configureSampler(0.999999);
    assert.strictEqual(getSampledTracestate(), 'ot=th:0');
    assert.strictEqual(sampleRoot(traceId('00000000000000')), true);

    // Smaller than the 56 bits of randomness can express.
    configureSampler(2 ** -60);
    assert.strictEqual(getSampledTracestate(), 'ot=th:ffffffffffff');
    assert.strictEqual(sampleRoot(traceId('fffffffffffeff')), false);
  });

  it('marks root spans with the decision and the random flag', () => {
    configureSampler(0.5);
    // Both decisions show up long before 1000 spans: missing one has odds
    // of 2 in 2^1000.
    const decisions = new Set();
    for (let i = 0; i < 1000 && decisions.size < 2; i++) {
      const span = new Span('GET', SPAN_KIND_CLIENT);
      const sampled = span.traceId.slice(18) >= '80000000000000';
      decisions.add(sampled);
      assert.strictEqual(span.traceFlags, sampled ? 0x03 : 0x02);
      assert.strictEqual(span.tracestate, sampled ? 'ot=th:8' : undefined);
      assert.ok(span.toTraceparent().endsWith(sampled ? '-03' : '-02'));
    }
    assert.strictEqual(decisions.size, 2);
  });

  it('leaves the flags and tracestate of child spans alone', () => {
    configureSampler(0.5);
    for (const traceFlags of [0x00, 0x01, 0x02, 0x03]) {
      const parent = new Span('GET', SPAN_KIND_CLIENT, {
        parent: { traceId: '1'.repeat(32), spanId: '2'.repeat(16), traceFlags },
        tracestate: 'vendor=state',
      });
      const child = new Span('GET', SPAN_KIND_CLIENT, { parent });
      assert.strictEqual(child.traceFlags, traceFlags);
      assert.strictEqual(child.tracestate, 'vendor=state');
    }
  });
});
