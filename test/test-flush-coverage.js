'use strict';

const assert = require('node:assert');
const { after, afterEach, before, describe, it } = require('node:test');

const { Span, SPAN_KIND_INTERNAL } = require('../lib/span');
const { addSpan, flush, resetCaches } = require('../lib/flush');
const { startTracing, delay } = require('./common/otel');

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
    flush();

    // Wait for any potential export request.
    await delay(100);

    assert.strictEqual(collector.requests.length, 0);
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
    // A span so the buffer is non-empty.
    const span = new Span('test', SPAN_KIND_INTERNAL);
    span.end();

    resetCaches();

    flush();

    // Wait for any potential export request.
    await delay(100);

    assert.strictEqual(collector.requests.length, 0);
  });
});
