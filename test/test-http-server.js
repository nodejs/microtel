'use strict';

const assert = require('node:assert');
const http = require('node:http');
const { after, before, describe, it } = require('node:test');
const {
  startTracing,
  startHTTPServer,
  flushAndCollect,
  getServerSpan,
  httpGet,
  spanAttrs,
} = require('./common/otel');

describe('otel HTTP server spans', () => {
  let collector;

  before(async () => {
    collector = await startTracing();
  });

  after(() => collector.close());

  it('creates server spans for incoming HTTP requests', async () => {
    const app = await startHTTPServer();

    await httpGet(app.port, '/test-path');

    const spans = await flushAndCollect(collector);

    await app.close();

    assert.ok(
      spans.length >= 1,
      `Expected at least 1 span, got ${spans.length}`,
    );

    const serverSpan = spans.find((s) => s.kind === 2); // SPAN_KIND_SERVER
    assert.ok(serverSpan, 'Expected a server span');
    assert.strictEqual(serverSpan.name, 'GET');

    assert.ok(serverSpan.traceId);
    assert.strictEqual(serverSpan.traceId.length, 32);
    assert.ok(serverSpan.spanId);
    assert.strictEqual(serverSpan.spanId.length, 16);
    assert.ok(serverSpan.startTimeUnixNano);
    assert.ok(serverSpan.endTimeUnixNano);

    assert.partialDeepStrictEqual(spanAttrs(serverSpan), {
      'http.request.method': 'GET',
      'url.path': '/test-path',
      'http.response.status_code': '200',
    });
  });

  it('does not end the span while a delayed response is pending', async () => {
    // A request with a body completes its input stream well before the
    // response is sent; the span must wait for the response.
    const server = await startHTTPServer((req, res) => {
      req.resume();
      setTimeout(() => {
        res.writeHead(200);
        res.end('ok');
      }, 250);
    });

    await new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port: server.port,
          method: 'POST',
          path: '/slow',
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
    await server.close();

    const serverSpan = getServerSpan(spans, '/slow');
    assert.ok(serverSpan, 'Expected a server span');
    assert.strictEqual(
      serverSpan.status,
      undefined,
      'A successful delayed response must not carry error ' + 'status',
    );
    assert.strictEqual(
      spanAttrs(serverSpan)['http.response.status_code'],
      '200',
    );
  });
});
