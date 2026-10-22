'use strict';

const assert = require('node:assert');
const { describe, it } = require('node:test');
const {
  startOTelCollector,
  getSpans,
  fixture,
  spawnMicrotel,
} = require('./common/otel');

// Buffered spans must be flushed by the beforeExit handler when the
// process exits while tracing is active.

describe('otel beforeExit flush', () => {
  it('flushes buffered spans on process beforeExit', async () => {
    const collector = await startOTelCollector();

    // The child makes a traced request and exits without flushing.
    const { code } = await spawnMicrotel([
      fixture('beforeexit-flush-child.js'),
      JSON.stringify({ endpoint: `http://127.0.0.1:${collector.port}` }),
    ]);

    assert.strictEqual(code, 0);

    const spans = getSpans(await collector.next());

    await collector.close();

    assert.ok(spans.length > 0, 'Expected spans to be flushed on beforeExit');
  });
});
