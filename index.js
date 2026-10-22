'use strict';

// @nodejs/microtel: OpenTelemetry tracing for Node.js core protocols.
//
// init() activates tracing (at most once per process, and it cannot be
// stopped), isActive() reports state, and flush() forces an export.

const { start, isActive } = require('./lib/core');
const { flush } = require('./lib/flush');

module.exports = {
  init: start,
  isActive,
  flush,
};
