'use strict';

const assert = require('node:assert');
const { inspect } = require('node:util');
const { after, before, describe, it } = require('node:test');
const { Span } = require('../lib/span');
const {
  startTracing,
  startHTTPServer,
  flushAndCollect,
  getServerSpan,
  rawRequest,
  closeAll,
} = require('./common/otel');

describe('otel traceparent validation', () => {
  let collector;

  before(async () => {
    collector = await startTracing();
  });

  after(() => collector.close());

  it('rejects invalid traceparent headers (non-hex chars)', async () => {
    const server = await startHTTPServer();

    await rawRequest(server.port, '/test', {
      traceparent:
        '00-ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ-' + 'ZZZZZZZZZZZZZZZZ-01',
    });

    const spans = await flushAndCollect(collector);
    await server.close();

    const serverSpan = getServerSpan(spans, '/test');
    assert.ok(serverSpan, 'Expected a server span');
    assert.match(serverSpan.traceId, /^[0-9a-f]{32}$/);
    assert.notStrictEqual(
      serverSpan.traceId,
      'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz',
    );
    // No parentSpanId since the invalid traceparent was rejected.
    assert.ok(
      !serverSpan.parentSpanId,
      'Should not have parentSpanId from invalid traceparent',
    );
  });

  it('rejects all-zero traceId in traceparent', async () => {
    const server = await startHTTPServer();

    // All-zero traceId is invalid per W3C spec.
    await rawRequest(server.port, '/test', {
      traceparent:
        '00-00000000000000000000000000000000-' + '0123456789abcdef-01',
    });

    const spans = await flushAndCollect(collector);
    await server.close();

    const serverSpan = getServerSpan(spans, '/test');
    assert.ok(serverSpan);
    assert.notStrictEqual(
      serverSpan.traceId,
      '00000000000000000000000000000000',
    );
    assert.ok(!serverSpan.parentSpanId);
  });

  it('continues the incoming trace for version 01 with extensions', async () => {
    const server = await startHTTPServer();

    await rawRequest(server.port, '/test', {
      traceparent:
        '01-abcdef0123456789abcdef0123456789-' + '0123456789abcdef-01-extra',
    });

    const spans = await flushAndCollect(collector);
    await server.close();

    const serverSpan = getServerSpan(spans, '/test');
    assert.ok(serverSpan);
    assert.strictEqual(serverSpan.traceId, 'abcdef0123456789abcdef0123456789');
    assert.strictEqual(serverSpan.parentSpanId, '0123456789abcdef');
  });
});

describe('otel traceparent parsing', () => {
  const traceId = '0af7651916cd43dd8448eb211c80319c';
  const spanId = 'b7ad6b7169203331';
  const header = (flags) => `00-${traceId}-${spanId}-${flags}`;

  it('parses version 00 headers with any flags', () => {
    for (const [flags, traceFlags] of [
      ['00', 0],
      ['01', 1],
      ['ff', 255],
    ])
      assert.partialDeepStrictEqual(Span.fromTraceparent(header(flags)), {
        traceId,
        spanId,
        traceFlags,
      });
  });

  it('parses higher versions using the known fields and ignores extensions', () => {
    // Regression: valid higher versions must preserve the incoming parent.
    for (const version of ['01', '09', '0a', 'fe']) {
      for (const extension of ['', '-', '-extra', '-extra-more']) {
        const value = `${version}-${traceId}-${spanId}-01${extension}`;
        assert.partialDeepStrictEqual(Span.fromTraceparent(value), {
          traceId,
          spanId,
          traceFlags: 1,
        });
      }
    }
  });

  it('emits version 00 for a child of a higher-version parent', () => {
    const parent = Span.fromTraceparent(`01-${traceId}-${spanId}-01-extra`);
    assert.ok(parent);
    const span = new Span('child', 1, { parent });
    assert.strictEqual(span.toTraceparent(), `00-${traceId}-${span.spanId}-01`);
  });

  it('rejects invalid versions and layouts', () => {
    const invalid = [
      `ff-${traceId}-${spanId}-01`,
      `ff-${traceId}-${spanId}-01-extra`,
      `0A-${traceId}-${spanId}-01`,
      `gg-${traceId}-${spanId}-01`,
      `1-${traceId}-${spanId}-01`,
      `01-${traceId}-${spanId}-0`,
      `01-${traceId}-${spanId}-010`,
      `01-${traceId}-${spanId}-01extra`,
      `01-${'0'.repeat(32)}-${spanId}-01-extra`,
      `01-${traceId}-${'0'.repeat(16)}-01-extra`,
      `01-${traceId.toUpperCase()}-${spanId}-01-extra`,
      `00-${'0'.repeat(32)}-${spanId}-01`,
      `00-${traceId}-${'0'.repeat(16)}-01`,
      `00-${traceId.toUpperCase()}-${spanId}-01`,
      `00-${traceId}-${spanId.toUpperCase()}-01`,
      header('0A'),
      header('0\u0661'),
      `00-${traceId.slice(1)}-${spanId}-01`,
      `00-${traceId}0-${spanId}-01`,
      `00-${traceId}-${spanId.slice(1)}-01`,
      header('1'),
      header('001'),
      `00-${traceId}${spanId}-01`,
      `00--${traceId}-${spanId}-01`,
      `${header('01')}-01`,
      `${header('01')}\n`,
      `${header('01')}\r`,
      `${header('01')}\r\n`,
      ` ${header('01')}`,
      '',
      undefined,
      null,
      1,
      [header('01')],
    ];
    for (const value of invalid)
      assert.strictEqual(Span.fromTraceparent(value), null, inspect(value));
  });
});
