'use strict';

const assert = require('node:assert');
const http = require('node:http');
const { after, before, describe, it } = require('node:test');
const { flush } = require('../lib/flush');
const {
  fixture,
  getServerSpan,
  getSpans,
  httpGet,
  spawnMicrotel,
  startHTTPServer,
  startTracing,
} = require('./common/otel');

// flush() returns a promise that resolves once every span buffered when
// it was called has been exported or dropped, and every export already in
// flight has finished. It resolves, never rejects. Tracing activates once
// per process, so the in-process tests share one collector and the other
// configurations run in child processes through fixtures.

describe('flush() promise', () => {
  let collector;

  before(async () => {
    collector = await startTracing();
  });

  after(() => collector.close());

  it('resolves right away with nothing to export', async () => {
    const before = collector.requests.length;

    const promise = flush();
    assert.ok(promise instanceof Promise);
    assert.strictEqual(await promise, undefined);

    assert.strictEqual(collector.requests.length, before);
  });

  it('resolves with the batch already at the collector', async () => {
    const server = await startHTTPServer();
    await httpGet(server.port, '/flush-promise');
    await server.close();

    await flush();

    // No waiting on the collector: the payload is there when the promise
    // resolves.
    const allSpans = collector.payloads.flatMap(getSpans);
    assert.ok(getServerSpan(allSpans, '/flush-promise'));
  });

  it('resolves before init() activated tracing', async () => {
    const { code, stdout } = await spawnMicrotel([
      '-e',
      `
      const { flush } = require(process.env.MICROTEL_PATH);
      flush().then(() => console.log('resolved'));
    `,
    ]);

    assert.strictEqual(code, 0);
    assert.match(stdout, /resolved/);
  });

  it('resolves, not rejects, when the collector is down', async () => {
    // Nothing listens on the endpoint, so the export fails with a
    // connection refusal.
    const { code, stdout } = await spawnMicrotel([
      fixture('flush-failure-child.js'),
      JSON.stringify({ endpoint: 'http://127.0.0.1:1' }),
    ]);

    assert.strictEqual(code, 0);
    assert.match(stdout, /flush resolved/);
  });

  it('resolves, not rejects, when the export times out', async () => {
    // A collector that accepts the connection but never answers. A short
    // exportTimeout keeps the test fast.
    const collector = http.createServer(() => {});
    await new Promise((resolve) => collector.listen(0, '127.0.0.1', resolve));

    try {
      const { code, stdout, stderr } = await spawnMicrotel(
        [
          fixture('flush-failure-child.js'),
          JSON.stringify({
            endpoint: `http://127.0.0.1:${collector.address().port}`,
            exportTimeout: 250,
          }),
        ],
        {},
        { timeout: 5_000 },
      );

      assert.strictEqual(code, 0);
      assert.match(stdout, /flush resolved/);
      assert.match(stderr, /OTelExportWarning/);
    } finally {
      collector.close();
    }
  });

  it('resolves when the collector resets mid-response', async () => {
    // The response has started, so the reset reaches the export as a
    // response error rather than a request error.
    const collector = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'content-length': '10' });
        res.write('x', () => res.destroy());
      });
    });
    await new Promise((resolve) => collector.listen(0, '127.0.0.1', resolve));

    try {
      const { code, stdout } = await spawnMicrotel(
        [
          fixture('flush-failure-child.js'),
          JSON.stringify({
            endpoint: `http://127.0.0.1:${collector.address().port}`,
          }),
        ],
        {},
        { timeout: 5_000 },
      );

      assert.strictEqual(code, 0);
      assert.match(stdout, /flush resolved/);
    } finally {
      collector.close();
    }
  });

  it('releases the request when sending throws', async () => {
    // The collector accepts the connection and never answers. The throw
    // comes after the request and its deadline exist, and either one left
    // behind would hold the child for the whole exportTimeout.
    const collector = http.createServer(() => {});
    await new Promise((resolve) => collector.listen(0, '127.0.0.1', resolve));

    try {
      const { code, stdout, stderr } = await spawnMicrotel(
        [
          '-e',
          `
          const http = require('node:http');
          const { init, flush } = require(process.env.MICROTEL_PATH);
          init({
            endpoint: 'http://127.0.0.1:${collector.address().port}',
            exportTimeout: 60000,
          });
          http.get('http://127.0.0.1:1/').on('error', async () => {
            http.ClientRequest.prototype.end = () => {
              throw new Error('end boom');
            };
            await flush();
            console.log('flush resolved');
          });
        `,
        ],
        {},
        { timeout: 5_000 },
      );

      assert.strictEqual(code, 0);
      assert.match(stdout, /flush resolved/);
      assert.match(stderr, /OTelExportWarning: .*end boom/);
    } finally {
      collector.close();
    }
  });

  it('waits for an export still in flight from an earlier flush', async () => {
    // The delayed response keeps the first export in flight when the
    // second flush() runs.
    const collector = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => setTimeout(() => res.end(), 100));
    });
    await new Promise((resolve) => collector.listen(0, '127.0.0.1', resolve));

    try {
      const { code, stdout } = await spawnMicrotel(
        [
          fixture('flush-order-child.js'),
          JSON.stringify({
            endpoint: `http://127.0.0.1:${collector.address().port}`,
          }),
        ],
        {},
        { timeout: 5_000 },
      );

      assert.strictEqual(code, 0);
      assert.strictEqual(stdout.trim(), 'first second');
    } finally {
      collector.close();
    }
  });
});
