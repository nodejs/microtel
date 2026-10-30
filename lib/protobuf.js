'use strict';

const { Buffer } = require('node:buffer');
const kMaxMessageSize = 16 * 1024 * 1024;

// Unsigned lengths/tags take the Number path. BigInt is needed only for
// int64 values outside that path, such as negative two's-complement values.
function measureVarint(value) {
  let size = 1;
  if (typeof value === 'number') {
    while (value >= 128) {
      value = Math.floor(value / 128);
      size++;
    }
  } else {
    while (value >= 128n) {
      value >>= 7n;
      size++;
    }
  }
  return size;
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

function writeVarint(buffer, offset, value) {
  if (typeof value === 'number') {
    while (value >= 128) {
      buffer[offset++] = (value % 128) | 128;
      value = Math.floor(value / 128);
    }
    buffer[offset++] = value;
  } else {
    while (value >= 128n) {
      buffer[offset++] = Number(value & 127n) | 128;
      value >>= 7n;
    }
    buffer[offset++] = Number(value);
  }
  return offset;
}

function writeHeader(buffer, offset, tag, length) {
  buffer[offset++] = tag;
  return writeVarint(buffer, offset, length);
}

function writeInteger(buffer, offset, tag, value) {
  buffer[offset++] = tag;
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
