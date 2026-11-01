'use strict';

// This samples root spans the way OpenTelemetry's ProbabilitySampler does.
// The rightmost 56 bits of a trace ID are its randomness, the sample ratio
// sets a rejection threshold, and a root span is sampled when its
// randomness is at least the threshold. Spans with a parent follow the
// parent's decision instead, so a trace is kept or dropped as a whole.
//
// The threshold is kept as 14 lowercase hex digits, the same form as the
// end of a trace ID. Hex strings of equal length compare the way the
// numbers they spell do, so a decision is one string comparison.

// The number of threshold digits the spec recommends.
const kPrecision = 4;

let sampleAll = true;
let sampleNone = false;
let threshold = '';
let sampledTracestate;

// The spec's reference conversion from a probability to the threshold
// digits that tracestate carries. The rejection probability is shifted
// into [1, 2), rounded to the precision, and read off as the hex digits
// of its mantissa, with trailing zeros dropped. A probability near zero
// gets an extra digit for every leading f, so the precision applies to
// its significant digits.
function thresholdDigits(ratio) {
  let exponent = 0;
  for (let m = ratio; m < 0.5; m *= 2) exponent--;
  const precision = Math.max(
    1,
    Math.min(12, kPrecision + Math.floor(exponent / -4)),
  );

  let rejection = 2 - ratio;
  rejection += 2 ** (-4 * precision - 1);
  const digits =
    rejection >= 2
      ? 'fffffffffffff'
      : Math.floor((rejection - 1) * 2 ** 52)
          .toString(16)
          .padStart(13, '0');
  // A ratio this close to 1 rounds to a zero threshold, which keeps
  // everything.
  return digits.slice(0, precision).replace(/0+$/, '') || '0';
}

function configureSampler(ratio) {
  sampleAll = ratio === 1;
  sampleNone = ratio === 0;
  threshold = '';
  sampledTracestate = undefined;
  if (sampleAll || sampleNone) return;

  const digits = thresholdDigits(ratio);
  threshold = digits.padEnd(14, '0');
  sampledTracestate = `ot=th:${digits}`;
}

function sampleRoot(traceId) {
  if (sampleAll) return true;
  if (sampleNone) return false;
  return traceId.slice(18) >= threshold;
}

// The tracestate a sampled root span starts its trace with. The spec's
// ot=th entry tells samplers and backends downstream the probability the
// trace was kept with. There is none when every trace is kept.
const getSampledTracestate = () => sampledTracestate;

module.exports = {
  configureSampler,
  getSampledTracestate,
  sampleRoot,
};
