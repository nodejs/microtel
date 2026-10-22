'use strict';

const assert = require('node:assert');
const http = require('node:http');
const { describe, it } = require('node:test');
const { fixture, spawnMicrotel } = require('./common/otel');

// This test verifies exporter error handling and process lifecycle behavior.
// Tracing is activated in the child processes through the public init() API;
// the children run fixtures from test/fixtures with JSON init options on
// argv.

describe('otel exporter behavior', () => {
  it('does not crash when collector is unreachable', async () => {
    // The child traces a request against its own server and flushes to a
    // dead endpoint. The export fails, but the child exits normally.
    const { code, stdout } = await spawnMicrotel([
      fixture('traced-request-child.js'),
      JSON.stringify({ endpoint: 'http://127.0.0.1:1' }),
    ]);

    assert.strictEqual(code, 0);
    assert.match(stdout, /done/);
  });

  it('gives up on an unresponsive collector and still exits', async () => {
    // A collector that accepts the connection but never responds. The
    // exporter request must time out, and the child must still exit. A
    // short exportTimeout keeps the test fast.
    const collector = http.createServer(() => {});
    await new Promise((resolve) => collector.listen(0, '127.0.0.1', resolve));

    try {
      const { code, stderr } = await spawnMicrotel(
        [
          fixture('export-timeout-child.js'),
          JSON.stringify({
            endpoint: `http://127.0.0.1:${collector.address().port}`,
            exportTimeout: 250,
          }),
        ],
        {},
        { timeout: 5_000 },
      );

      assert.strictEqual(code, 0);
      assert.match(stderr, /OTelExportWarning/);
    } finally {
      collector.close();
    }
  });

  it('enforces the export deadline against a trickling collector', async () => {
    // A collector that writes a response byte every 50ms resets any idle
    // timeout forever; only an absolute deadline can end the export.
    const collector = http.createServer((req, res) => {
      res.writeHead(200);
      const interval = setInterval(() => res.write('x'), 50);
      req.on('close', () => clearInterval(interval));
    });
    await new Promise((resolve) => collector.listen(0, '127.0.0.1', resolve));

    try {
      const { code, stderr } = await spawnMicrotel(
        [
          fixture('export-timeout-child.js'),
          JSON.stringify({
            endpoint: `http://127.0.0.1:${collector.address().port}`,
            exportTimeout: 250,
          }),
        ],
        {},
        { timeout: 5_000 },
      );

      assert.strictEqual(
        code,
        0,
        'the child must exit when the export deadline hits',
      );
      assert.match(stderr, /OTelExportWarning/);
    } finally {
      collector.close();
    }
  });

  it('flush timer does not keep process alive', async () => {
    // No spans are buffered, so no flush timer exists: the child must exit
    // as soon as its script ends.
    const { code, stdout } = await spawnMicrotel(
      [
        '-e',
        `
      const { init } = require(process.env.MICROTEL_PATH);
      init({ endpoint: 'http://127.0.0.1:1' });
      console.log('exiting');
    `,
      ],
      {},
      { timeout: 10_000 },
    );

    assert.strictEqual(code, 0);
    assert.match(stdout, /exiting/);
  });
});
