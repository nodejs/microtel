'use strict';

const assert = require('node:assert/strict');
const http2 = require('node:http2');
const { before, after, bench, suite } = require('node:bench');
const { GrpcExporter } = require('../lib/grpc');
const { createInput } = require('./helpers/otlp');

const kSuccessResponse = Buffer.from([0, 0, 0, 0, 0]);
const kBatchesPerSample = 100;

suite('OTLP export', () => {
  let server;
  let exporter;
  let received = 0;

  before(async () => {
    // An in-process collector consumes the request and acknowledges it.
    // It does not decode protobuf or depend on an external Collector.
    server = http2.createServer();
    server.on('stream', (stream) => {
      stream.on('error', () => {});
      stream.resume();
      stream.on('end', () => {
        received++;
        stream.respond(
          { ':status': 200, 'content-type': 'application/grpc+proto' },
          { waitForTrailers: true },
        );
        stream.on('wantTrailers', () =>
          stream.sendTrailers({ 'grpc-status': '0' }),
        );
        stream.end(kSuccessResponse);
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    exporter = new GrpcExporter(
      new URL(`http://127.0.0.1:${server.address().port}`),
      10000,
    );
  });

  after(async () => {
    exporter?.close();
    if (server) await new Promise((resolve) => server.close(resolve));
  });

  for (const batchSize of [1, 100]) {
    for (const exceptions of [false, true]) {
      const { encoder, spans } = createInput(batchSize, exceptions);
      bench(
        `OTLP export / batch=${batchSize} / ${exceptions ? 'exception' : 'HTTP'}`,
        { samples: 30, warmup: 20, params: { batchSize, exceptions } },
        async (b) => {
          const before = received;
          let result;
          b.start();
          for (let i = 0; i < kBatchesPerSample; i++) {
            result = await exporter.send(encoder.encode(spans));
          }
          // One operation includes encoding and the complete local gRPC
          // round trip, through response decoding and final status handling.
          b.end(kBatchesPerSample);
          assert.equal(received - before, kBatchesPerSample);
          assert.equal(result.rejectedSpans, 0n);
          assert.equal(result.errorMessage, '');
        },
      );
    }
  }
});
