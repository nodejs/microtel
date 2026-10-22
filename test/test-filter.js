'use strict';

const assert = require('node:assert');
const { describe, it } = require('node:test');
const { flush } = require('../lib/flush');
const {
  startOTelCollector,
  startTracing,
  startHTTPServer,
  httpGet,
  delay,
  fixture,
  getSpans,
  spawnMicrotel,
  closeAll,
} = require('./common/otel');

describe('otel filter', () => {
  it('does not create spans for filtered-out modules', async () => {
    // Filter to a module that will not be exercised.
    const collector = await startTracing({ filter: 'node:dns' });

    const server = await startHTTPServer();

    await httpGet(server.port, '/');

    // If any spans were created despite the filter, they would be
    // exported here.
    flush();

    // Wait for any potential export request.
    await delay(100);

    assert.strictEqual(collector.requests.length, 0);

    await closeAll(collector, server);
  });

  it('does not create spans for excluded modules', async () => {
    const collector = await startOTelCollector();

    // A child process: this file already used its single activation, and
    // the exclude list is fixed at activation time. Nothing can be
    // exported, since node:http spans are the only ones this child could
    // produce.
    const { code, stdout, stderr } = await spawnMicrotel([
      fixture('traced-request-child.js'),
      JSON.stringify({
        endpoint: `http://127.0.0.1:${collector.port}`,
        exclude: 'node:http',
      }),
    ]);

    assert.strictEqual(code, 0);
    assert.match(stdout, /done/);
    assert.strictEqual(stderr, '');

    // The child has exited, so any export it started has completed: no
    // HTTP spans can exist, so nothing can have been exported.
    assert.strictEqual(collector.requests.length, 0);

    await collector.close();
  });

  it('filters node:http client and server separately', async () => {
    const collector = await startOTelCollector();

    const { code, stdout } = await spawnMicrotel([
      fixture('traced-request-child.js'),
      JSON.stringify({
        endpoint: `http://127.0.0.1:${collector.port}`,
        filter: 'node:http/server',
      }),
    ]);

    assert.strictEqual(code, 0);
    assert.match(stdout, /done/);

    const spans = getSpans(await collector.next());
    await collector.close();

    assert.ok(
      spans.some((s) => s.kind === 2),
      'Expected a server span',
    );
    assert.ok(!spans.some((s) => s.kind === 3), 'Expected no client span');
  });
});
