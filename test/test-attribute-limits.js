'use strict';

const assert = require('node:assert');
const { after, before, describe, it } = require('node:test');

const { Span, SPAN_KIND_INTERNAL } = require('../lib/span');
const { startTracing, flushAndCollect, spanAttrs } = require('./common/otel');

const kAttributeCountLimit = 128;

describe('span attribute limits', () => {
  let collector;

  before(async () => {
    collector = await startTracing();
  });

  after(() => collector.close());

  it('caps distinct keys at 128 and exports the dropped count', async () => {
    const span = new Span('attribute-cap', SPAN_KIND_INTERNAL);
    for (let i = 0; i < 200; i++) span.setAttribute(`key${i}`, i);
    span.end();

    const [exported] = await flushAndCollect(collector);
    const attrs = spanAttrs(exported);

    assert.strictEqual(exported.attributes.length, kAttributeCountLimit);
    assert.partialDeepStrictEqual(exported, { droppedAttributesCount: 72 });
    // The first 128 keys land and the rest are dropped.
    assert.strictEqual(attrs.key0, '0');
    assert.strictEqual(attrs.key127, '127');
    assert.ok(!('key128' in attrs));
    assert.ok(!('key199' in attrs));
  });

  it('lets writes to existing keys land past the cap', async () => {
    const span = new Span('existing-key', SPAN_KIND_INTERNAL);
    for (let i = 0; i < kAttributeCountLimit; i++)
      span.setAttribute(`key${i}`, i);
    span.setAttribute('key0', 'updated');
    span.setAttribute('past-the-cap', 'dropped');
    span.end();

    const [exported] = await flushAndCollect(collector);
    const attrs = spanAttrs(exported);

    assert.strictEqual(exported.attributes.length, kAttributeCountLimit);
    assert.strictEqual(attrs.key0, 'updated');
    assert.ok(!('past-the-cap' in attrs));
    assert.partialDeepStrictEqual(exported, { droppedAttributesCount: 1 });
  });

  it('frees a slot when a key is cleared past the cap', async () => {
    const span = new Span('cleared-key', SPAN_KIND_INTERNAL);
    for (let i = 0; i < kAttributeCountLimit; i++)
      span.setAttribute(`key${i}`, i);
    // Clearing a key frees its slot for the same key or a new one.
    span.setAttribute('key0', undefined);
    span.setAttribute('key0', 'back');
    span.setAttribute('key1', undefined);
    span.setAttribute('other', 'lands');
    span.end();

    const [exported] = await flushAndCollect(collector);
    const attrs = spanAttrs(exported);

    assert.strictEqual(exported.attributes.length, kAttributeCountLimit);
    assert.strictEqual(attrs.key0, 'back');
    assert.strictEqual(attrs.other, 'lands');
    assert.ok(!('key1' in attrs));
    assert.ok(!Object.hasOwn(exported, 'droppedAttributesCount'));
  });

  it('counts keys exactly after many writes to one key', async () => {
    // The writes alone reach the cap while the span has one key, so the
    // exact count starts there. A null value holds a slot like any other.
    const span = new Span('rewrites', SPAN_KIND_INTERNAL);
    for (let i = 0; i < kAttributeCountLimit; i++) span.setAttribute('same', i);
    for (let i = 1; i < kAttributeCountLimit - 1; i++)
      span.setAttribute(`key${i}`, i);
    span.setAttribute('nullish', null);
    span.setAttribute('one-too-many', 'dropped');
    span.end();

    const [exported] = await flushAndCollect(collector);
    const attrs = spanAttrs(exported);

    assert.strictEqual(exported.attributes.length, kAttributeCountLimit);
    assert.strictEqual(attrs.same, String(kAttributeCountLimit - 1));
    assert.ok('nullish' in attrs);
    assert.ok(!('one-too-many' in attrs));
    assert.partialDeepStrictEqual(exported, { droppedAttributesCount: 1 });
  });

  it('exports no droppedAttributesCount under the cap', async () => {
    const span = new Span('under-the-cap', SPAN_KIND_INTERNAL);
    span.setAttribute('http.request.method', 'GET');
    span.end();

    const [exported] = await flushAndCollect(collector);

    assert.ok(!Object.hasOwn(exported, 'droppedAttributesCount'));
  });
});
