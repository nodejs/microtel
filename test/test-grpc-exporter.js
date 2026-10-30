'use strict';

const assert = require('node:assert/strict');
const http2 = require('node:http2');
const fs = require('node:fs');
const { test } = require('node:test');
const { fixture, spawnMicrotel } = require('./common/otel');

async function run(
  t,
  {
    secure = false,
    status = '0',
    partial = false,
    stall = false,
    options = {},
  } = {},
) {
  const server = secure
    ? http2.createSecureServer({
        key: fs.readFileSync(fixture('https-key.pem')),
        cert: fs.readFileSync(fixture('https-cert.pem')),
      })
    : http2.createServer();
  const payloads = [];
  const sessions = new Set();
  server.on('session', (s) => {
    sessions.add(s);
    s.on('close', () => sessions.delete(s));
  });
  t.after(() => {
    for (const s of sessions) s.destroy();
    server.close();
  });
  server.on('stream', (stream, headers) => {
    const chunks = [];
    stream.on('error', () => {});
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('end', () => {
      const body = Buffer.concat(chunks);
      assert.equal(body.readUInt32BE(1), body.length - 5);
      assert.equal(body[0], 0);
      payloads.push(body.subarray(5));
      assert.equal(
        headers[':path'],
        '/opentelemetry.proto.collector.trace.v1.TraceService/Export',
      );
      if (stall) return;
      stream.respond(
        { ':status': 200, 'content-type': 'application/grpc' },
        { waitForTrailers: true },
      );
      stream.on('wantTrailers', () =>
        stream.sendTrailers({ 'grpc-status': status }),
      );
      stream.end(
        partial
          ? Buffer.from([0, 0, 0, 0, 4, 10, 2, 8, 1])
          : Buffer.from([0, 0, 0, 0, 0]),
      );
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const result = await spawnMicrotel(
    [
      fixture('beforeexit-flush-child.js'),
      JSON.stringify({
        protocol: 'grpc',
        endpoint: `${secure ? 'https' : 'http'}://localhost:${server.address().port}`,
        ...options,
      }),
    ],
    secure ? { NODE_EXTRA_CA_CERTS: fixture('https-cert.pem') } : {},
    { timeout: 5000 },
  );
  return { ...result, payloads };
}

for (const secure of [false, true]) {
  test(`public init exports traced spans on beforeExit over ${secure ? 'TLS' : 'cleartext'} gRPC and exits`, async (t) => {
    const result = await run(t, { secure });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.equal(result.payloads.length, 1);
    assert.ok(result.payloads[0].length > 0);
    // These tests cover transport and lifecycle. Exact wire bytes are
    // checked independently by the protobufjs encoding tests.
  });
}
test('gRPC export reports partial rejection', async (t) => {
  const result = await run(t, { partial: true });
  assert.equal(result.code, 0);
  assert.match(result.stderr, /OTelExportWarning.*rejected 1 spans/);
});
test('gRPC export reports RPC failure', async (t) => {
  const result = await run(t, { status: '14' });
  assert.equal(result.code, 0);
  assert.match(result.stderr, /OTelExportWarning.*status 14/);
});
test('gRPC deadline allows process exit with an unresponsive collector', async (t) => {
  const result = await run(t, { stall: true, options: { exportTimeout: 100 } });
  assert.equal(result.code, 0);
  assert.match(result.stderr, /OTelExportWarning.*timeout/);
});
test('protocol validation occurs before activation', async () => {
  const result = await spawnMicrotel(
    [
      '-e',
      `
    const assert = require('node:assert/strict');
    const otel = require(process.env.MICROTEL_PATH);
    assert.throws(() => otel.init({ protocol: 'invalid' }), { code: 'ERR_INVALID_ARG_VALUE' });
    assert.throws(() => otel.init({ protocol: 'http/json' }), { code: 'ERR_INVALID_ARG_VALUE' });
    assert.throws(() => otel.init({ protocol: 1 }), { code: 'ERR_INVALID_ARG_TYPE' });
    assert.equal(otel.isActive(), false);
    otel.init({ protocol: 'grpc' });
    assert.equal(require(process.env.MICROTEL_PATH + '/lib/core').getExportUrl().href,
      'http://localhost:4317/opentelemetry.proto.collector.trace.v1.TraceService/Export');
  `,
    ],
    {},
    { timeout: 5000 },
  );
  assert.equal(result.code, 0, result.stderr);
});

test('an in-process gRPC collector is excluded from tracing', async () => {
  const result = await spawnMicrotel(
    [fixture('grpc-selftrace-child.js')],
    {},
    { timeout: 5000 },
  );
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, '');
});
