'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const protobuf = require('protobufjs');
const {
  measureInteger,
  measureVarint,
  writeInteger,
  writeVarint,
} = require('../lib/protobuf');

test('negative Number integers write without constructing BigInts', (t) => {
  const values = [-1, -128, -129, -(2 ** 32), Number.MIN_SAFE_INTEGER];
  const expected = values.map((value) =>
    protobuf.Writer.create().uint32(8).int64(String(value)).finish(),
  );
  const buffer = Buffer.alloc(16);
  const bigint = t.mock.method(globalThis, 'BigInt');
  for (let i = 0; i < values.length; i++) {
    const end = writeInteger(buffer, 0, 8, values[i]);
    assert.deepEqual(buffer.subarray(0, end), expected[i]);
  }
  assert.equal(bigint.mock.callCount(), 0);
});

test('64-bit varints match protobufjs at seven-bit and word boundaries', () => {
  const values = new Set([0n, (1n << 64n) - 1n]);
  for (const bits of [7, 14, 21, 28, 32, 35, 42, 49, 53, 56, 63]) {
    for (const delta of [-1n, 0n, 1n]) values.add((1n << BigInt(bits)) + delta);
  }
  for (const value of values) {
    const buffer = Buffer.alloc(16, 0xa5);
    const end = writeVarint(buffer, 2, value);
    assert.deepEqual(
      buffer.subarray(2, end),
      protobuf.Writer.create().uint64(String(value)).finish(),
    );
    assert.equal(end - 2, measureVarint(value));
    assert.equal(buffer[1], 0xa5);
    assert.equal(buffer[end], 0xa5);
  }
});

test('signed integers match protobufjs for limits and deterministic random values', () => {
  const values = [
    0,
    -0,
    127,
    128,
    2 ** 32 - 1,
    2 ** 32,
    -(2 ** 32),
    Number.MAX_SAFE_INTEGER,
    Number.MIN_SAFE_INTEGER,
    (1n << 63n) - 1n,
    -(1n << 63n),
  ];
  let seed = 0x74c3;
  function word() {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return seed >>> 0;
  }
  for (let i = 0; i < 500; i++) {
    const n = (word() & 0x1fffff) * 2 ** 32 + word();
    values.push(
      n,
      -n,
      BigInt.asIntN(64, (BigInt(word()) << 32n) | BigInt(word())),
    );
  }
  for (const value of values) {
    const buffer = Buffer.alloc(16, 0xa5);
    const end = writeInteger(buffer, 2, 8, value);
    assert.deepEqual(
      buffer.subarray(2, end),
      protobuf.Writer.create().uint32(8).int64(String(value)).finish(),
    );
    assert.equal(end - 2, measureInteger(value));
    assert.equal(buffer[1], 0xa5);
    assert.equal(buffer[end], 0xa5);
  }
  for (const value of [
    1.5,
    NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
    Number.MIN_SAFE_INTEGER - 1,
    1n << 63n,
    -(1n << 63n) - 1n,
  ]) {
    assert.throws(
      () => writeInteger(Buffer.alloc(16), 0, 8, value),
      RangeError,
    );
  }
});

test('varint sizes match protobufjs across all ten byte lengths', () => {
  const values = [0n, (1n << 64n) - 1n];
  for (let bits = 7; bits < 64; bits += 7) {
    const limit = 1n << BigInt(bits);
    values.push(limit - 1n, limit, limit + 1n);
  }
  for (const value of values) {
    const expected = protobuf.Writer.create()
      .uint64(String(value))
      .finish().length;
    assert.equal(measureVarint(value), expected);
    if (value <= BigInt(Number.MAX_SAFE_INTEGER)) {
      assert.equal(measureVarint(Number(value)), expected);
    }
  }
});
