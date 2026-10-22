'use strict';

const assert = require('node:assert');
const { describe, it } = require('node:test');
const { flush } = require('../lib/flush');
const {
  startOTelCollector,
  startTracing,
  startHTTPServer,
  getSpans,
  getClientSpan,
  httpGet,
  delay,
  fixture,
  spawnMicrotel,
  closeAll,
} = require('./common/otel');

describe('otel self-trace prevention', () => {
  it('does not create spans for export requests to the collector', async () => {
    const collector = await startTracing();

    const server = await startHTTPServer();

    await httpGet(server.port, '/test');

    // Flushing sends an HTTP request to the collector, which fires
    // http.client.request.created. The self-trace check must prevent a
    // client span for that export request.
    flush();
    await collector.next();

    // Give any inadvertent export-request spans time to buffer, then
    // flush again so they would be exported and observable.
    await delay(100);
    flush();
    await delay(100);

    await closeAll(collector, server);

    const allSpans = collector.payloads.flatMap(getSpans);

    // Export requests must not produce server spans, or a collector in
    // this process would be traced by its own export traffic.
    for (const span of allSpans) {
      const pathAttr = span.attributes?.find((a) => a.key === 'url.path');
      if (pathAttr)
        assert.notStrictEqual(pathAttr.value.stringValue, '/v1/traces');
    }

    // No span may target the collector.
    for (const span of allSpans) {
      const urlAttr = span.attributes?.find((a) => a.key === 'url.full');
      if (urlAttr) {
        assert.ok(
          !urlAttr.value.stringValue.includes(`:${collector.port}`),
          `Span should not target collector: ${urlAttr.value.stringValue}`,
        );
      }
    }

    // Only the user request spans (server + client) may exist.
    const clientSpans = allSpans.filter((s) => s.kind === 3); // CLIENT
    for (const cs of clientSpans) {
      const urlAttr = cs.attributes?.find((a) => a.key === 'url.full');
      assert.ok(urlAttr, 'Client span should have url.full');
      assert.ok(
        urlAttr.value.stringValue.includes('/test'),
        `Client span should be for /test, got: ${urlAttr.value.stringValue}`,
      );
    }
  });

  it('suppresses self-tracing for endpoint paths and nothing else', async () => {
    const collector = await startOTelCollector();

    // The child traces against a collector whose endpoint carries a path,
    // exercises the export path twice, and also makes one ordinary request
    // to the collector's authority.
    const { code, stdout, stderr } = await spawnMicrotel([
      fixture('selftrace-base-child.js'),
      JSON.stringify({ endpoint: `http://127.0.0.1:${collector.port}/base` }),
      String(collector.port),
    ]);

    assert.strictEqual(code, 0, stderr);
    assert.strictEqual(stderr, '');

    const allSpans = collector.payloads.flatMap(getSpans);

    // No server span may exist for the collector's export path, or the
    // exports would feed themselves indefinitely.
    for (const span of allSpans) {
      const pathAttr = span.attributes?.find((a) => a.key === 'url.path');
      assert.ok(
        pathAttr?.value.stringValue !== '/base/v1/traces',
        'export requests must not produce server spans',
      );
    }

    // The ordinary request to the collector's authority must be traced,
    // even though its host matches the collector.
    const healthSpan = getClientSpan(allSpans, '/health');
    assert.ok(healthSpan, 'Expected a client span for the /health request');

    await collector.close();
  });
});
