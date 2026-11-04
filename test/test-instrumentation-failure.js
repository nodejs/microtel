'use strict';

const assert = require('node:assert');
const { describe, it } = require('node:test');
const { fixture, spawnMicrotel } = require('./common/otel');

// The fixtures patch microtel's internals, so they run in child processes.

const siteOf = (message) => /^microtel (.+) handler failed/.exec(message)?.[1];

describe('otel handler failures', () => {
  it('warn instead of breaking requests, timers, or exit', async () => {
    const { code, stdout } = await spawnMicrotel(
      [
        fixture('instrumentation-failure-child.js'),
        JSON.stringify({
          endpoint: 'http://127.0.0.1:1',
          flushInterval: 100,
          maxBufferSize: 2,
        }),
      ],
      {},
      // A broken guard can leave the child's requests hanging.
      { timeout: 15_000 },
    );

    assert.strictEqual(code, 0);
    const { completed, injected, warnings, details, uncaught } =
      JSON.parse(stdout);

    assert.deepStrictEqual(uncaught, []);
    assert.strictEqual(completed, 12);

    // One warning per window, naming the first failure in it.
    assert.deepStrictEqual(warnings.map(siteOf), [
      'http.client.request.created',
      'flush timer',
      'deferred flush',
      'beforeExit flush',
    ]);
    assert.ok(
      warnings.at(-1).endsWith(` (${injected} total failures)`),
      `Expected ${injected} failures in "${warnings.at(-1)}"`,
    );
    assert.match(details[0], /^Error: setAttribute boom\n\s+at /);
  });

  it('warn instead of breaking exports', async () => {
    const { code, stdout } = await spawnMicrotel(
      [
        fixture('export-failure-child.js'),
        JSON.stringify({ endpoint: 'http://127.0.0.1:1', exportTimeout: 50 }),
      ],
      {},
      { timeout: 15_000 },
    );

    assert.strictEqual(code, 0);
    const { warnings, escaped, uncaught, settled } = JSON.parse(stdout);

    const sites = [
      'export timeout',
      'export response',
      'export response end',
      'export response error',
      'export request error',
    ];
    assert.deepStrictEqual(uncaught, []);
    assert.deepStrictEqual(escaped, []);
    assert.deepStrictEqual(warnings.map(siteOf), sites);
    // Every export still settled, so no flush() was left waiting.
    assert.deepStrictEqual(settled.toSorted(), sites.toSorted());
  });
});
