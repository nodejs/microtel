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
    // types, which fall back to strings. NaN and the infinities have no
    // JSON number form, so they must arrive as ProtoJSON strings.
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
          nan: NaN,
          inf: Infinity,
          negInf: -Infinity,
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
    assert.deepStrictEqual(attrs.nan, { doubleValue: 'NaN' });
    assert.deepStrictEqual(attrs.inf, { doubleValue: 'Infinity' });
    assert.deepStrictEqual(attrs.negInf, { doubleValue: '-Infinity' });
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

    // A poisoned span-like object that throws during serialization. Its
    // timestamps are valid, so the throw comes from the attributes.
    const badSpan = {
      name: 'bad-span',
      startTime: 1,
      endTime: 2,
      getAttributes() {
        throw new Error('serialize boom');
      },
    };

    addSpan(badSpan);
    flush();

    const warning = await warningPromise;

    assert.ok(warning.message.includes('serialize boom'));
  });

  it('drops only the span that fails to serialize', async () => {
    const warningPromise = new Promise((resolve) => {
      process.on('warning', function onWarning(w) {
        if (w.name === 'OTelExportWarning') {
          process.removeListener('warning', onWarning);
          resolve(w);
        }
      });
    });

    const goodSpan = (spanId) => ({
      name: 'good-span',
      traceId: 'a'.repeat(32),
      spanId,
      kind: 1,
      startTime: 1,
      endTime: 2,
      getAttributes() {
        return {};
      },
      getEvents() {
        return [];
      },
      status: { code: 0, message: '' },
    });

    // A poisoned span between two good ones: the batch must still export
    // both of the good spans.
    addSpan(goodSpan('1'.repeat(16)));
    addSpan({
      name: 'bad-span',
      startTime: 1,
      endTime: 2,
      getAttributes() {
        throw new Error('serialize boom');
      },
    });
    addSpan(goodSpan('2'.repeat(16)));
    flush();

    // Both are awaited before asserting, so a failed assertion cannot
    // leave this payload queued for the next test.
    const [warning, payload] = await Promise.all([
      warningPromise,
      collector.next(),
    ]);
    assert.match(warning.message, /serialize boom/);
    assert.deepStrictEqual(
      getSpans(payload).map((s) => s.spanId),
      ['1'.repeat(16), '2'.repeat(16)],
    );
  });

  it('escapes span names so the payload stays valid JSON', async () => {
    // A span-like object whose name needs JSON escaping: the hand-written
    // encoder must still produce a valid payload.
    const fakeSpan = {
      name: 'quote " backslash \\ newline \n',
      getAttributes() {
        return { 'url.path': 'tab\there' };
      },
      getEvents() {
        return [];
      },
      traceId: 'a'.repeat(32),
      spanId: 'b'.repeat(16),
      parentSpanId: null,
      kind: 1,
      startTime: 1,
      endTime: 2,
      status: { code: 2, message: 'err "quoted"' },
      traceFlags: 0x01,
    };

    addSpan(fakeSpan);
    flush();

    // collector.next() parses the body with JSON.parse, so receiving a
    // payload at all proves it is valid JSON.
    const payload = await collector.next();
    const span = getSpans(payload).find((sp) => sp.spanId === 'b'.repeat(16));
    assert.ok(span, 'Expected the escaped span in the payload');
    assert.strictEqual(span.name, 'quote " backslash \\ newline \n');
    assert.strictEqual(span.status.message, 'err "quoted"');
    assert.strictEqual(span.attributes[0].value.stringValue, 'tab\there');
  });

  it('escapes attribute keys so the payload stays valid JSON', async () => {
    // setAttribute takes any key, so the encoder cannot assume keys come
    // from the fixed set the instrumentations write.
    const span = new Span('keys', SPAN_KIND_INTERNAL);
    span.setAttribute('quote"key', 'value');
    span.setAttribute('newline\nkey', 'value');
    span.addEvent('event', { 'tab\tkey': 'value' });
    span.end();
    flush();

    const payload = await collector.next();
    const exported = getSpans(payload).find((s) => s.spanId === span.spanId);
    assert.ok(exported, 'Expected the span in the payload');
    assert.deepStrictEqual(
      exported.attributes.map((a) => a.key),
      ['quote"key', 'newline\nkey'],
    );
    assert.strictEqual(exported.events[0].attributes[0].key, 'tab\tkey');
  });

  it('round-trips non-ASCII and surrogate values exactly', async () => {
    // Text without surrogates takes the fast path. Astral characters and
    // lone surrogates go through JSON.stringify, and a lone surrogate sent
    // unescaped would arrive as U+FFFD.
    const values = ['é漢字\u2028\u2029', 'emoji 😀', 'lone \ud800 surrogate'];
    addSpan({
      name: 'unicode',
      traceId: 'a'.repeat(32),
      spanId: 'c'.repeat(16),
      kind: 1,
      startTime: 1,
      endTime: 2,
      getAttributes() {
        return { a: values[0], b: values[1], c: values[2] };
      },
      getEvents() {
        return [];
      },
      status: { code: 0, message: '' },
    });
    flush();

    const exported = getSpans(await collector.next())[0];
    assert.deepStrictEqual(
      exported.attributes.map((a) => a.value.stringValue),
      values,
    );
  });

  it('formats timestamps exactly like BigInt arithmetic', async () => {
    // Ordinary epoch milliseconds take the string fast path. Zero, values
    // past the safe integer range, and non-finite times must still match
    // BigInt arithmetic, which throws for non-finite input and so drops
    // the span.
    const timed = (spanId, startTime, endTime) => ({
      name: 'times',
      traceId: 'a'.repeat(32),
      spanId,
      kind: 1,
      startTime,
      endTime,
      getAttributes() {
        return {};
      },
      getEvents() {
        return [];
      },
      status: { code: 0, message: '' },
    });

    addSpan(timed('1'.repeat(16), 0, 1e21));
    addSpan(timed('2'.repeat(16), 1700000000000.4, 1700000000000.6));
    addSpan(timed('3'.repeat(16), NaN, 1));
    flush();

    const spans = getSpans(await collector.next());
    assert.deepStrictEqual(
      spans.map((s) => [s.spanId, s.startTimeUnixNano, s.endTimeUnixNano]),
      [
        ['1'.repeat(16), '0', '1000000000000000000000000000'],
        ['2'.repeat(16), '1700000000000000000', '1700000000001000000'],
      ],
    );
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
