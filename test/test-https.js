'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const { after, before, describe, it } = require('node:test');
const {
  startTracing,
  flushAndCollect,
  getClientSpan,
  spanAttrs,
} = require('./common/otel');

const fixturesDir = path.join(__dirname, 'fixtures');

describe('otel HTTPS server spans', () => {
  let collector;

  before(async () => {
    collector = await startTracing();
  });

  after(() => collector.close());

  it('yields the 443 default port for a portless https Host header', async () => {
    const server = https.createServer(
      {
        key: fs.readFileSync(path.join(fixturesDir, 'https-key.pem')),
        cert: fs.readFileSync(path.join(fixturesDir, 'https-cert.pem')),
      },
      (req, res) => {
        res.writeHead(200);
        res.end('ok');
      },
    );
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

    await new Promise((resolve, reject) => {
      https
        .get(
          {
            host: '127.0.0.1',
            port: server.address().port,
            path: '/default-port',
            rejectUnauthorized: false,
            agent: false,
            headers: { Host: 'example.test' },
          },
          (res) => {
            res.resume();
            res.on('end', resolve);
          },
        )
        .on('error', reject);
    });

    const spans = await flushAndCollect(collector);
    await new Promise((resolve) => server.close(resolve));

    const clientSpan = getClientSpan(spans, '/default-port');
    assert.ok(clientSpan, 'Expected a client span');
    assert.strictEqual(
      spanAttrs(clientSpan)['server.port'],
      '443',
      'A portless https Host header must yield 443',
    );
  });

  it('marks the url.scheme attribute as https for TLS requests', async () => {
    const server = https.createServer(
      {
        key: fs.readFileSync(path.join(fixturesDir, 'https-key.pem')),
        cert: fs.readFileSync(path.join(fixturesDir, 'https-cert.pem')),
      },
      (req, res) => {
        res.writeHead(200);
        res.end('ok');
      },
    );
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

    await new Promise((resolve, reject) => {
      https
        .get(
          {
            host: '127.0.0.1',
            port: server.address().port,
            path: '/secure',
            rejectUnauthorized: false,
            agent: false,
          },
          (res) => {
            res.resume();
            res.on('end', resolve);
          },
        )
        .on('error', reject);
    });

    const spans = await flushAndCollect(collector);
    await new Promise((resolve) => server.close(resolve));

    const serverSpan = spans.find((s) => s.kind === 2); // SPAN_KIND_SERVER
    assert.ok(serverSpan, 'Expected a server span');

    assert.partialDeepStrictEqual(spanAttrs(serverSpan), {
      'url.scheme': 'https',
      'url.path': '/secure',
    });
  });
});
