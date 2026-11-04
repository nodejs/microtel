'use strict';

const assert = require('node:assert');
const { after, before, describe, it } = require('node:test');
const {
  startTracing,
  startOTelCollector,
  startHTTPServer,
  flushAndCollect,
  getClientSpan,
  getServerSpan,
  rawRequest,
  spanAttrs,
  closeAll,
  fixture,
  getSpans,
  spawnMicrotel,
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
        'server.address': '127.0.0.1',
        'server.port': String(target.port),
        'url.full': `http://127.0.0.1:${target.port}/fetch-test`,
        'http.response.status_code': '200',
      });

      const overridden = receivedTraceparent['/override-test'];
      assert.ok(overridden, 'Expected a traceparent on the override request');
      // A root span is sampled and sets the random flag.
      assert.match(overridden, /^00-[0-9a-f]{32}-[0-9a-f]{16}-03$/);
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

  it('overrides a stale baggage with the inherited one', async () => {
    const incomingTraceId = 'b'.repeat(32);
    const incomingBaggage = 'vendor=inherited,key=value';

    let seen;
    // The fetch target records the trace context headers it receives.
    const fetchTarget = await startHTTPServer((req, res) => {
      seen = {
        traceparent: req.headers.traceparent,
        baggage: req.headers.baggage,
      };
      res.writeHead(200);
      res.end('ok');
    });

    // A fetch made while handling a traced request inherits the incoming
    // baggage and must override the caller-supplied stale one.
    const frontend = await startHTTPServer((req, res) => {
      fetch(`http://127.0.0.1:${fetchTarget.port}/down`, {
        headers: { baggage: 'stale=caller-value' },
      }).then((fr) => {
        fr.text().then(() => {
          res.writeHead(200);
          res.end('ok');
        });
      });
    });

    await rawRequest(frontend.port, '/up', {
      traceparent: `00-${incomingTraceId}-0123456789abcdef-01`,
      baggage: incomingBaggage,
    });

    const spans = await flushAndCollect(collector);
    await closeAll(fetchTarget, frontend);

    assert.ok(seen?.traceparent, 'Expected a traceparent on the fetch');
    assert.ok(
      seen.traceparent.includes(incomingTraceId),
      'The fetch must carry the incoming trace ID',
    );
    assert.strictEqual(
      seen.baggage,
      incomingBaggage,
      'The inherited baggage must win over the stale one',
    );

    // Baggage is a propagation header, not a span attribute: it must
    // not be emitted into the OTLP payload.
    const clientSpan = getClientSpan(spans, '/down');
    assert.ok(clientSpan, 'Expected a client span for the fetch');
    const attributeKeys = (clientSpan.attributes ?? []).map((a) => a.key);
    assert.ok(
      !attributeKeys.includes('baggage'),
      'baggage must not be emitted as a span attribute',
    );
  });

  it('forwards the full trace context on a fetch', async () => {
    const incomingTraceId = 'c'.repeat(32);
    const incomingTracestate = 'vendor=state,other=1';
    const incomingBaggage = 'key=value,other=2';

    let seen;
    // The fetch target records the trace context headers it receives.
    const fetchTarget = await startHTTPServer((req, res) => {
      seen = {
        traceparent: req.headers.traceparent,
        tracestate: req.headers.tracestate,
        baggage: req.headers.baggage,
      };
      res.writeHead(200);
      res.end('ok');
    });

    // A fetch with no trace headers of its own, so every injected header
    // takes the appended path rather than overriding a caller-supplied
    // value.
    const frontend = await startHTTPServer((req, res) => {
      fetch(`http://127.0.0.1:${fetchTarget.port}/down`).then((fr) => {
        fr.text().then(() => {
          res.writeHead(200);
          res.end('ok');
        });
      });
    });

    await rawRequest(frontend.port, '/up', {
      traceparent: `00-${incomingTraceId}-0123456789abcdef-01`,
      tracestate: incomingTracestate,
      baggage: incomingBaggage,
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
      'The inherited tracestate must be forwarded verbatim',
    );
    assert.strictEqual(
      seen.baggage,
      incomingBaggage,
      'The inherited baggage must be forwarded verbatim',
    );
  });

  it('validates tracestate and baggage through addHeader', async () => {
    // traceparent is the only header microtel appends without addHeader(),
    // since only its value is always microtel's own.
    const { code, stdout, stderr } = await spawnMicrotel([
      fixture('undici-headers-spy-child.js'),
      // The fixture's own http.get stands in for a caller, so microtel must
      // not replace its trace headers.
      JSON.stringify({
        endpoint: 'http://127.0.0.1:1',
        exclude: 'node:http/client',
      }),
    ]);

    assert.strictEqual(code, 0, stderr);
    const { added, received } = JSON.parse(stdout);
    assert.deepStrictEqual(added, ['tracestate', 'baggage']);
    assert.partialDeepStrictEqual(received, {
      tracestate: 'rojo=00f067aa0ba902b7',
      baggage: 'user=alice',
    });
    assert.match(
      received.traceparent,
      /^00-0af7651916cd43dd8448eb211c80319c-[0-9a-f]{16}-01$/,
    );
  });

  it('falls back to addHeader when the headers are not a flat array', async () => {
    const collector = await startOTelCollector();

    // The collector is closed even when an assertion fails, or its open
    // server would keep the test process alive.
    try {
      // A child process makes the first read of request.headers return an
      // object or an odd-length array, so the appended headers must go
      // through addHeader().
      for (const shape of ['object', 'odd']) {
        const { code, stdout, stderr } = await spawnMicrotel([
          fixture('undici-headers-fallback-child.js'),
          JSON.stringify({
            endpoint: `http://127.0.0.1:${collector.port}`,
            filter: 'node:undici',
          }),
          shape,
        ]);

        // The assertions on the child's exit come first: a child that dies
        // before its export never delivers a payload, and awaiting the
        // collector up front would hang the suite on it.
        assert.strictEqual(code, 0, shape);
        assert.strictEqual(stderr, '', shape);
        const [traceparent] = stdout.trim().split('\n');
        assert.match(
          traceparent,
          /^00-[0-9a-f]{32}-[0-9a-f]{16}-0[23]$/,
          `addHeader must land a valid traceparent on the wire (${shape})`,
        );

        // The child has exited, so the export its flush started has
        // completed.
        const spans = getSpans(await collector.next());
        assert.ok(getClientSpan(spans, '/down'), shape);
      }
    } finally {
      await collector.close();
    }
  });

  it('parents fetch spans to the server span in the same trace', async () => {
    const incomingTraceId = 'a'.repeat(32);

    const fetchTarget = await startHTTPServer();
    // A fetch made while handling a traced request.
    const frontend = await startHTTPServer((req, res) => {
      fetch(`http://127.0.0.1:${fetchTarget.port}/down`).then((fr) => {
        fr.text().then(() => {
          res.writeHead(200);
          res.end('ok');
        });
      });
    });

    await rawRequest(frontend.port, '/up', {
      traceparent: `00-${incomingTraceId}-0123456789abcdef-01`,
    });

    const spans = await flushAndCollect(collector);
    await closeAll(fetchTarget, frontend);

    // The full chain, asserted on the exported spans: the server span
    // parents the fetch client span, and the fetch span parents the
    // downstream server span, all in the incoming trace.
    const serverSpan = getServerSpan(spans, '/up');
    const fetchSpan = getClientSpan(spans, '/down');
    const downstreamSpan = getServerSpan(spans, '/down');
    assert.ok(serverSpan, 'Expected a server span for the inbound request');
    assert.ok(fetchSpan, 'Expected a client span for the fetch');
    assert.ok(downstreamSpan, 'Expected a server span downstream of the fetch');

    assert.strictEqual(serverSpan.traceId, incomingTraceId);
    assert.strictEqual(fetchSpan.traceId, incomingTraceId);
    assert.strictEqual(fetchSpan.parentSpanId, serverSpan.spanId);
    assert.strictEqual(downstreamSpan.traceId, incomingTraceId);
    assert.strictEqual(downstreamSpan.parentSpanId, fetchSpan.spanId);
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
