'use strict';

const assert = require('node:assert');
const http = require('node:http');
const { getEventListeners } = require('node:events');
const { after, before, describe, it } = require('node:test');
const { flush } = require('../lib/flush');
const {
  fixture,
  getClientSpan,
  getServerSpan,
  getSpans,
  httpGet,
  spawnMicrotel,
  startHTTPServer,
  startTracing,
} = require('./common/otel');

// flush() returns a promise that resolves once every span buffered when
// it was called has been exported or dropped, and every export already in
// flight has finished. Export failures resolve it, since they are already
// reported as warnings. Only an abort the caller asked for through
// options.signal rejects it. Tracing activates once per process, so the
// in-process tests share one collector and the other configurations run
// in child processes through fixtures.

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

  it('exports as before with no signal and with empty options', async () => {
    const server = await startHTTPServer();
    await httpGet(server.port, '/flush-no-signal');
    await server.close();

    await flush();
    await flush({});

    const allSpans = collector.payloads.flatMap(getSpans);
    assert.ok(getServerSpan(allSpans, '/flush-no-signal'));
  });

  it('throws ERR_INVALID_ARG_TYPE on invalid options and signal', () => {
    assert.throws(() => flush(null), {
      name: 'TypeError',
      code: 'ERR_INVALID_ARG_TYPE',
    });
    assert.throws(() => flush('options'), {
      name: 'TypeError',
      code: 'ERR_INVALID_ARG_TYPE',
    });
    assert.throws(() => flush({ signal: null }), {
      name: 'TypeError',
      code: 'ERR_INVALID_ARG_TYPE',
    });
    assert.throws(() => flush({ signal: 'signal' }), {
      name: 'TypeError',
      code: 'ERR_INVALID_ARG_TYPE',
    });
    assert.throws(() => flush({ signal: {} }), {
      name: 'TypeError',
      code: 'ERR_INVALID_ARG_TYPE',
    });
  });

  it('rejects with an AbortError and keeps the spans when the signal is already aborted', async () => {
    const server = await startHTTPServer();
    await httpGet(server.port, '/flush-already-aborted');
    await server.close();

    const controller = new AbortController();
    controller.abort();
    const before = collector.requests.length;

    await assert.rejects(flush({ signal: controller.signal }), {
      name: 'AbortError',
      code: 'ABORT_ERR',
      message: 'The operation was aborted',
      cause: controller.signal.reason,
    });

    // No export was started, so the spans are still buffered.
    assert.strictEqual(collector.requests.length, before);

    await flush();
    assert.ok(collector.requests.length > before);
    const allSpans = collector.payloads.flatMap(getSpans);
    assert.ok(getServerSpan(allSpans, '/flush-already-aborted'));
  });

  it('rejects right away when aborted mid-export, and the export still finishes', async () => {
    // The collector holds the export's response until the second release,
    // which the child sends only after the rejection, so the abort finds
    // the export in flight and the rejection cannot wait for it.
    let exportArrived = false;
    let exportBody = '';
    let pendingExportRes;
    let pendingReleaseRes;
    const collector = http.createServer((req, res) => {
      if (req.url === '/release-1' || req.url === '/release-2') {
        req.resume();
        req.on('end', () => {
          if (req.url === '/release-2' && pendingExportRes !== undefined) {
            pendingExportRes.writeHead(200);
            pendingExportRes.end();
            pendingExportRes = undefined;
          }
          if (exportArrived || req.url === '/release-2') {
            res.writeHead(200);
            res.end();
          } else {
            pendingReleaseRes = res;
          }
        });
        return;
      }
      req.on('data', (chunk) => {
        exportBody += chunk;
      });
      req.on('end', () => {
        exportArrived = true;
        if (pendingReleaseRes !== undefined) {
          pendingReleaseRes.writeHead(200);
          pendingReleaseRes.end();
          pendingReleaseRes = undefined;
        }
        pendingExportRes = res;
      });
    });
    await new Promise((resolve) => collector.listen(0, '127.0.0.1', resolve));

    try {
      const { code, stdout } = await spawnMicrotel(
        [
          fixture('flush-abort-child.js'),
          JSON.stringify({
            endpoint: `http://127.0.0.1:${collector.address().port}`,
          }),
        ],
        {},
        { timeout: 5_000 },
      );

      assert.strictEqual(code, 0);
      assert.strictEqual(
        stdout.trim(),
        'rejected AbortError ABORT_ERR\nlisteners 0\n' +
          'second flush pending\nsecond flush settled',
      );
      assert.ok(
        getClientSpan(getSpans(JSON.parse(exportBody)), '127.0.0.1:1/'),
      );
    } finally {
      collector.close();
    }
  });

  it('rejects even when an earlier abort listener stops propagation', async () => {
    // Core's own abort listeners run regardless, and so does this one, or
    // a caller's listener could hold the flush open.
    const controller = new AbortController();
    controller.signal.addEventListener('abort', (event) =>
      event.stopImmediatePropagation(),
    );
    const flushed = flush({ signal: controller.signal });
    controller.abort();
    await assert.rejects(flushed, { name: 'AbortError', code: 'ABORT_ERR' });
  });

  it('rejects with the timeout reason as cause', async () => {
    // The collector accepts the connection but never answers, so only the
    // signal can settle the flush first.
    const collector = http.createServer(() => {});
    await new Promise((resolve) => collector.listen(0, '127.0.0.1', resolve));

    try {
      const { code, stdout } = await spawnMicrotel(
        [
          '-e',
          `
          const http = require('node:http');
          const { init, flush } = require(process.env.MICROTEL_PATH);
          init({
            endpoint: 'http://127.0.0.1:${collector.address().port}',
            exportTimeout: 250,
          });
          http.get('http://127.0.0.1:1/', () => {})
            .on('error', async () => {
              try {
                await flush({ signal: AbortSignal.timeout(50) });
                console.log('flush resolved');
              } catch (err) {
                console.log(JSON.stringify({
                  name: err.name,
                  code: err.code,
                  message: err.message,
                  cause: err.cause.name,
                }));
              }
            });
        `,
        ],
        {},
        { timeout: 5_000 },
      );

      assert.strictEqual(code, 0);
      assert.deepStrictEqual(JSON.parse(stdout), {
        name: 'AbortError',
        code: 'ABORT_ERR',
        message: 'The operation was aborted',
        cause: 'TimeoutError',
      });
    } finally {
      collector.close();
    }
  });

  it('drops the abort listener once flush() settles', async () => {
    const server = await startHTTPServer();
    await httpGet(server.port, '/flush-listener');
    await server.close();

    const controller = new AbortController();
    const signal = controller.signal;
    const wait = flush({ signal });
    assert.strictEqual(getEventListeners(signal, 'abort').length, 1);
    await wait;
    assert.strictEqual(getEventListeners(signal, 'abort').length, 0);

    // A long-lived signal reused across flushes collects no listeners.
    for (let i = 0; i < 3; i++) await flush({ signal });
    assert.strictEqual(getEventListeners(signal, 'abort').length, 0);
  });
});
