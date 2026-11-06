'use strict';

const { registerFetchBenchmark } = require('./helpers/http');

registerFetchBenchmark('fetch request (traced, unsampled)', {
  tracing: true,
  sampleRatio: 0,
});
