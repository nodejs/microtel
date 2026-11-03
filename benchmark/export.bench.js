'use strict';

const { after, before, bench } = require('node:bench');
const http = require('node:http');
const microtel = require('../index');
const { Span, SPAN_KIND_CLIENT } = require('../lib/span');

const kBatchesPerSample = 20;
const kSpansPerBatch = 100;

let collector;

before(async () => {
  collector = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => res.end());
  });
  await new Promise((resolve) => collector.listen(0, '127.0.0.1', resolve));
  microtel.init({
    endpoint: `http://127.0.0.1:${collector.address().port}`,
    // Each batch is flushed by hand, so the buffer never fills on its own.
    maxBufferSize: kSpansPerBatch + 1,
    // Every flush resolves by this deadline, so a stalled export slows one
    // sample instead of hanging the run.
    exportTimeout: 250,
  });
});

after(() => new Promise((resolve) => collector.close(resolve)));

// Covers ending spans, serializing each batch, and sending it, through
// the end of the last export. Each flush resolves once its own export,
// and any still in flight, has finished.
bench('export spans to a collector', { samples: 30 }, async (b) => {
  b.start();
  const flushes = [];
  for (let batch = 0; batch < kBatchesPerSample; batch++) {
    for (let i = 0; i < kSpansPerBatch; i++) {
      const span = new Span('GET', SPAN_KIND_CLIENT);
      span.setAttribute('http.request.method', 'GET');
      span.setAttribute('url.full', 'http://127.0.0.1/path?query=ascii');
      span.setAttribute('server.address', '127.0.0.1');
      span.setAttribute('server.port', 80);
      span.end();
    }
    flushes.push(microtel.flush());
  }
  await Promise.all(flushes);
  b.end(kBatchesPerSample * kSpansPerBatch);
});
