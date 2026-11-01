'use strict';

const assert = require('node:assert');
const http2 = require('node:http2');
const { after, before, describe, it } = require('node:test');
const {
  startTracing,
  startHTTPServer,
  flushAndCollect,
  getClientSpan,
  getServerSpan,
  spanAttrs,
  closeAll,
} = require('./common/otel');

// Starts a plain HTTP/2 server for traced requests. The handler receives
// (stream, headers). Exposes port and close().
async function startHTTP2Server(
  handler = (stream) => {
    stream.respond({ ':status': 200 });
    stream.end('ok');
  },
) {
  const server = http2.createServer();
  server.on('stream', handler);

  // server.close() waits for open sessions, so they are closed first;
  // a lingering client session would otherwise hang the close.
  const sessions = new Set();
  server.on('session', (session) => {
    sessions.add(session);
    session.on('close', () => sessions.delete(session));
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  return {
    port: server.address().port,
    close: () =>
      new Promise((resolve) => {
        for (const session of sessions) session.close();
        server.close(() => resolve());
      }),
  };
}

// Makes one traced HTTP/2 request and waits for the response body to end.
// extraHeaders are merged into the request headers, which is how tests
// supply a caller-written traceparent.
function h2Get(port, path, extraHeaders = { __proto__: null }) {
  return new Promise((resolve, reject) => {
    const session = http2.connect(`http://127.0.0.1:${port}`);
    session.on('error', reject);
    const stream = session.request({ ':path': path, ...extraHeaders });
    stream.setEncoding('utf8');
    let body = '';
    stream.on('data', (chunk) => {
      body += chunk;
    });
    stream.on('end', () => {
      session.close();
      resolve(body);
    });
    stream.on('error', reject);
  });
}

describe('otel HTTP/2 server spans', () => {
  let collector;

  before(async () => {
    collector = await startTracing();
  });

  after(() => collector.close());

  it('creates server spans for incoming HTTP/2 requests', async () => {
    const target = await startHTTP2Server();

    await h2Get(target.port, '/h2-path?a=1&b=2');

    const spans = await flushAndCollect(collector);

    await target.close();

    // HTTP/2 client requests are not instrumented, so the server span is
    // the only one this request can produce.
    assert.strictEqual(
      spans.length,
      1,
      `Expected exactly one span in: ${JSON.stringify(spans)}`,
    );

    const serverSpan = spans[0];
    assert.strictEqual(serverSpan.kind, 2); // SPAN_KIND_SERVER
    assert.strictEqual(serverSpan.name, 'GET');

    assert.ok(serverSpan.traceId);
    assert.strictEqual(serverSpan.traceId.length, 32);
    assert.ok(serverSpan.spanId);
    assert.strictEqual(serverSpan.spanId.length, 16);
    assert.ok(serverSpan.startTimeUnixNano);
    assert.ok(serverSpan.endTimeUnixNano);

    assert.partialDeepStrictEqual(spanAttrs(serverSpan), {
      'http.request.method': 'GET',
      'url.path': '/h2-path',
      'url.query': 'a=1&b=2',
      'url.scheme': 'http',
      'network.protocol.version': '2.0',
      'http.response.status_code': '200',
      'server.address': '127.0.0.1',
    });
  });

  it('reads the status code when respond() takes an array of headers', async () => {
    const target = await startHTTP2Server((stream, headers) => {
      const status = headers[':path'] === '/boom' ? 500 : 404;
      stream.respond([':status', status]);
      stream.end('body');
    });

    await h2Get(target.port, '/boom');
    await h2Get(target.port, '/ok');

    const spans = await flushAndCollect(collector);
    await target.close();

    const boomSpan = getServerSpan(spans, '/boom');
    assert.ok(boomSpan, 'Expected a server span for /boom');
    assert.strictEqual(spanAttrs(boomSpan)['http.response.status_code'], '500');
    assert.ok(boomSpan.status, 'Expected error status on the 5xx');
    assert.strictEqual(boomSpan.status.code, 2);

    const okSpan = getServerSpan(spans, '/ok');
    assert.ok(okSpan, 'Expected a server span for /ok');
    assert.strictEqual(spanAttrs(okSpan)['http.response.status_code'], '404');
    assert.strictEqual(okSpan.status, undefined);
  });

  it('parents fetch spans to the HTTP/2 server span in the same trace', async () => {
    const traceId = '0123456789abcdef0123456789abcdef';

    const fetchTarget = await startHTTPServer();
    // A fetch made while handling a traced HTTP/2 request.
    const h2Server = await startHTTP2Server((stream, headers) => {
      fetch(`http://127.0.0.1:${fetchTarget.port}/down`)
        .then((res) => res.text())
        .then(() => {
          stream.respond({ ':status': 200 });
          stream.end('ok');
        })
        .catch(() => stream.close());
    });

    await h2Get(h2Server.port, '/up', {
      traceparent: `00-${traceId}-0123456789abcdef-01`,
    });

    const spans = await flushAndCollect(collector);
    await fetchTarget.close();
    await h2Server.close();

    // The full chain, asserted on the exported spans: the HTTP/2 server
    // span parents the fetch client span, and the fetch span parents the
    // downstream server span, all in the incoming trace.
    const serverSpan = getServerSpan(spans, '/up');
    const fetchSpan = getClientSpan(spans, '/down');
    const downstreamSpan = getServerSpan(spans, '/down');
    assert.ok(serverSpan, 'Expected an HTTP/2 server span');
    assert.ok(fetchSpan, 'Expected a client span for the fetch');
    assert.ok(downstreamSpan, 'Expected a server span downstream');

    assert.strictEqual(serverSpan.traceId, traceId);
    assert.strictEqual(fetchSpan.traceId, traceId);
    assert.strictEqual(fetchSpan.parentSpanId, serverSpan.spanId);
    assert.strictEqual(downstreamSpan.traceId, traceId);
    assert.strictEqual(downstreamSpan.parentSpanId, fetchSpan.spanId);
  });

  it('parents the server span to an inbound traceparent', async () => {
    const traceId = '0123456789abcdef0123456789abcdef';
    const parentSpanId = '0123456789abcdef';

    const target = await startHTTP2Server();

    await h2Get(target.port, '/parented', {
      traceparent: `00-${traceId}-${parentSpanId}-01`,
      tracestate: 'vendor=state',
    });

    const spans = await flushAndCollect(collector);

    await target.close();

    const serverSpan = getServerSpan(spans, '/parented');
    assert.ok(serverSpan, 'Expected a server span');
    assert.strictEqual(serverSpan.traceId, traceId);
    assert.strictEqual(serverSpan.parentSpanId, parentSpanId);
    assert.notStrictEqual(serverSpan.spanId, parentSpanId);
  });

  it('starts a fresh trace without traceparent and rejects invalid ones', async () => {
    const target = await startHTTP2Server();

    await h2Get(target.port, '/fresh');
    await h2Get(target.port, '/invalid', {
      // Version ff is not defined by the W3C spec and must be rejected.
      traceparent: `ff-${'0'.repeat(32)}-${'0'.repeat(16)}-01`,
    });

    const spans = await flushAndCollect(collector);

    await target.close();

    for (const path of ['/fresh', '/invalid']) {
      const serverSpan = getServerSpan(spans, path);
      assert.ok(serverSpan, `Expected a server span for ${path}`);
      assert.strictEqual(
        serverSpan.parentSpanId,
        undefined,
        `${path} must not have a remote parent`,
      );
      assert.match(serverSpan.traceId, /^[0-9a-f]{32}$/);
    }

    // Both requests must start independent traces.
    const fresh = getServerSpan(spans, '/fresh');
    const invalid = getServerSpan(spans, '/invalid');
    assert.notStrictEqual(fresh.traceId, invalid.traceId);
  });

  // Per the W3C Baggage spec, baggage propagates independently of
  // traceparent, so it is forwarded whether or not one arrives with it.
  for (const traceparent of [
    '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01',
    undefined,
  ]) {
    it(`forwards inbound baggage ${traceparent ? 'with' : 'without'} a traceparent`, async () => {
      // Baggage is forwarded verbatim, so nothing here may be parsed,
      // trimmed, or reordered.
      const baggage = 'key1=value1,key2=value2, unpacked = value3';
      let forwarded = 'sentinel';

      const backend = await startHTTPServer((req, res) => {
        forwarded = req.headers.baggage;
        res.end('ok');
      });
      const h2Server = await startHTTP2Server((stream) => {
        fetch(`http://127.0.0.1:${backend.port}/down`)
          .then((res) => res.text())
          .then(() => {
            stream.respond({ ':status': 200 });
            stream.end('ok');
          })
          .catch(() => stream.close());
      });

      await h2Get(
        h2Server.port,
        '/up',
        traceparent ? { traceparent, baggage } : { baggage },
      );
      await flushAndCollect(collector);
      await backend.close();
      await h2Server.close();

      assert.strictEqual(forwarded, baggage);
    });
  }

  it('forwards the trace flags of an inbound traceparent unchanged', async () => {
    const traceId = '0123456789abcdef0123456789abcdef';
    const forwarded = {};
    const backend = await startHTTPServer((req, res) => {
      forwarded[req.url] = req.headers.traceparent;
      res.end('ok');
    });
    const h2Server = await startHTTP2Server((stream, headers) => {
      fetch(`http://127.0.0.1:${backend.port}${headers[':path']}`)
        .then((res) => res.text())
        .then(() => {
          stream.respond({ ':status': 200 });
          stream.end('ok');
        })
        .catch(() => stream.close());
    });

    // Trace Context Level 2's random flag, with and without the sampled
    // flag. The sampled trace also makes sure there is an export to wait
    // for.
    for (const flags of ['02', '03']) {
      await h2Get(h2Server.port, `/flags-${flags}`, {
        traceparent: `00-${traceId}-0123456789abcdef-${flags}`,
      });
    }
    await flushAndCollect(collector);
    await backend.close();
    await h2Server.close();

    for (const flags of ['02', '03']) {
      assert.match(
        forwarded[`/flags-${flags}`],
        RegExp(`^00-${traceId}-[0-9a-f]{16}-${flags}$`),
      );
    }
  });

  // Per OTel semantic conventions, server spans set STATUS_ERROR only for
  // >= 500; 4xx is the caller's mistake, not the server's.
  it('marks 5xx responses as errors but not 4xx', async () => {
    const target = await startHTTP2Server((stream, headers) => {
      const status = headers[':path'] === '/boom' ? 500 : 404;
      stream.respond({ ':status': status });
      stream.end('body');
    });

    await h2Get(target.port, '/boom');
    await h2Get(target.port, '/missing');

    const spans = await flushAndCollect(collector);

    await target.close();

    const errorSpan = getServerSpan(spans, '/boom');
    assert.ok(errorSpan, 'Expected a server span');
    assert.strictEqual(errorSpan.status.code, 2); // STATUS_ERROR
    assert.strictEqual(errorSpan.status.message, 'HTTP 500');
    assert.strictEqual(spanAttrs(errorSpan)['error.type'], '500');

    const notFoundSpan = getServerSpan(spans, '/missing');
    assert.ok(notFoundSpan, 'Expected a server span');
    assert.strictEqual(notFoundSpan.status, undefined);
    assert.strictEqual(spanAttrs(notFoundSpan)['error.type'], undefined);
  });

  it('ends an aborted stream with error status', async () => {
    const target = await startHTTP2Server((stream) => {
      // Never responds: the client resets the stream instead.
      stream.resume();
    });

    await new Promise((resolve) => {
      const session = http2.connect(`http://127.0.0.1:${target.port}`);
      session.on('error', () => {});
      const stream = session.request({ ':path': '/aborted' });
      stream.on('error', () => {});
      // HEADERS then RST_STREAM are queued in order, so the server sees
      // the request before the reset arrives.
      stream.close(http2.constants.NGHTTP2_CANCEL);
      setTimeout(() => {
        session.close();
        resolve();
      }, 50);
    });

    const spans = await flushAndCollect(collector);

    await target.close();

    const abortedSpan = getServerSpan(spans, '/aborted');
    assert.ok(abortedSpan, 'Expected a server span');
    assert.ok(abortedSpan.status, 'Aborted span should have error status');
    assert.strictEqual(abortedSpan.status.code, 2); // STATUS_ERROR
    assert.strictEqual(
      spanAttrs(abortedSpan)['http.response.status_code'],
      undefined,
      'No response was sent, so no status code',
    );
  });
});
