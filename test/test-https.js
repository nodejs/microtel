'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const { describe, it } = require('node:test');
const { startTracing, flushAndCollect, spanAttrs } = require('./common/otel');

const fixturesDir = path.join(__dirname, 'fixtures');

describe('otel HTTPS server spans', () => {
  it('marks the url.scheme attribute as https for TLS requests', async () => {
    const collector = await startTracing();

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

    await collector.close();
    await new Promise((resolve) => server.close(resolve));

    const serverSpan = spans.find((s) => s.kind === 2); // SPAN_KIND_SERVER
    assert.ok(serverSpan, 'Expected a server span');

    assert.partialDeepStrictEqual(spanAttrs(serverSpan), {
      'url.scheme': 'https',
      'url.path': '/secure',
    });
  });
});
