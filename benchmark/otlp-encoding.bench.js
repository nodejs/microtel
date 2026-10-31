'use strict';

const assert = require('node:assert/strict');
const { bench, suite } = require('node:bench');
const { createInput } = require('./helpers/otlp');

suite('OTLP encoding', () => {
  for (const batchSize of [1, 100]) {
    for (const exceptions of [false, true]) {
      const { encoder, spans } = createInput(batchSize, exceptions);
      const iterations = 100000 / batchSize;
      const reference = encoder.encode(spans);
      const expected = reference.length + reference[reference.length - 1];
      bench(
        `OTLP encode / batch=${batchSize} / ${exceptions ? 'exception' : 'HTTP'}`,
        { samples: 30, warmup: 20, params: { batchSize, exceptions } },
        (b) => {
          let checksum = 0;
          b.start();
          for (let i = 0; i < iterations; i++) {
            const buffer = encoder.encode(spans);
            checksum += buffer.length + buffer[buffer.length - 1];
          }
          // One operation is a complete batch, including its sizing pass,
          // allocation, protobuf encoding and gRPC message prefix.
          b.end(iterations);
          assert.equal(checksum, iterations * expected);
        },
      );
    }
  }
});
