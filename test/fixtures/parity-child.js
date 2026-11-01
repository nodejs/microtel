'use strict';

// Spawned with --expose-internals and the battery module in
// BATTERY_MODULE: runs the battery through core's real internals and
// prints the outcomes as JSON for the parent to compare.

const {
  validateString,
  validateObject,
  validateInteger,
  validateNumber,
} = require('internal/validators');
const {
  codes: { ERR_INVALID_ARG_TYPE, ERR_INVALID_ARG_VALUE, ERR_OUT_OF_RANGE },
} = require('internal/errors');
const { runBattery } = require(process.env.BATTERY_MODULE);

const impl = {
  validateString,
  validateObject,
  validateInteger,
  validateNumber,
  invalidArgTypeError: (name, expected, actual) =>
    new ERR_INVALID_ARG_TYPE(name, expected, actual),
  invalidArgValueError: (name, value, reason) =>
    new ERR_INVALID_ARG_VALUE(name, value, reason),
  outOfRangeError: (str, range, input) =>
    new ERR_OUT_OF_RANGE(str, range, input),
};

process.stdout.write(JSON.stringify(runBattery(impl)));
