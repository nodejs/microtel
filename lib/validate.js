'use strict';

// Faithful port of the small subset of Node.js core validators used by
// this package (lib/internal/validators.js, lib/internal/errors.js),
// matching core's error shapes (name, code, message) exactly.
// TODO(bengl): add back the parity test that proved it. Spawn a child
// with --expose-internals that runs one shared battery of calls through
// require('internal/validators') and the ERR_INVALID_ARG_TYPE,
// ERR_INVALID_ARG_VALUE, and ERR_OUT_OF_RANGE constructors from
// internal/errors, print the outcomes (thrown or not, and the thrown
// error's name, code, message) as JSON, and diff them against the same
// battery run through this module. When core changes these message
// formats, such a test is what catches the drift.

const { inspect } = require('node:util');

// From lib/internal/errors.js.
const classRegExp = /^[A-Z][a-zA-Z0-9]*$/;
const kTypes = [
  'string',
  'function',
  'number',
  'object',
  // Accept 'Function' and 'Object' as alternative to the lower cased version.
  'Function',
  'Object',
  'boolean',
  'bigint',
  'symbol',
];

function formatList(array, type = 'and') {
  switch (array.length) {
    case 0:
      return '';
    case 1:
      return `${array[0]}`;
    case 2:
      return `${array[0]} ${type} ${array[1]}`;
    case 3:
      return `${array[0]}, ${array[1]}, ${type} ${array[2]}`;
    default:
      return `${array.slice(0, -1).join(', ')}, ${type} ${array[array.length - 1]}`;
  }
}

// From lib/internal/errors.js: describes the received value at the end of
// an ERR_INVALID_ARG_TYPE message.
function determineSpecificType(value) {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';

  const type = typeof value;

  switch (type) {
    case 'bigint':
      return `type bigint (${value}n)`;
    case 'number':
      if (value === 0)
        return 1 / value === -Infinity ? 'type number (-0)' : 'type number (0)';
      if (Number.isNaN(value)) return 'type number (NaN)';
      if (value === Infinity) return 'type number (Infinity)';
      if (value === -Infinity) return 'type number (-Infinity)';
      return `type number (${value})`;
    case 'boolean':
      return value ? 'type boolean (true)' : 'type boolean (false)';
    case 'symbol':
      return `type symbol (${String(value)})`;
    case 'function':
      return `function ${value.name}`;
    case 'object':
      if (value.constructor && 'name' in value.constructor)
        return `an instance of ${value.constructor.name}`;
      return `${inspect(value, { depth: -1 })}`;
    case 'string':
      if (value.length > 28) value = `${value.slice(0, 25)}...`;
      if (!value.includes("'")) return `type string ('${value}')`;
      return `type string (${JSON.stringify(value)})`;
    default:
      value = inspect(value, { colors: false });
      if (value.length > 28) value = `${value.slice(0, 25)}...`;
      return `type ${type} (${value})`;
  }
}

// From lib/internal/errors.js: inserts underscores into large numbers.
function addNumericalSeparator(val) {
  let res = '';
  let i = val.length;
  const start = val[0] === '-' ? 1 : 0;
  for (; i >= start + 4; i -= 3) res = `_${val.slice(i - 3, i)}${res}`;
  return `${val.slice(0, i)}${res}`;
}

// The ERR_INVALID_ARG_TYPE message builder.
function invalidArgTypeError(name, expected, actual) {
  if (!Array.isArray(expected)) expected = [expected];

  let msg = 'The ';
  if (name.endsWith(' argument')) {
    // For cases like 'first argument'
    msg += `${name} `;
  } else {
    const type = name.includes('.') ? 'property' : 'argument';
    msg += `"${name}" ${type} `;
  }
  msg += 'must be ';

  const types = [];
  const instances = [];
  const other = [];

  for (const value of expected) {
    if (kTypes.includes(value)) types.push(value.toLowerCase());
    else if (classRegExp.test(value)) instances.push(value);
    else other.push(value);
  }

  // Special handle `object` in case other instances are allowed to outline
  // the differences between each other.
  if (instances.length > 0) {
    const pos = types.indexOf('object');
    if (pos !== -1) {
      types.splice(pos, 1);
      instances.push('Object');
    }
  }

  if (types.length > 0) {
    msg += `${types.length > 1 ? 'one of type' : 'of type'} ${formatList(types, 'or')}`;
    if (instances.length > 0 || other.length > 0) msg += ' or ';
  }

  if (instances.length > 0) {
    msg += `an instance of ${formatList(instances, 'or')}`;
    if (other.length > 0) msg += ' or ';
  }

  if (other.length > 0) {
    if (other.length > 1) {
      msg += `one of ${formatList(other, 'or')}`;
    } else {
      if (other[0].toLowerCase() !== other[0]) msg += 'an ';
      msg += `${other[0]}`;
    }
  }

  msg += `. Received ${determineSpecificType(actual)}`;

  const err = new TypeError(msg);
  err.code = 'ERR_INVALID_ARG_TYPE';
  return err;
}

// The ERR_INVALID_ARG_VALUE message builder.
function invalidArgValueError(name, value, reason = 'is invalid') {
  let inspected = inspect(value);
  if (inspected.length > 128) inspected = `${inspected.slice(0, 128)}...`;
  const type = name.includes('.') ? 'property' : 'argument';
  const err = new TypeError(
    `The ${type} '${name}' ${reason}. Received ${inspected}`,
  );
  err.code = 'ERR_INVALID_ARG_VALUE';
  return err;
}

// The ERR_OUT_OF_RANGE message builder.
function outOfRangeError(str, range, input) {
  let msg = `The value of "${str}" is out of range.`;
  let received;
  if (Number.isInteger(input) && Math.abs(input) > 2 ** 32) {
    received = addNumericalSeparator(String(input));
  } else if (typeof input === 'bigint') {
    received = String(input);
    if (input > 2n ** 32n || input < -(2n ** 32n))
      received = addNumericalSeparator(received);
    received += 'n';
  } else {
    received = inspect(input);
  }
  msg += ` It must be ${range}. Received ${received}`;
  const err = new RangeError(msg);
  err.code = 'ERR_OUT_OF_RANGE';
  return err;
}

// Validators, from lib/internal/validators.js. Only the default behavior
// is ported: validateObject without option flags, validateInteger with an
// optional minimum.

function validateString(value, name) {
  if (typeof value !== 'string')
    throw invalidArgTypeError(name, 'string', value);
}

function validateObject(value, name) {
  if (value === null || Array.isArray(value))
    throw invalidArgTypeError(name, 'Object', value);
  if (typeof value !== 'object')
    throw invalidArgTypeError(name, 'Object', value);
}

function validateInteger(
  value,
  name,
  min = Number.MIN_SAFE_INTEGER,
  max = Number.MAX_SAFE_INTEGER,
) {
  if (typeof value !== 'number')
    throw invalidArgTypeError(name, 'number', value);
  if (!Number.isInteger(value))
    throw outOfRangeError(name, 'an integer', value);
  if (value < min || value > max)
    throw outOfRangeError(name, `>= ${min} && <= ${max}`, value);
}

module.exports = {
  validateString,
  validateObject,
  validateInteger,
  invalidArgTypeError,
  invalidArgValueError,
};
