'use strict';

const { registerHttpBenchmark } = require('./helpers/http');

registerHttpBenchmark('http request (traced, unsampled)', {
  tracing: true,
  sampleRatio: 0,
});
