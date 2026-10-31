'use strict';

const { Buffer } = require('node:buffer');
const kMaxMessageSize = 16 * 1024 * 1024;

// Compute BigInt thresholds once; shifting inside the sizing function would
// allocate threshold values on every call, even after V8 optimization.
const kVarintLimits = [
  1n << 7n,
  1n << 14n,
  1n << 21n,
  1n << 28n,
  1n << 35n,
  1n << 42n,
  1n << 49n,
  1n << 56n,
  1n << 63n,
];

// Sizing uses Number for unsigned lengths/tags and BigInt for full int64s.
// Writing splits wide values into scalar words, without a LongBits object.
function measureVarint(value) {
  if (typeof value === 'number') {
    if (value < 2 ** 7) return 1;
    if (value < 2 ** 14) return 2;
    if (value < 2 ** 21) return 3;
    if (value < 2 ** 28) return 4;
    if (value < 2 ** 35) return 5;
    if (value < 2 ** 42) return 6;
    if (value < 2 ** 49) return 7;
    if (value < 2 ** 56) return 8;
    if (value < 2 ** 63) return 9;
  } else {
    if (value < kVarintLimits[0]) return 1;
    if (value < kVarintLimits[1]) return 2;
    if (value < kVarintLimits[2]) return 3;
    if (value < kVarintLimits[3]) return 4;
    if (value < kVarintLimits[4]) return 5;
    if (value < kVarintLimits[5]) return 6;
    if (value < kVarintLimits[6]) return 7;
    if (value < kVarintLimits[7]) return 8;
    if (value < kVarintLimits[8]) return 9;
  }
  return 10;
}

function integerValue(value) {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value))
      throw new RangeError('OTLP integer must be a safe integer');
    if (value >= 0) return value;
  }
  const n = BigInt(value);
  if (n < -(1n << 63n) || n >= 1n << 63n)
    throw new RangeError('OTLP integer exceeds int64 range');
  return BigInt.asUintN(64, n);
}

// All length-delimited and integer fields in the supported OTLP messages
// have one-byte tags. Span.flags (field 16) is handled explicitly as fixed32.
const measureMessage = (size) => 1 + measureVarint(size) + size;
const measureString = (value) => measureMessage(Buffer.byteLength(value));
const measureInteger = (value) => 1 + measureVarint(integerValue(value));

function writeWords(buffer, offset, lo, hi) {
  while (hi) {
    buffer[offset++] = (lo & 127) | 128;
    lo = ((lo >>> 7) | (hi << 25)) >>> 0;
    hi >>>= 7;
  }
  while (lo > 127) {
    buffer[offset++] = (lo & 127) | 128;
    lo >>>= 7;
  }
  buffer[offset++] = lo;
  return offset;
}

function writeVarint(buffer, offset, value) {
  if (typeof value === 'number') {
    while (value >= 128) {
      buffer[offset++] = (value % 128) | 128;
      value = Math.floor(value / 128);
    }
    buffer[offset++] = value;
    return offset;
  }
  return writeWords(
    buffer,
    offset,
    Number(value & 0xffffffffn),
    Number(value >> 32n),
  );
}

function writeHeader(buffer, offset, tag, length) {
  buffer[offset++] = tag;
  return writeVarint(buffer, offset, length);
}

function writeInteger(buffer, offset, tag, value) {
  buffer[offset++] = tag;
  if (typeof value === 'number' && value < 0) {
    if (!Number.isSafeInteger(value))
      throw new RangeError('OTLP integer must be a safe integer');
    const magnitude = -value;
    let lo = magnitude >>> 0;
    let hi = Math.floor(magnitude / 4294967296) >>> 0;
    lo = (~lo + 1) >>> 0;
    hi = (~hi + (lo === 0 ? 1 : 0)) >>> 0;
    return writeWords(buffer, offset, lo, hi);
  }
  return writeVarint(buffer, offset, integerValue(value));
}

function writeString(buffer, offset, tag, value) {
  offset = writeHeader(buffer, offset, tag, Buffer.byteLength(value));
  return offset + buffer.write(value, offset, undefined, 'utf8');
}

function writeBytes(buffer, offset, tag, value) {
  offset = writeHeader(buffer, offset, tag, value.length);
  buffer.set(value, offset);
  return offset + value.length;
}

class Reader {
  offset = 0;
  constructor(buffer) {
    this.buffer = buffer;
  }
  fail() {
    throw new Error('Malformed OTLP protobuf response');
  }
  varint() {
    let value = 0n;
    for (let i = 0; i < 10; i++) {
      if (this.offset >= this.buffer.length) this.fail();
      const byte = this.buffer[this.offset++];
      if (i === 9 && byte > 1) this.fail();
      value |= BigInt(byte & 127) << BigInt(i * 7);
      if (byte < 128) return value;
    }
    this.fail();
  }
  bytes() {
    const size = this.varint();
    if (size > BigInt(this.buffer.length - this.offset)) this.fail();
    const start = this.offset;
    this.offset += Number(size);
    return this.buffer.subarray(start, this.offset);
  }
  fields(visit) {
    while (this.offset < this.buffer.length) {
      const tag = this.varint();
      const field = Number(tag >> 3n);
      const wire = Number(tag & 7n);
      if (field < 1 || field > 0x1fffffff) this.fail();
      if (visit(field, wire)) continue;
      if (wire === 0) this.varint();
      else if (wire === 2) this.bytes();
      else if (wire === 1 || wire === 5) {
        this.offset += wire === 1 ? 8 : 4;
        if (this.offset > this.buffer.length) this.fail();
      } else this.fail();
    }
  }
}

module.exports = {
  measureVarint,
  measureMessage,
  measureString,
  measureInteger,
  writeVarint,
  writeHeader,
  writeInteger,
  writeString,
  writeBytes,
  Reader,
  kMaxMessageSize,
};
