'use strict';

const assert = require('node:assert');
const { spawn } = require('node:child_process');
const { describe, it } = require('node:test');
const {
  MICROTEL_PATH,
  fixture,
  startOTelCollector,
  getSpans,
  spanAttrs,
  spawnMicrotel,
} = require('./common/otel');

// init() activates tracing once per process, so the activation tests run
// in child processes (fixtures from test/fixtures, configured through JSON
// on argv), while the validation tests run in-process: they throw before
// any state is mutated.

describe('otel init validation', () => {
  const microtel = require('..');

  it('throws on an invalid endpoint', () => {
    assert.throws(
      () => {
        microtel.init({ endpoint: 'not-a-valid-url' });
      },
      { code: 'ERR_INVALID_ARG_VALUE' },
    );
  });

  it('throws on an empty endpoint', () => {
    assert.throws(
      () => {
        microtel.init({ endpoint: '' });
      },
      { code: 'ERR_INVALID_ARG_VALUE' },
    );
  });

  it('throws on an invalid maxBufferSize', () => {
    assert.throws(
      () => {
        microtel.init({ endpoint: 'http://127.0.0.1:1', maxBufferSize: 0 });
      },
      { name: 'RangeError', code: 'ERR_OUT_OF_RANGE' },
    );
    assert.throws(
      () => {
        microtel.init({ endpoint: 'http://127.0.0.1:1', maxBufferSize: 'abc' });
      },
      { code: 'ERR_INVALID_ARG_TYPE' },
    );
  });

  it('throws on an invalid flushInterval', () => {
    assert.throws(
      () => {
        microtel.init({ endpoint: 'http://127.0.0.1:1', flushInterval: 0 });
      },
      { name: 'RangeError', code: 'ERR_OUT_OF_RANGE' },
    );
    assert.throws(
      () => {
        microtel.init({ endpoint: 'http://127.0.0.1:1', flushInterval: 'abc' });
      },
      { code: 'ERR_INVALID_ARG_TYPE' },
    );
  });

  it('throws on an invalid exportTimeout', () => {
    assert.throws(
      () => {
        microtel.init({ endpoint: 'http://127.0.0.1:1', exportTimeout: 0 });
      },
      { name: 'RangeError', code: 'ERR_OUT_OF_RANGE' },
    );
    assert.throws(
      () => {
        microtel.init({ endpoint: 'http://127.0.0.1:1', exportTimeout: 'abc' });
      },
      { code: 'ERR_INVALID_ARG_TYPE' },
    );
  });

  it('throws on an invalid filter type', () => {
    assert.throws(
      () => {
        microtel.init({ endpoint: 'http://127.0.0.1:1', filter: 42 });
      },
      { code: 'ERR_INVALID_ARG_TYPE' },
    );
  });

  it('throws on an unsupported endpoint protocol', () => {
    assert.throws(
      () => {
        microtel.init({ endpoint: 'ftp://collector.example.com' });
      },
      { code: 'ERR_INVALID_ARG_VALUE' },
    );
    // Nothing is mutated, so a corrected init() would still work.
    assert.strictEqual(microtel.isActive(), false);
  });

  it('throws on an empty serviceName', () => {
    assert.throws(
      () => {
        microtel.init({ endpoint: 'http://127.0.0.1:1', serviceName: '' });
      },
      { code: 'ERR_INVALID_ARG_VALUE' },
    );
  });

  it('throws on an empty sdkName', () => {
    assert.throws(
      () => {
        microtel.init({ endpoint: 'http://127.0.0.1:1', sdkName: '' });
      },
      { code: 'ERR_INVALID_ARG_VALUE' },
    );
  });

  it('throws on an empty sdkVersion', () => {
    assert.throws(
      () => {
        microtel.init({ endpoint: 'http://127.0.0.1:1', sdkVersion: '' });
      },
      { code: 'ERR_INVALID_ARG_VALUE' },
    );
  });
});

describe('otel init activation', () => {
  it('activates tracing with the default endpoint', async () => {
    const { code, stdout } = await spawnMicrotel([
      fixture('state-child.js'),
      JSON.stringify([{}]),
    ]);

    assert.strictEqual(code, 0);
    assert.match(stdout, /active:true/);
    assert.match(stdout, /endpoint:http:\/\/localhost:4318/);
  });

  it('accepts maxBufferSize and flushInterval', async () => {
    const { code, stdout } = await spawnMicrotel([
      fixture('state-child.js'),
      JSON.stringify([
        {
          endpoint: 'http://127.0.0.1:9999',
          maxBufferSize: 250,
          flushInterval: 2500,
        },
      ]),
    ]);

    assert.strictEqual(code, 0);
    assert.match(stdout, /active:true/);
  });

  it('filter limits instrumented modules', async () => {
    const { code, stdout } = await spawnMicrotel([
      fixture('state-child.js'),
      JSON.stringify([
        {
          endpoint: 'http://127.0.0.1:1',
          filter: 'node:http,node:net',
        },
      ]),
      'node:http,node:net,node:dns',
    ]);

    assert.strictEqual(code, 0);
    const lines = stdout.trim().split('\n');
    assert.match(
      lines.find((l) => l.startsWith('node:http:')),
      /node:http:true/,
    );
    assert.match(
      lines.find((l) => l.startsWith('node:net:')),
      /node:net:true/,
    );
    assert.match(
      lines.find((l) => l.startsWith('node:dns:')),
      /node:dns:false/,
    );
  });

  it('filter accepts node:fetch as an alias for undici', async () => {
    const { code, stdout } = await spawnMicrotel([
      fixture('state-child.js'),
      JSON.stringify([
        {
          endpoint: 'http://127.0.0.1:1',
          filter: 'node:fetch',
        },
      ]),
      'node:fetch,node:http',
    ]);

    assert.strictEqual(code, 0);
    const lines = stdout.trim().split('\n');
    assert.match(
      lines.find((l) => l.startsWith('node:fetch:')),
      /node:fetch:true/,
    );
    assert.match(
      lines.find((l) => l.startsWith('node:http:')),
      /node:http:false/,
    );
  });

  it('exclude disables modules without touching the rest', async () => {
    const { code, stdout } = await spawnMicrotel([
      fixture('state-child.js'),
      JSON.stringify([
        {
          endpoint: 'http://127.0.0.1:1',
          exclude: 'node:http',
        },
      ]),
      'node:http,node:net',
    ]);

    assert.strictEqual(code, 0);
    const lines = stdout.trim().split('\n');
    assert.match(
      lines.find((l) => l.startsWith('node:http:')),
      /node:http:false/,
    );
    assert.match(
      lines.find((l) => l.startsWith('node:net:')),
      /node:net:true/,
    );
  });

  it('exclude wins over filter', async () => {
    const { code, stdout } = await spawnMicrotel([
      fixture('state-child.js'),
      JSON.stringify([
        {
          endpoint: 'http://127.0.0.1:1',
          filter: 'node:http,node:net',
          exclude: 'node:http',
        },
      ]),
      'node:http,node:net',
    ]);

    assert.strictEqual(code, 0);
    const lines = stdout.trim().split('\n');
    assert.match(
      lines.find((l) => l.startsWith('node:http:')),
      /node:http:false/,
    );
    assert.match(
      lines.find((l) => l.startsWith('node:net:')),
      /node:net:true/,
    );
  });

  it('filter separates node:http client and server', async () => {
    const { code, stdout } = await spawnMicrotel([
      fixture('state-child.js'),
      JSON.stringify([
        {
          endpoint: 'http://127.0.0.1:1',
          filter: 'node:http/client',
        },
      ]),
      'node:http/client,node:http/server',
    ]);

    assert.strictEqual(code, 0);
    const lines = stdout.trim().split('\n');
    assert.match(
      lines.find((l) => l.startsWith('node:http/client:')),
      /node:http\/client:true/,
    );
    assert.match(
      lines.find((l) => l.startsWith('node:http/server:')),
      /node:http\/server:false/,
    );
  });

  it('node:http covers both client and server', async () => {
    const { code, stdout } = await spawnMicrotel([
      fixture('state-child.js'),
      JSON.stringify([
        {
          endpoint: 'http://127.0.0.1:1',
          filter: 'node:http',
        },
      ]),
      'node:http/client,node:http/server',
    ]);

    assert.strictEqual(code, 0);
    const lines = stdout.trim().split('\n');
    assert.match(
      lines.find((l) => l.startsWith('node:http/client:')),
      /node:http\/client:true/,
    );
    assert.match(
      lines.find((l) => l.startsWith('node:http/server:')),
      /node:http\/server:true/,
    );
  });

  it('excluding node:http disables both sides', async () => {
    const { code, stdout } = await spawnMicrotel([
      fixture('state-child.js'),
      JSON.stringify([
        {
          endpoint: 'http://127.0.0.1:1',
          exclude: 'node:http',
        },
      ]),
      'node:http/client,node:http/server',
    ]);

    assert.strictEqual(code, 0);
    const lines = stdout.trim().split('\n');
    assert.match(
      lines.find((l) => l.startsWith('node:http/client:')),
      /node:http\/client:false/,
    );
    assert.match(
      lines.find((l) => l.startsWith('node:http/server:')),
      /node:http\/server:false/,
    );
  });

  it('a second init() is a silent no-op', async () => {
    const { code, stdout, stderr } = await spawnMicrotel([
      fixture('state-child.js'),
      JSON.stringify([
        { endpoint: 'http://127.0.0.1:9999' },
        { endpoint: 'http://127.0.0.1:1' },
      ]),
    ]);

    assert.strictEqual(code, 0);
    assert.strictEqual(stderr, '');
    assert.match(stdout, /active:true/);
    assert.match(stdout, /endpoint:http:\/\/127\.0\.0\.1:9999/);
  });

  it('exports the default service name in resource attributes', async () => {
    const collector = await startOTelCollector();

    const { code, stdout } = await spawnMicrotel([
      fixture('traced-request-child.js'),
      JSON.stringify({ endpoint: `http://127.0.0.1:${collector.port}` }),
    ]);

    assert.strictEqual(code, 0);
    assert.match(stdout, /done/);

    const payload = await collector.next();
    await collector.close();

    // The SDK identity defaults to this package, not Node.js core.
    const { version } = require('../package.json');
    assert.partialDeepStrictEqual(
      spanAttrs(payload.resourceSpans[0].resource),
      {
        'service.name': 'unknown_service:node',
        'telemetry.sdk.name': 'microtel',
        'telemetry.sdk.version': version,
      },
    );
    assert.partialDeepStrictEqual(
      payload.resourceSpans[0].scopeSpans[0].scope,
      { name: 'microtel', version },
    );
  });

  it('exports a custom service name and SDK identity in resource attributes', async () => {
    const collector = await startOTelCollector();

    const { code, stdout } = await spawnMicrotel([
      fixture('traced-request-child.js'),
      JSON.stringify({
        endpoint: `http://127.0.0.1:${collector.port}`,
        serviceName: 'my-service',
        sdkName: 'my-sdk',
        sdkVersion: '9.9.9',
      }),
    ]);

    assert.strictEqual(code, 0);
    assert.match(stdout, /done/);

    const payload = await collector.next();
    await collector.close();

    assert.partialDeepStrictEqual(
      spanAttrs(payload.resourceSpans[0].resource),
      {
        'service.name': 'my-service',
        'telemetry.sdk.name': 'my-sdk',
        'telemetry.sdk.version': '9.9.9',
      },
    );
    assert.partialDeepStrictEqual(
      payload.resourceSpans[0].scopeSpans[0].scope,
      { name: 'my-sdk', version: '9.9.9' },
    );

    const spans = getSpans(payload);
    assert.ok(spans.length > 0, 'Expected at least one span');
  });

  it('appends /v1/traces to the endpoint path', async () => {
    const collector = await startOTelCollector();

    const { code, stdout } = await spawnMicrotel([
      fixture('traced-request-child.js'),
      JSON.stringify({ endpoint: `http://127.0.0.1:${collector.port}/base` }),
    ]);

    assert.strictEqual(code, 0);
    assert.match(stdout, /done/);

    await collector.next();
    assert.strictEqual(collector.requests[0].url, '/base/v1/traces');

    await collector.close();
  });

  it('uses the endpoint as is when it already ends with /v1/traces', async () => {
    const collector = await startOTelCollector();

    const { code, stdout } = await spawnMicrotel([
      fixture('traced-request-child.js'),
      JSON.stringify({
        endpoint: `http://127.0.0.1:${collector.port}/v1/traces`,
      }),
    ]);

    assert.strictEqual(code, 0);
    assert.match(stdout, /done/);

    await collector.next();
    assert.strictEqual(collector.requests[0].url, '/v1/traces');

    await collector.close();
  });

  it('flushes when the buffer fills, without waiting for exit', async () => {
    const collector = await startOTelCollector();

    // Each request produces a server and a client span, so a buffer size
    // of 10 flushes long before the child exits (it never exits on its
    // own; the parent kills it).
    const child = spawn(
      process.execPath,
      [
        fixture('buffer-fill-child.js'),
        JSON.stringify({
          endpoint: `http://127.0.0.1:${collector.port}`,
          maxBufferSize: 10,
        }),
      ],
      {
        stdio: 'pipe',
        env: { ...process.env, MICROTEL_PATH },
      },
    );

    // The payload must arrive while the child is still alive; if the child
    // exits first, the flush only happened at exit and the test fails.
    const spans = await Promise.race([
      collector.next().then(getSpans),
      new Promise((_, reject) => {
        child.on('exit', () => reject(new Error('child exited before flush')));
      }),
    ]);

    child.kill();
    await collector.close();

    assert.ok(spans.length > 0, 'Expected spans flushed by the full buffer');
  });
});
