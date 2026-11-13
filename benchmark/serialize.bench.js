'use strict';

const { before, bench } = require('node:bench');
const microtel = require('../index');
const { resetCaches } = require('../lib/flush');
const { generateSpanId, generateTraceId } = require('../lib/id');
const { serializeSpans } = require('../lib/serialize');
const {
  Span,
  SPAN_KIND_CLIENT,
  SPAN_KIND_SERVER,
  STATUS_ERROR,
} = require('../lib/span');

// An export sends whatever is buffered when the flush timer fires, or
// maxBufferSize spans once the buffer fills:
// - 2: one request's spans, when traffic is low enough that the timer
//   flushes after every request.
// - 20: several requests between timer flushes.
// - 100: the default maxBufferSize, the batch every busy process sends.
// - 512: the batching processor's maxExportBatchSize, for a process that
//   raises maxBufferSize to match it. "The default value is `512`."
//   https://opentelemetry.io/docs/specs/otel/trace/sdk/#batching-processor
// - 1024 and 2048: larger batches, for reference.
const kBatchSizes = [2, 20, 100, 512, 1024, 2048];
const kMaxBatchSize = Math.max(...kBatchSizes);

// Adds 2 spans, a server span, and a client span made while handling it.
// The values that vary per request in a real process vary here too.
function addRequestSpans(spans, i, error) {
  const server = new Span('GET', SPAN_KIND_SERVER, {
    parent: Span.fromTraceparent(
      `00-${generateTraceId()}-${generateSpanId()}-01`,
    ),
  });
  server.setAttribute('http.request.method', 'GET');
  server.setAttribute('url.path', `/api/users/${1000 + i}/orders`);
  server.setAttribute('url.query', `page=${i % 7}&limit=50`);
  server.setAttribute('url.scheme', 'http');
  server.setAttribute('network.protocol.version', '1.1');
  server.setAttribute('server.address', 'api.example.com');
  server.setAttribute('server.port', 8080);
  server.setAttribute('client.address', `10.0.${i % 16}.${i % 251}`);
  server.setAttribute('network.peer.address', `10.0.${i % 16}.${i % 251}`);
  server.setAttribute('network.peer.port', 32768 + i);
  server.setAttribute('user_agent.original', 'Mozilla/5.0 (X11; Linux x86_64)');

  const client = new Span('GET', SPAN_KIND_CLIENT, { parent: server });
  client.setAttribute('http.request.method', 'GET');
  client.setAttribute('server.address', 'orders.internal');
  client.setAttribute('server.port', 80);
  client.setAttribute(
    'url.full',
    `http://orders.internal/orders?user=${1000 + i}`,
  );
  client.setAttribute('network.protocol.version', '1.1');

  if (error == null) {
    client.setAttribute('http.response.status_code', 200);
    client.end();
    server.setAttribute('http.response.status_code', 200);
  } else {
    // What the client error handler records.
    client.setAttribute('error.type', error.name);
    client.setStatus(STATUS_ERROR, error.message);
    client.addEvent('exception', {
      'exception.type': error.name,
      'exception.message': error.message,
      'exception.stacktrace': error.stack,
    });
    client.end();
    server.setAttribute('http.response.status_code', 502);
    server.setStatus(STATUS_ERROR, 'HTTP 502');
    server.setAttribute('error.type', '502');
  }
  server.end();
  spans.push(server, client);
}

const typical = [];
const failed = [];

before(() => {
  // Sets the resource attributes the payload carries.
  microtel.init();
  // Exception messages and stack traces are where non-ASCII text, such as
  // a localized message or a non-ASCII file path, usually reaches a span.
  const error = new Error('connect ECONNREFUSED: 接続が拒否されました');
  // Each call adds a request's 2 spans.
  for (let i = 0; i < kMaxBatchSize / 2; i++) {
    addRequestSpans(typical, i);
    addRequestSpans(failed, i, error);
  }
  // Drops the spans end() buffered, so they are never exported.
  resetCaches();
});

const onFailure = (message) => {
  throw new Error(message);
};

// Splits the spans into consecutive batches, so every batch size covers
// all the spans.
function toBatches(spans, batchSize) {
  const batches = [];
  for (let i = 0; i + batchSize <= spans.length; i += batchSize) {
    batches.push(spans.slice(i, i + batchSize));
  }
  return batches;
}

// Each sample serializes every batch once, about kMaxBatchSize spans
// whatever the batch size, so the per-span rates are comparable.
function registerSerializeBenchmark(name, spans) {
  for (const batchSize of kBatchSizes) {
    bench(name, { samples: 30, params: { batchSize } }, (b) => {
      const batches = toBatches(spans, batchSize);
      let bytes = 0;
      b.start();
      for (const batch of batches) {
        bytes += serializeSpans(batch, onFailure).length;
      }
      b.end(batches.length * batchSize);
      if (bytes === 0) throw new Error('nothing serialized');
    });
  }
}

registerSerializeBenchmark('serialize http spans', typical);
registerSerializeBenchmark('serialize failed http spans', failed);
