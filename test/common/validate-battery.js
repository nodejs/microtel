'use strict';

// The input battery for test-validate-parity.js. Both sides share
// this module, so the compared inputs can never drift apart.

// A JSON-safe, human-readable label for a call.
function label(fn, args) {
  const rendered = args.map((a) =>
    typeof a === 'string' ? `'${a}'` : String(a),
  );
  return `${fn}(${rendered.join(', ')})`;
}

// Calls fn with args and describes the outcome: nothing thrown, or the
// thrown error's name, code, and message.
function outcome(fn, args) {
  try {
    fn(...args);
    return { thrown: false };
  } catch (err) {
    return {
      thrown: true,
      name: err.name,
      code: err.code,
      message: err.message,
    };
  }
}

const kValidatorCases = [
  ['validateString', [123, 'x']],
  ['validateString', [undefined, 'x']],
  ['validateString', [null, 'x']],
  ['validateString', [true, 'x']],
  ['validateString', [Symbol('s'), 'x']],
  ['validateString', [{ a: 1 }, 'x']],
  ['validateString', [['a'], 'x']],
  ['validateString', [() => {}, 'x']],
  ['validateString', ['ok', 'x']],
  ['validateObject', [null, 'x']],
  ['validateObject', [[1, 2], 'x']],
  ['validateObject', ['str', 'x']],
  ['validateObject', [123, 'x']],
  ['validateObject', [() => {}, 'x']],
  ['validateObject', [{}, 'x']],
  ['validateInteger', [0, 'x', 1]],
  ['validateInteger', ['abc', 'x', 1]],
  ['validateInteger', [1.5, 'x', 1]],
  ['validateInteger', [NaN, 'x', 1]],
  ['validateInteger', [5, 'x', 1]],
  ['validateInteger', [9007199254740999, 'x', 1]],
  ['validateNumber', [0, 'x', 0, 1]],
  ['validateNumber', [0.5, 'x', 0, 1]],
  ['validateNumber', [1, 'x', 0, 1]],
  ['validateNumber', [-0.1, 'x', 0, 1]],
  ['validateNumber', [1.5, 'x', 0, 1]],
  ['validateNumber', [NaN, 'x', 0, 1]],
  ['validateNumber', [Infinity, 'x', 0, 1]],
  ['validateNumber', ['0.5', 'x', 0, 1]],
  ['validateNumber', [undefined, 'x', 0, 1]],
  ['validateNumber', [0, 'x', 1]],
  ['validateNumber', [NaN, 'x']],
];

// Error-constructor cases: impl.fn(...args) must return the error object.
const kErrorCases = [
  [
    'invalidArgTypeError',
    ['options.filter', ['string', 'null', 'undefined'], 42],
  ],
  ['invalidArgTypeError', ['options.endpoint', ['string'], 123]],
  ['invalidArgTypeError', ['options.maxBufferSize', ['integer'], 'abc']],
  ['invalidArgTypeError', ['options.foo', ['Object'], []]],
  [
    'invalidArgTypeError',
    ['first argument', ['string', 'null', 'undefined'], 42],
  ],
  [
    'invalidArgValueError',
    ['options.endpoint', 'not-a-valid-url', 'must be a valid URL'],
  ],
  [
    'invalidArgValueError',
    ['options.serviceName', '', 'must be a non-empty string'],
  ],
  ['invalidArgValueError', ['options.maxBufferSize', 0]],
  ['outOfRangeError', ['x', '>= 1 && <= 100', 0]],
  ['outOfRangeError', ['n', 'an integer', 10000000000]],
];

// Runs the battery through impl: either this package's lib/validate.js
// exports or wrappers around core's internal error constructors.
function runBattery(impl) {
  const results = [];

  for (const [name, args] of kValidatorCases) {
    results.push({
      call: label(name, args),
      outcome: outcome(impl[name], args),
    });
  }

  for (const [name, args] of kErrorCases) {
    const err = impl[name](...args);
    results.push({
      call: label(name, args),
      outcome: {
        thrown: true,
        name: err.name,
        code: err.code,
        message: err.message,
      },
    });
  }

  return results;
}

module.exports = {
  runBattery,
};
