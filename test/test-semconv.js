'use strict';

const assert = require('node:assert');
const { after, before, describe, it } = require('node:test');
// The registry of defined attribute names: the package's exports are the
// attribute names the OpenTelemetry semantic conventions define.
const semconv = require('@opentelemetry/semantic-conventions');
const { flush } = require('../lib/flush');
const { startTracing, startHTTPServer, httpGet } = require('./common/otel');

const registry = new Set(
  Object.values(semconv).filter((v) => typeof v === 'string'),
);

describe('otel semantic conventions', () => {
  let collector;

  before(async () => {
    collector = await startTracing();
  });

  after(() => collector.close());

  it('emits only attribute names the conventions define', async () => {
    // One trace through every instrumentation shape: a server span with
    // its query attribute, http and fetch client spans, a failed request
    // for the error attributes, and a refused connection for the
    // exception event attributes.
    const ok = await startHTTPServer();
    const failing = await startHTTPServer((req, res) => {
      res.writeHead(500);
      res.end();
    });

    await httpGet(ok.port, '/semconv?token=1');
    await fetch(`http://127.0.0.1:${ok.port}/fetch`)
      .then((res) => res.text())
      .catch(() => {});
    await httpGet(failing.port, '/fail');
    await httpGet(1, '/refused').catch(() => {});

    flush();
    const payload = await collector.next();

    await ok.close();
    await failing.close();

    const spans = payload.resourceSpans[0].scopeSpans[0].spans;
    assert.ok(
      spans.some((s) => s.kind === 2),
      'Expected a server span',
    );
    assert.ok(
      spans.some((s) => s.kind === 3),
      'Expected client spans',
    );

    const assertDefined = (key, where) =>
      assert.ok(
        registry.has(key),
        `${where} attribute "${key}" is not defined by the ` +
          'semantic conventions',
      );

    for (const span of spans) {
      for (const attr of span.attributes ?? []) {
        assertDefined(attr.key, 'span');
      }
      for (const event of span.events ?? []) {
        for (const attr of event.attributes ?? []) {
          assertDefined(attr.key, 'event');
        }
      }
    }

    for (const attr of payload.resourceSpans[0].resource.attributes) {
      assertDefined(attr.key, 'resource');
    }
  });
});
