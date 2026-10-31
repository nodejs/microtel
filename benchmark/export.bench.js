'use strict';

const { after, before, bench } = require('node:bench');
const http = require('node:http');
const microtel = require('../index');
const { Span, SPAN_KIND_CLIENT } = require('../lib/span');

const kBatchesPerSample = 20;
const kSpansPerBatch = 100;
// A sample takes a few milliseconds. Failed exports only warn, so a lost
// batch would otherwise leave the sample waiting forever.
const kSampleTimeoutMs = 5000;

let collector;
let received = 0;
let onReceived = () => {};

before(async () => {
  collector = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.end();
      received++;
      onReceived();
    });
  });
  await new Promise((resolve) => collector.listen(0, '127.0.0.1', resolve));
  microtel.init({
    endpoint: `http://127.0.0.1:${collector.address().port}`,
    // Each batch is flushed by hand, so the buffer never fills on its own.
    maxBufferSize: kSpansPerBatch + 1,
  });
});

after(() => new Promise((resolve) => collector.close(resolve)));

// Covers ending spans, serializing each batch, and sending it, up to the
// collector receiving the last batch. flush() does not report when its
// export finishes, so the collector counts the batches instead.
bench('export spans to a collector', { samples: 30 }, async (b) => {
  const target = received + kBatchesPerSample;
  let watchdog;
  const done = new Promise((resolve, reject) => {
    onReceived = () => {
      if (received >= target) resolve();
    };
    watchdog = setTimeout(() => {
      const missing = target - received;
      reject(
        new Error(
          `${missing} of ${kBatchesPerSample} batches never reached the collector`,
        ),
      );
    }, kSampleTimeoutMs);
  });

  b.start();
  for (let batch = 0; batch < kBatchesPerSample; batch++) {
    for (let i = 0; i < kSpansPerBatch; i++) {
      const span = new Span('GET', SPAN_KIND_CLIENT);
      span.setAttribute('http.request.method', 'GET');
      span.setAttribute('url.full', 'http://127.0.0.1/path?query=ascii');
      span.setAttribute('server.address', '127.0.0.1');
      span.setAttribute('server.port', 80);
      span.end();
    }
    microtel.flush();
  }
  try {
    await done;
  } finally {
    clearTimeout(watchdog);
  }
  b.end(kBatchesPerSample * kSpansPerBatch);
});
