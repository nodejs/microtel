'use strict';

// @nodejs/microtel: OpenTelemetry tracing for Node.js core protocols.
//
// init() activates tracing (at most once per process, and it cannot be
// stopped), isActive() reports state, and flush() forces an export whose
// returned promise resolves once it has finished. context reads and sets
// the propagated context.

const { start, isActive } = require('./lib/core');
const { flush } = require('./lib/flush');
const {
  getCurrentContext,
  getTarget,
  getTraceContext,
  setAdapter,
  setTarget,
} = require('./lib/context');

module.exports = {
  init: start,
  isActive,
  flush,
  context: {
    active: getCurrentContext,
    getTarget,
    getTraceContext,
    setAdapter,
    setTarget,
  },
};
