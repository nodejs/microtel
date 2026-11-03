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
  rawRequest,
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
      'server.address': '127.0.0.1',
      'url.path': '/test-path',
      'http.response.status_code': '200',
    });
  });

  it('sets the peer, client, and user agent attributes without proxy headers', async () => {
    const app = await startHTTPServer();

    await rawRequest(app.port, '/direct', {
      'User-Agent': 'microtel-test/1',
    });

    const spans = await flushAndCollect(collector);

    await app.close();

    const serverSpan = getServerSpan(spans, '/direct');
    assert.ok(serverSpan, 'Expected a server span');

    // With no proxy headers the client is the immediate peer, and the
    // Host header carries the port.
    assert.partialDeepStrictEqual(spanAttrs(serverSpan), {
      'client.address': '127.0.0.1',
      'network.peer.address': '127.0.0.1',
      'server.address': '127.0.0.1',
      'server.port': String(app.port),
      'user_agent.original': 'microtel-test/1',
    });

    // network.peer.port is an int, not a string.
    const peerPort = serverSpan.attributes.find(
      (a) => a.key === 'network.peer.port',
    );
    assert.match(peerPort.value.intValue, /^\d+$/);
  });

  it('reads the Forwarded header', async () => {
    const app = await startHTTPServer();

    // Each request exercises one shape of the header: quoted values
    // carry IPv6 and ports, the first element with a for or host
    // parameter wins, and the proto parameter fills the default port.
    const cases = [
      [
        '/forwarded',
        { Forwarded: 'for="[2001:db8::1]:4711";host="example.com:8080"' },
        {
          'client.address': '2001:db8::1',
          'server.address': 'example.com',
          'server.port': '8080',
        },
      ],
      [
        '/forwarded-list',
        {
          Forwarded: 'for=192.0.2.60, for=198.51.100.17;host=example.org',
        },
        {
          'client.address': '192.0.2.60',
          'server.address': 'example.org',
        },
      ],
      [
        '/forwarded-proto',
        { Forwarded: 'for=192.0.2.60;host=example.com;proto=https' },
        {
          'client.address': '192.0.2.60',
          'server.address': 'example.com',
          'server.port': '443',
        },
      ],
      // A port requires quotes, so an unquoted host makes the whole
      // header malformed and the headers below it apply.
      [
        '/forwarded-invalid',
        {
          Forwarded: 'host=example.com:8080',
          'X-Forwarded-Host': 'fallback.example',
        },
        { 'server.address': 'fallback.example' },
      ],
    ];

    for (const [path, headers] of cases)
      await rawRequest(app.port, path, headers);

    const spans = await flushAndCollect(collector);

    await app.close();

    for (const [path, , expected] of cases) {
      const serverSpan = getServerSpan(spans, path);
      assert.ok(serverSpan, `Expected a server span for ${path}`);
      assert.partialDeepStrictEqual(spanAttrs(serverSpan), expected);
    }

    // The host parameter carries no port and no proto applies, so
    // server.port is not set.
    const listAttrs = spanAttrs(getServerSpan(spans, '/forwarded-list'));
    assert.strictEqual(listAttrs['server.port'], undefined);
  });

  it('reads X-Forwarded-For and X-Forwarded-Host', async () => {
    const app = await startHTTPServer();

    await rawRequest(app.port, '/x-forwarded', {
      'X-Forwarded-For': '[2001:db8::1]:4711, 198.51.100.17',
      'X-Forwarded-Host': 'proxy.example.com:9090',
    });
    // X-Forwarded-Proto fills the default port when the host has none.
    await rawRequest(app.port, '/x-forwarded-proto', {
      'X-Forwarded-Host': 'proxy.example.com',
      'X-Forwarded-Proto': 'https',
    });
    await rawRequest(app.port, '/x-forwarded-host', {
      'X-Forwarded-Host': 'proxy.example.com',
    });
    // Proxies append to these headers, so the first entry is the original,
    // and a scheme matches in any letter case.
    await rawRequest(app.port, '/x-forwarded-lists', {
      'X-Forwarded-Host': 'public.example, proxy.example',
      'X-Forwarded-Proto': 'HTTPS, http',
      'X-Forwarded-For': ', 198.51.100.17',
    });
    await rawRequest(app.port, '/forwarded-proto-case', {
      Forwarded: 'host=public.example;proto=HTTPS',
    });
    // A for value that is not a canonical IPv4 address goes through the
    // URL unchanged: a port outside the TCP range or an octet above 255
    // is rejected there, and a leading zero means octal, so 010.1.2.3
    // is 8.1.2.3.
    for (const [path, first] of [
      ['/xff-port-range', '1.2.3.4:65536, 5.6.7.8'],
      ['/xff-octet-range', '999.1.2.3:80, 5.6.7.8'],
      ['/xff-octal', '010.1.2.3, 5.6.7.8'],
      ['/xff-port-leading-zero', '1.2.3.4:04711, 5.6.7.8'],
    ])
      await rawRequest(app.port, path, { 'X-Forwarded-For': first });
    // A port outside the TCP range came from a broken header.
    for (const port of ['65536', '9007199254740993', '9'.repeat(400)])
      await rawRequest(app.port, `/bad-port-${port.length}`, {
        'X-Forwarded-Host': `example.com:${port}`,
      });

    const spans = await flushAndCollect(collector);

    await app.close();

    const forwarded = spanAttrs(getServerSpan(spans, '/x-forwarded'));
    assert.ok(forwarded, 'Expected a server span for /x-forwarded');
    assert.partialDeepStrictEqual(forwarded, {
      'client.address': '2001:db8::1',
      'server.address': 'proxy.example.com',
      'server.port': '9090',
    });

    const proto = spanAttrs(getServerSpan(spans, '/x-forwarded-proto'));
    assert.ok(proto, 'Expected a server span for /x-forwarded-proto');
    assert.partialDeepStrictEqual(proto, {
      'server.address': 'proxy.example.com',
      'server.port': '443',
    });

    // Without X-Forwarded-Proto there is no default port, not even from
    // the request scheme.
    const host = spanAttrs(getServerSpan(spans, '/x-forwarded-host'));
    assert.ok(host, 'Expected a server span for /x-forwarded-host');
    assert.strictEqual(host['server.address'], 'proxy.example.com');
    assert.strictEqual(host['server.port'], undefined);

    // An empty first X-Forwarded-For entry is absent, so client.address
    // falls back to the peer.
    assert.partialDeepStrictEqual(
      spanAttrs(getServerSpan(spans, '/x-forwarded-lists')),
      {
        'server.address': 'public.example',
        'server.port': '443',
        'client.address': '127.0.0.1',
      },
    );
    assert.partialDeepStrictEqual(
      spanAttrs(getServerSpan(spans, '/forwarded-proto-case')),
      { 'server.address': 'public.example', 'server.port': '443' },
    );
    for (const length of [5, 16, 400]) {
      const attrs = spanAttrs(getServerSpan(spans, `/bad-port-${length}`));
      assert.strictEqual(attrs['server.address'], 'example.com', `${length}`);
      assert.strictEqual(attrs['server.port'], undefined, `${length}`);
    }

    // A for value the URL rejects or rewrites is kept or rewritten whole.
    assert.strictEqual(
      spanAttrs(getServerSpan(spans, '/xff-port-range'))['client.address'],
      '1.2.3.4:65536',
    );
    assert.strictEqual(
      spanAttrs(getServerSpan(spans, '/xff-octet-range'))['client.address'],
      '999.1.2.3:80',
    );
    assert.strictEqual(
      spanAttrs(getServerSpan(spans, '/xff-octal'))['client.address'],
      '8.1.2.3',
    );
    assert.strictEqual(
      spanAttrs(getServerSpan(spans, '/xff-port-leading-zero'))[
        'client.address'
      ],
      '1.2.3.4',
    );
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
