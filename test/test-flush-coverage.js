'use strict';

const assert = require('node:assert');
const { after, afterEach, before, describe, it } = require('node:test');

const { Span, SPAN_KIND_INTERNAL } = require('../lib/span');
const { addSpan, flush, resetCaches } = require('../lib/flush');
const { startTracing, getSpans, delay } = require('./common/otel');

describe('flush.js coverage', () => {
  let collector;

  before(async () => {
    collector = await startTracing();
  });

  after(() => collector.close());

  afterEach(() => {
    // Isolate flush state between tests.
    resetCaches();
  });

  it('flush is a no-op when buffer is empty', async () => {
    const before = collector.requests.length;

    flush();

    // Wait for any potential export request.
    await delay(100);

    assert.strictEqual(collector.requests.length, before);
  });

  it('encodes boolean, double, and fallback attribute values', async () => {
    // A span-like object covering the OTLP encodings the instrumentations
    // never produce: booleans, non-integer numbers, and values of other
    // types, which fall back to strings.
    const span = {
      name: 'mixed-values',
      traceId: 'a'.repeat(32),
      spanId: 'b'.repeat(16),
      kind: 1,
      startTime: 100,
      endTime: 200,
      getAttributes() {
        return {
          bool: true,
          ratio: 1.5,
          misc: null,
        };
      },
      getEvents() {
        return [];
      },
      status: { code: 0, message: '' },
    };

    addSpan(span);
    flush();

    const payload = await collector.next();
    const attrs = {};
    for (const a of getSpans(payload)[0].attributes) {
      attrs[a.key] = a.value;
    }
    assert.deepStrictEqual(attrs.bool, { boolValue: true });
    assert.deepStrictEqual(attrs.ratio, { doubleValue: 1.5 });
    assert.deepStrictEqual(attrs.misc, { stringValue: 'null' });
  });

  it('flush handles spanToOtlp errors gracefully', async () => {
    const warningPromise = new Promise((resolve) => {
      process.on('warning', function onWarning(w) {
        if (w.name === 'OTelExportWarning') {
          process.removeListener('warning', onWarning);
          resolve(w);
        }
      });
    });

    // A poisoned span-like object that throws during serialization.
    const badSpan = {
      name: 'bad-span',
      getAttributes() {
        throw new Error('serialize boom');
      },
    };

    addSpan(badSpan);
    flush();

    const warning = await warningPromise;

    assert.ok(warning.message.includes('serialize boom'));
  });

  it('flush handles JSONStringify errors gracefully', async () => {
    const warningPromise = new Promise((resolve) => {
      process.on('warning', function onWarning(w) {
        if (w.name === 'OTelExportWarning') {
          process.removeListener('warning', onWarning);
          resolve(w);
        }
      });
    });

    // A span-like object whose BigInt name passes through spanToOtlp but
    // makes JSON.stringify throw.
    const fakeSpan = {
      name: 1n,
      getAttributes() {
        return {};
      },
      getEvents() {
        return [];
      },
      traceId: 'a'.repeat(32),
      spanId: 'b'.repeat(16),
      parentSpanId: null,
      kind: 0,
      startTime: 1,
      endTime: 2,
      status: { code: 0, message: '' },
      traceFlags: 0x01,
    };

    addSpan(fakeSpan);
    flush();

    const warning = await warningPromise;

    assert.ok(warning.message.includes('Failed to serialize'));
  });

  it('resetCaches clears the span buffer', async () => {
    const before = collector.requests.length;

    // A span so the buffer is non-empty.
    const span = new Span('test', SPAN_KIND_INTERNAL);
    span.end();

    resetCaches();

    flush();

    // Wait for any potential export request.
    await delay(100);

    assert.strictEqual(collector.requests.length, before);
  });
});
