'use strict';

const assert = require('node:assert');
const { after, before, describe, it } = require('node:test');
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

  it('rejects traceparent versions other than 00', async () => {
    const server = await startHTTPServer();

    // Version 01 is not understood; a fresh trace must be started.
    await rawRequest(server.port, '/test', {
      traceparent:
        '01-abcdef0123456789abcdef0123456789-' + '0123456789abcdef-01',
    });

    const spans = await flushAndCollect(collector);
    await server.close();

    const serverSpan = getServerSpan(spans, '/test');
    assert.ok(serverSpan);
    assert.notStrictEqual(
      serverSpan.traceId,
      'abcdef0123456789abcdef0123456789',
    );
    assert.ok(
      !serverSpan.parentSpanId,
      'Should not have a parent from an unknown version',
    );
  });
});
