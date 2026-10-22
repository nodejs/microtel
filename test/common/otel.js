'use strict';

const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const { spawn } = require('node:child_process');

const microtel = require('../../lib/core');
const { flush } = require('../../lib/flush');

// Helpers for tests of the OpenTelemetry tracing subsystem. Tracing is
// activated directly in-process, or in a child process via
// require(process.env.MICROTEL_PATH) with a fixture from test/fixtures.

// The package root, handed to child processes so they can require the
// package without relying on module resolution.
const MICROTEL_PATH = path.join(__dirname, '..', '..');
const kFixturesDir = path.join(__dirname, '..', 'fixtures');

// Resolves the path of a fixture file by name, mirroring node core's
// test/common fixtures.path().
const fixture = (name) => path.join(kFixturesDir, name);

// Starts a local HTTP server acting as an OTLP/HTTP JSON collector.
// Exposes port, next() for the next payload, payloads, requests, and
// close().
async function startOTelCollector() {
  const requests = [];
  const payloads = [];
  const queue = [];
  let signal;
  let signalPromise = new Promise((resolve) => {
    signal = resolve;
  });

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      // The collector also serves plain requests (for example, requests
      // made to its authority but not its export path); only exports
      // carry a body.
      if (body === '') {
        res.writeHead(200);
        res.end();
        return;
      }
      requests.push({ url: req.url, headers: req.headers });
      const payload = JSON.parse(body);
      payloads.push(payload);
      queue.push(payload);
      res.writeHead(200);
      res.end();
      signal();
      signalPromise = new Promise((resolve) => {
        signal = resolve;
      });
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  return {
    port: server.address().port,
    async next() {
      while (queue.length === 0) await signalPromise;
      return queue.shift();
    },
    payloads,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

// Activates tracing (once per process) against a fresh collector and
// returns it. Extra options pass through to start().
async function startTracing(options) {
  const collector = await startOTelCollector();
  microtel.start({
    endpoint: `http://127.0.0.1:${collector.port}`,
    ...options,
  });
  return collector;
}

// Flushes the span buffer and resolves with the spans of the next export.
async function flushAndCollect(collector) {
  flush();
  return getSpans(await collector.next());
}

// Starts a plain HTTP server for traced requests. The default handler
// responds 200 OK. Exposes port and close().
async function startHTTPServer(
  handler = (req, res) => {
    res.writeHead(200);
    res.end('ok');
  },
) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  return {
    port: server.address().port,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

// Closes every handle in parallel.
const closeAll = (...closables) =>
  Promise.all(closables.filter(Boolean).map((c) => c.close()));

// Extracts the spans array from an OTLP payload.
const getSpans = (payload) => payload.resourceSpans[0].scopeSpans[0].spans;

// Finds the SERVER span for a request path (SERVER = 2 on the OTLP
// wire).
const getServerSpan = (spans, path) =>
  spans.find(
    (s) =>
      s.kind === 2 &&
      s.attributes?.some(
        (a) => a.key === 'url.path' && a.value.stringValue === path,
      ),
  );

// Finds the CLIENT span whose request URL contains urlPart (CLIENT = 3
// on the OTLP wire).
const getClientSpan = (spans, urlPart) =>
  spans.find(
    (s) =>
      s.kind === 3 &&
      s.attributes?.some(
        (a) => a.key === 'url.full' && a.value.stringValue.includes(urlPart),
      ),
  );

// Sends a raw HTTP request with the given headers, bypassing the HTTP
// client instrumentation (which would overwrite trace context headers).
function rawRequest(port, path, headers = {}) {
  const lines = Object.entries(headers).map(
    ([name, value]) => `${name}: ${value}`,
  );
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write(
        `GET ${path} HTTP/1.1\r\n` +
          `Host: 127.0.0.1:${port}\r\n` +
          `${lines.join('\r\n')}\r\n` +
          `Connection: close\r\n` +
          `\r\n`,
      );
      socket.on('data', () => {});
      socket.on('end', resolve);
    });
  });
}

// Makes one traced GET request against the given server and waits for
// the response to finish.
function httpGet(port, path) {
  return new Promise((resolve, reject) => {
    http
      .get(`http://127.0.0.1:${port}${path}`, (res) => {
        res.resume();
        res.on('end', resolve);
      })
      .on('error', reject);
  });
}

// Decodes an OTLP attributes array (span or resource attributes, which
// share the KeyValue shape) into a plain key/value object.
function spanAttrs(span) {
  const attrs = {};
  for (const a of span.attributes ?? []) {
    attrs[a.key] =
      a.value.stringValue || a.value.intValue || a.value.doubleValue;
  }
  return attrs;
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Spawns a process and resolves with { code, stdout, stderr } once it
// exits. A timed-out child resolves with code null.
function spawnPromisified(execPath, args, options = {}) {
  const { timeout, ...spawnOptions } = options;
  const child = spawn(execPath, args, {
    stdio: 'pipe',
    ...spawnOptions,
  });

  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });

  let timedOut = false;
  let timer;
  if (timeout != null) {
    timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeout);
  }

  return new Promise((resolve) => {
    child.on('exit', (code) => {
      if (timedOut) code = null;
      if (timer != null) clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

// Spawns a child with access to the package through MICROTEL_PATH.
// Child scripts usually run a fixture, which takes its configuration as
// JSON on argv.
const spawnMicrotel = (args, env = {}, options = {}) =>
  spawnPromisified(process.execPath, args, {
    env: { ...process.env, MICROTEL_PATH, ...env },
    ...options,
  });

module.exports = {
  MICROTEL_PATH,
  fixture,
  startOTelCollector,
  startTracing,
  flushAndCollect,
  startHTTPServer,
  closeAll,
  getSpans,
  getServerSpan,
  getClientSpan,
  rawRequest,
  httpGet,
  spanAttrs,
  delay,
  spawnMicrotel,
};
