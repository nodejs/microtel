'use strict';

const assert = require('node:assert');
const http = require('node:http');
const { after, before, describe, it } = require('node:test');
const {
  startTracing,
  startHTTPServer,
  flushAndCollect,
  getServerSpan,
  getClientSpan,
  httpGet,
  spanAttrs,
  closeAll,
} = require('./common/otel');

describe('otel HTTP client spans', () => {
  let collector;

  before(async () => {
    collector = await startTracing();
  });

  after(() => collector.close());

  it('creates client spans and injects traceparent', async () => {
    let receivedTraceparent = null;

    const target = await startHTTPServer((req, res) => {
      receivedTraceparent = req.headers.traceparent || null;
      res.writeHead(200);
      res.end('ok');
    });

    await httpGet(target.port, '/api/data');
    const spans = await flushAndCollect(collector);

    await target.close();

    const clientSpan = getClientSpan(spans, '/api/data');
    assert.ok(
      clientSpan,
      `Expected a client span in: ${JSON.stringify(spans)}`,
    );
    assert.strictEqual(clientSpan.name, 'GET');

    assert.partialDeepStrictEqual(spanAttrs(clientSpan), {
      'http.request.method': 'GET',
      'server.address': '127.0.0.1',
      'server.port': String(target.port),
      'url.full': `http://127.0.0.1:${target.port}/api/data`,
      'http.response.status_code': '200',
    });

    assert.ok(receivedTraceparent, 'Expected non-empty traceparent');
    assert.match(receivedTraceparent, /^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/);

    // The traceparent must reference the client span's IDs.
    assert.ok(
      receivedTraceparent.includes(clientSpan.traceId),
      'traceparent should contain the client span traceId',
    );
    assert.ok(
      receivedTraceparent.includes(clientSpan.spanId),
      'traceparent should contain the client span spanId',
    );
  });

  // Per OTel semantic conventions, client spans set STATUS_ERROR for >= 400,
  // while server spans only set it for >= 500 (4xx is a client mistake).
  it('sets error on client span but not server span for 404', async () => {
    const server = await startHTTPServer((req, res) => {
      res.writeHead(404);
      res.end('not found');
    });

    await httpGet(server.port, '/missing');
    const spans = await flushAndCollect(collector);

    await server.close();

    const serverSpan = getServerSpan(spans, '/missing');
    const clientSpan = getClientSpan(spans, '/missing');

    assert.ok(serverSpan, 'Expected a server span');
    assert.ok(clientSpan, 'Expected a client span');

    // Server span: 404 must not carry error status.
    assert.strictEqual(serverSpan.status, undefined);

    // Client span: 404 should have error status.
    assert.ok(clientSpan.status, 'Client span should have error status');
    assert.strictEqual(clientSpan.status.code, 2); // STATUS_ERROR
  });

  it('removes a stale tracestate when the span has none', async () => {
    let receivedTracestate = 'sentinel';

    const target = await startHTTPServer((req, res) => {
      receivedTracestate = req.headers.tracestate;
      res.writeHead(200);
      res.end('ok');
    });

    // A caller-supplied tracestate from an unrelated trace must not
    // travel with the freshly generated trace context.
    await new Promise((resolve, reject) => {
      const req = http.get(
        {
          host: '127.0.0.1',
          port: target.port,
          path: '/stale',
          headers: { tracestate: 'vendor=state-for-an-old-trace' },
        },
        (res) => {
          res.resume();
          res.on('end', resolve);
        },
      );
      req.on('error', reject);
    });

    await target.close();

    assert.strictEqual(
      receivedTracestate,
      undefined,
      'stale tracestate must not be forwarded',
    );
  });

  // Node has already stored the headers when the request is created with
  // array headers or an Expect header, so injection is skipped rather than
  // throwing ERR_HTTP_HEADERS_SENT.
  for (const [title, path, getHeaders] of [
    // Node adds no default Host header to array headers.
    [
      'array headers',
      '/array-headers',
      (port) => ['Host', `127.0.0.1:${port}`, 'x-dup', 'a', 'x-dup', 'b'],
    ],
    ['an Expect header', '/expect', () => ({ Expect: '100-continue' })],
  ]) {
    it(`records a client span for a request with ${title}`, async () => {
      let receivedTraceparent = 'sentinel';

      const target = await startHTTPServer((req, res) => {
        receivedTraceparent = req.headers.traceparent;
        req.resume();
        req.on('end', () => {
          res.writeHead(200);
          res.end('ok');
        });
      });

      await new Promise((resolve, reject) => {
        const req = http.request(
          {
            host: '127.0.0.1',
            port: target.port,
            method: 'POST',
            path,
            headers: getHeaders(target.port),
          },
          (res) => {
            res.resume();
            res.on('end', resolve);
          },
        );
        req.on('error', reject);
        req.end('body');
      });

      const spans = await flushAndCollect(collector);
      await target.close();

      assert.strictEqual(receivedTraceparent, undefined);
      const clientSpan = getClientSpan(spans, path);
      assert.ok(clientSpan, 'Expected a client span');
      assert.strictEqual(
        spanAttrs(clientSpan)['http.response.status_code'],
        '200',
      );
    });
  }

  it('omits server.port when the Host port is not decimal', async () => {
    const target = await startHTTPServer((req, res) => {
      res.writeHead(200);
      res.end('ok');
    });

    await new Promise((resolve, reject) => {
      const req = http.get(
        {
          host: '127.0.0.1',
          port: target.port,
          path: '/odd-host',
          headers: { Host: 'example.test:not-a-port' },
        },
        (res) => {
          res.resume();
          res.on('end', resolve);
        },
      );
      req.on('error', reject);
    });

    const spans = await flushAndCollect(collector);
    await target.close();

    const clientSpan = getClientSpan(spans, '/odd-host');
    assert.ok(clientSpan, 'Expected a client span');
    assert.strictEqual(
      spanAttrs(clientSpan)['server.port'],
      undefined,
      'a non-decimal port must be omitted, not encoded',
    );
  });

  it('creates error span for HTTP client connection refused', async () => {
    await httpGet(1, '/fail').catch(() => {});

    const spans = await flushAndCollect(collector);

    const errorSpan = getClientSpan(spans, '/fail');

    assert.ok(
      errorSpan,
      'Expected an error client span for connection refused',
    );

    assert.ok(errorSpan.status, 'Error span should have status');
    assert.strictEqual(errorSpan.status.code, 2); // STATUS_ERROR

    assert.ok(errorSpan.events, 'Error span should have events');
    const exceptionEvent = errorSpan.events.find((e) => e.name === 'exception');
    assert.ok(exceptionEvent, 'Should have exception event');
  });
});
