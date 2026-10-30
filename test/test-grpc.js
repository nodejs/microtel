'use strict';

const assert = require('node:assert/strict');
const http2 = require('node:http2');
const { test } = require('node:test');

async function collector(t, handler, options) {
  const server = options
    ? http2.createSecureServer(options)
    : http2.createServer();
  server.on('stream', (stream, headers) => {
    stream.on('error', () => {});
    stream.resume();
    stream.on('end', () => handler(stream, headers));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `${options ? 'https' : 'http'}://localhost:${server.address().port}`;
}
function respond(stream, body = Buffer.from([0, 0, 0, 0, 0]), status = '0') {
  stream.respond(
    { ':status': 200, 'content-type': 'application/grpc' },
    { waitForTrailers: true },
  );
  stream.on('wantTrailers', () =>
    stream.sendTrailers({ 'grpc-status': status }),
  );
  // Deliberately split inside the gRPC prefix.
  stream.write(body.subarray(0, 2));
  stream.end(body.subarray(2));
}
function exporter(t, url, timeout = 500) {
  const { GrpcExporter } = require('../lib/grpc');
  const client = new GrpcExporter(new URL(url), timeout);
  t.after(() => client.close());
  return client;
}
const empty = Buffer.from([0, 0, 0, 0, 0]);

test('unary gRPC uses the OTLP path, required headers and reuses its session', async (t) => {
  let calls = 0;
  const url = await collector(t, (stream, headers) => {
    calls++;
    assert.equal(
      headers[':path'],
      '/opentelemetry.proto.collector.trace.v1.TraceService/Export',
    );
    assert.equal(headers[':method'], 'POST');
    assert.equal(headers.te, 'trailers');
    assert.equal(headers['content-type'], 'application/grpc+proto');
    assert.match(headers['grpc-timeout'], /^\d+m$/);
    respond(stream);
  });
  const client = exporter(t, url);
  const first = await client.send(empty);
  assert.equal(first.rejectedSpans, 0n);
  await client.send(empty);
  assert.equal(calls, 2);
});

for (const [name, handler, pattern] of [
  [
    'trailers-only error',
    (s) =>
      s.respond(
        {
          ':status': 200,
          'content-type': 'application/grpc',
          'grpc-status': '7',
          'grpc-message': 'access%20denied',
        },
        { endStream: true },
      ),
    /7.*access denied/,
  ],
  [
    'missing status',
    (s) => {
      s.respond({ ':status': 200, 'content-type': 'application/grpc' });
      s.end(empty);
    },
    /status/,
  ],
  [
    'HTTP error',
    (s) => {
      s.respond({ ':status': 503 });
      s.end();
    },
    /503/,
  ],
  [
    'wrong content type',
    (s) => {
      s.respond({ ':status': 200, 'content-type': 'text/html' });
      s.end();
    },
    /content.type/,
  ],
  ['compression', (s) => respond(s, Buffer.from([1, 0, 0, 0, 0])), /compress/],
  [
    'truncated message',
    (s) => respond(s, Buffer.from([0, 0, 0, 0, 1])),
    /framing/,
  ],
  [
    'multiple messages',
    (s) => respond(s, Buffer.concat([empty, empty])),
    /framing/,
  ],
  ['oversized response', (s) => respond(s, Buffer.alloc(65542)), /size/],
  [
    'stream reset',
    (s) => s.close(http2.constants.NGHTTP2_INTERNAL_ERROR),
    /stream|closed/,
  ],
  ['deadline', () => {}, /timeout/],
]) {
  test(`gRPC rejects ${name}`, async (t) => {
    const url = await collector(t, handler);
    await assert.rejects(exporter(t, url, 100).send(empty), pattern);
  });
}

test('gRPC decodes partial success', async (t) => {
  const url = await collector(t, (s) =>
    respond(s, Buffer.from([0, 0, 0, 0, 9, 10, 7, 8, 2, 18, 3, 98, 97, 100])),
  );
  assert.deepEqual(await exporter(t, url).send(empty), {
    rejectedSpans: 2n,
    errorMessage: 'bad',
  });
});

test('queued exports share an absolute deadline and bounded byte budget', async (t) => {
  const url = await collector(t, () => {});
  const client = exporter(t, url, 100);
  const first = assert.rejects(client.send(empty), /timeout/);
  const queued = assert.rejects(client.send(empty), /timeout/);
  await assert.rejects(client.send(Buffer.alloc(16 * 1024 * 1024)), /queue/);
  await Promise.all([first, queued]);
});

test('gRPC drops expired queued batches before opening a stream', async (t) => {
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  let calls = 0;
  const url = await collector(t, (stream) => {
    calls++;
    // Advance past both deadlines before completing the active RPC,
    // without giving the queued batch's real timer a chance to run.
    if (calls === 1) now += 1000;
    respond(stream);
  });
  const client = exporter(t, url, 500);
  const active = client.send(empty);
  const expired = assert.rejects(client.send(empty), /export timeout/);
  await Promise.all([active, expired]);
  assert.equal(calls, 1, 'the expired batch must never reach the collector');

  // Discarding expired work must leave the exporter able to send new work.
  await client.send(empty);
  assert.equal(calls, 2);
});

test('gRPC reports connection failure without an unhandled error', async (t) => {
  await assert.rejects(
    exporter(t, 'http://127.0.0.1:1').send(empty),
    /connect|closed|ECONNREFUSED/,
  );
});

module.exports = { collector, respond };

test('gRPC replaces a session after GOAWAY', async (t) => {
  let calls = 0;
  const url = await collector(t, (s) => {
    calls++;
    if (calls === 1) s.session.goaway();
    respond(s);
  });
  const client = exporter(t, url);
  await client.send(empty);
  await client.send(empty);
  assert.equal(calls, 2);
});

test('gRPC reconnects after a session is destroyed', async (t) => {
  let calls = 0;
  const url = await collector(t, (s) => {
    calls++;
    if (calls === 1) s.session.destroy();
    else respond(s);
  });
  const client = exporter(t, url);
  await assert.rejects(client.send(empty), /status|session|stream|HTTP/);
  await client.send(empty);
  assert.equal(calls, 2);
});

test('closing the exporter settles active and queued work', async (t) => {
  const url = await collector(t, () => {});
  const client = exporter(t, url);
  const active = assert.rejects(client.send(empty), /closed/);
  const queued = assert.rejects(client.send(empty), /closed/);
  client.close();
  await Promise.all([active, queued]);
  await assert.rejects(client.send(empty), /closed/);
});

test('the gRPC queue bounds the number of pending exports as well as bytes', async (t) => {
  const url = await collector(t, () => {});
  const client = exporter(t, url);
  const pending = Array.from({ length: 100 }, () =>
    assert.rejects(client.send(empty), /closed/),
  );
  await assert.rejects(client.send(empty), /queue/);
  client.close();
  await Promise.all(pending);
});
