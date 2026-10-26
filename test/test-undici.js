'use strict';

const assert = require('node:assert');
const { after, before, describe, it } = require('node:test');
const {
  startTracing,
  startHTTPServer,
  flushAndCollect,
  getClientSpan,
  rawRequest,
  spanAttrs,
  closeAll,
} = require('./common/otel');

describe('otel undici spans', () => {
  let collector;

  before(async () => {
    collector = await startTracing({
      filter: 'node:http,node:undici',
    });
  });

  after(() => collector.close());

  it(
    'creates client spans for fetch requests and overrides existing ' +
      'trace context headers',
    async () => {
      const receivedTraceparent = {};
      const target = await startHTTPServer((req, res) => {
        receivedTraceparent[req.url] = req.headers.traceparent;
        res.writeHead(200);
        res.end('ok');
      });

      try {
        const res = await fetch(`http://127.0.0.1:${target.port}/fetch-test`);
        await res.text();
      } catch {}

      // A caller-supplied traceparent must be overridden, not duplicated:
      // undici's addHeader appends, so a duplicate would arrive as a single
      // comma-separated value.
      try {
        const res = await fetch(
          `http://127.0.0.1:${target.port}/override-test`,
          {
            headers: {
              traceparent:
                '00-00000000000000000000000000000000-' + '0000000000000000-00',
            },
          },
        );
        await res.text();
      } catch {}

      const spans = await flushAndCollect(collector);
      await target.close();

      assert.ok(spans.length > 0, 'Expected at least one span from fetch');
      const clientSpan = getClientSpan(spans, '/fetch-test');
      assert.ok(clientSpan, 'Expected a CLIENT span from fetch');

      assert.partialDeepStrictEqual(spanAttrs(clientSpan), {
        'http.request.method': 'GET',
        'server.address': `http://127.0.0.1:${target.port}`,
        'server.port': String(target.port),
        'url.full': `http://127.0.0.1:${target.port}/fetch-test`,
        'http.response.status_code': '200',
      });

      const overridden = receivedTraceparent['/override-test'];
      assert.ok(overridden, 'Expected a traceparent on the override request');
      assert.match(overridden, /^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/);
      assert.ok(
        !overridden.includes(','),
        'traceparent must be overridden, not duplicated',
      );
    },
  );

  it('creates an error span for a failed fetch', async () => {
    // A response that dies mid-transfer must end the span with the error
    // status and an exception event, through the undici:request:error
    // channel. A fetch that fails to connect never dispatches, so it
    // produces no span at all.
    const target = await startHTTPServer((req, res) => {
      res.writeHead(200);
      res.write('partial');
      setTimeout(() => res.destroy(), 50);
    });

    await fetch(`http://127.0.0.1:${target.port}/destroy`)
      .then((res) => res.text())
      .catch(() => {});

    const spans = await flushAndCollect(collector);
    await target.close();

    const errorSpan = getClientSpan(spans, '/destroy');
    assert.ok(errorSpan, 'Expected an error client span for the failed fetch');

    assert.ok(errorSpan.status, 'Error span should have status');
    assert.strictEqual(errorSpan.status.code, 2); // STATUS_ERROR
    assert.ok(
      errorSpan.events?.some((e) => e.name === 'exception'),
      'Should have an exception event',
    );
  });

  it('overrides a stale tracestate with the inherited one', async () => {
    const incomingTraceId = 'a'.repeat(32);
    const incomingTracestate = 'vendor=inherited';

    let seen;
    // The fetch target records the trace context headers it receives.
    const fetchTarget = await startHTTPServer((req, res) => {
      seen = {
        traceparent: req.headers.traceparent,
        tracestate: req.headers.tracestate,
      };
      res.writeHead(200);
      res.end('ok');
    });

    // A fetch made while handling a traced request inherits the incoming
    // tracestate and must override the caller-supplied stale one.
    const frontend = await startHTTPServer((req, res) => {
      fetch(`http://127.0.0.1:${fetchTarget.port}/down`, {
        headers: { tracestate: 'stale=caller-value' },
      }).then((fr) => {
        fr.text().then(() => {
          res.writeHead(200);
          res.end('ok');
        });
      });
    });

    await rawRequest(frontend.port, '/up', {
      traceparent: `00-${incomingTraceId}-0123456789abcdef-01`,
      tracestate: incomingTracestate,
    });

    await flushAndCollect(collector);
    await closeAll(fetchTarget, frontend);

    assert.ok(seen?.traceparent, 'Expected a traceparent on the fetch');
    assert.ok(
      seen.traceparent.includes(incomingTraceId),
      'The fetch must carry the incoming trace ID',
    );
    assert.strictEqual(
      seen.tracestate,
      incomingTracestate,
      'The inherited tracestate must win over the stale one',
    );
  });

  it('removes a stale tracestate when the span has none', async () => {
    let receivedTracestate = 'sentinel';
    const target = await startHTTPServer((req, res) => {
      receivedTracestate = req.headers.tracestate;
      res.writeHead(200);
      res.end('ok');
    });

    try {
      const res = await fetch(`http://127.0.0.1:${target.port}/stale`, {
        headers: { tracestate: 'vendor=state-for-an-old-trace' },
      });
      await res.text();
    } catch {}

    const spans = await flushAndCollect(collector);
    await target.close();

    assert.ok(getClientSpan(spans, '/stale'), 'Expected a client span');

    // A stale tracestate from an unrelated trace must not travel with
    // the fresh trace context, even though the span has none to inject.
    assert.strictEqual(
      receivedTracestate,
      undefined,
      'stale tracestate must not be forwarded',
    );
  });
});
