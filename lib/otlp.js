'use strict';

const { Buffer } = require('node:buffer');
const {
  measureMessage,
  measureString,
  measureInteger,
  writeHeader,
  writeInteger,
  writeString,
  writeBytes,
  Reader,
  kMaxMessageSize,
} = require('./protobuf');
const unixNano = (time) => BigInt(Math.round(time)) * 1_000_000n;

function measureAnyValue(value) {
  switch (typeof value) {
    case 'boolean':
      return 2;
    case 'number':
      return Number.isInteger(value) ? measureInteger(value) : 9;
    default:
      return measureString(String(value));
  }
}

function writeAnyValue(buffer, offset, value) {
  switch (typeof value) {
    case 'boolean':
      return writeInteger(buffer, offset, 16, value ? 1 : 0);
    case 'number':
      if (Number.isInteger(value))
        return writeInteger(buffer, offset, 24, value);
      buffer[offset++] = 33; // AnyValue.double_value, fixed64
      buffer.writeDoubleLE(value, offset);
      return offset + 8;
    default:
      return writeString(buffer, offset, 10, String(value));
  }
}

function measureAttributes(attrs) {
  let size = 0;
  for (const key in attrs) {
    if (!Object.hasOwn(attrs, key) || attrs[key] === undefined) continue;
    const pairSize =
      measureString(key) + measureMessage(measureAnyValue(attrs[key]));
    size += measureMessage(pairSize);
  }
  return size;
}

function writeAttributes(buffer, offset, tag, attrs) {
  for (const key in attrs) {
    if (!Object.hasOwn(attrs, key) || attrs[key] === undefined) continue;
    const value = attrs[key];
    const valueSize = measureAnyValue(value);
    offset = writeHeader(
      buffer,
      offset,
      tag,
      measureString(key) + measureMessage(valueSize),
    );
    offset = writeString(buffer, offset, 10, key);
    offset = writeHeader(buffer, offset, 18, valueSize);
    offset = writeAnyValue(buffer, offset, value);
  }
  return offset;
}

function validateTime(time) {
  // Largest whole millisecond that fits in an unsigned nanosecond fixed64.
  if (
    !Number.isFinite(time) ||
    Math.round(time) < 0 ||
    Math.round(time) > 18_446_744_073_709
  ) {
    throw new RangeError('Invalid OTLP timestamp');
  }
}

function measureEvent(value) {
  validateTime(value.time);
  return 9 + measureString(value.name) + measureAttributes(value.attributes);
}
function writeEvent(buffer, offset, value) {
  offset = writeHeader(buffer, offset, 90, measureEvent(value)); // Span.events
  buffer[offset++] = 9; // Event.time_unix_nano
  buffer.writeBigUInt64LE(unixNano(value.time), offset);
  offset += 8;
  offset = writeString(buffer, offset, 18, value.name);
  return writeAttributes(buffer, offset, 26, value.attributes);
}

function measureStatus(value) {
  return (
    (value.message ? measureString(value.message) : 0) +
    (value.code ? measureInteger(value.code) : 0)
  );
}
function writeStatus(buffer, offset, value) {
  offset = writeHeader(buffer, offset, 122, measureStatus(value)); // Span.status
  if (value.message) offset = writeString(buffer, offset, 18, value.message);
  if (value.code) offset = writeInteger(buffer, offset, 24, value.code);
  return offset;
}

function validateId(value, length, name) {
  if (
    typeof value !== 'string' ||
    value.length !== length * 2 ||
    !/^[0-9a-f]+$/i.test(value)
  ) {
    throw new TypeError(`Invalid OTLP ${name}`);
  }
}
function writeId(buffer, offset, tag, value, length) {
  offset = writeHeader(buffer, offset, tag, length);
  return offset + buffer.write(value, offset, length, 'hex');
}

function measureSpan(value) {
  validateTime(value.startTime);
  validateTime(value.endTime);
  validateId(value.traceId, 16, 'traceId');
  validateId(value.spanId, 8, 'spanId');
  // trace_id (18), span_id (10), start/end fixed64 timestamps (18).
  let size = 46 + measureString(value.name) + measureInteger(value.kind);
  if (value.parentSpanId) {
    validateId(value.parentSpanId, 8, 'parentSpanId');
    size += 10;
  }
  if (value.tracestate) size += measureString(value.tracestate);
  size += measureAttributes(value.getAttributes());
  for (const event of value.getEvents())
    size += measureMessage(measureEvent(event));
  if (value.status.code || value.status.message)
    size += measureMessage(measureStatus(value.status));
  if (value.traceFlags) size += 6; // Two-byte tag for field 16 plus fixed32.
  return size;
}

function writeSpan(buffer, offset, value) {
  offset = writeHeader(buffer, offset, 18, measureSpan(value)); // ScopeSpans.spans
  offset = writeId(buffer, offset, 10, value.traceId, 16);
  offset = writeId(buffer, offset, 18, value.spanId, 8);
  if (value.tracestate)
    offset = writeString(buffer, offset, 26, value.tracestate);
  if (value.parentSpanId)
    offset = writeId(buffer, offset, 34, value.parentSpanId, 8);
  offset = writeString(buffer, offset, 42, value.name);
  offset = writeInteger(buffer, offset, 48, value.kind);
  buffer[offset++] = 57; // Span.start_time_unix_nano
  buffer.writeBigUInt64LE(unixNano(value.startTime), offset);
  offset += 8;
  buffer[offset++] = 65; // Span.end_time_unix_nano
  buffer.writeBigUInt64LE(unixNano(value.endTime), offset);
  offset += 8;
  offset = writeAttributes(buffer, offset, 74, value.getAttributes());
  for (const event of value.getEvents())
    offset = writeEvent(buffer, offset, event);
  if (value.status.code || value.status.message)
    offset = writeStatus(buffer, offset, value.status);
  if (value.traceFlags) {
    buffer[offset++] = 133;
    buffer[offset++] = 1; // Span.flags: (16 << 3) | 5
    buffer.writeUInt32LE(value.traceFlags, offset);
    offset += 4;
  }
  return offset;
}

function resourceValue(attr) {
  return attr.value.intValue !== undefined
    ? BigInt(attr.value.intValue)
    : attr.value.stringValue;
}
function measureResource(resource) {
  let size = 0;
  for (const attr of resource.attributes) {
    const valueSize =
      attr.value.intValue !== undefined
        ? measureInteger(resourceValue(attr))
        : measureString(resourceValue(attr));
    size += measureMessage(measureString(attr.key) + measureMessage(valueSize));
  }
  return size;
}
function writeResource(buffer, resource) {
  let offset = 0;
  for (const attr of resource.attributes) {
    const value = resourceValue(attr);
    const valueSize =
      typeof value === 'bigint' ? measureInteger(value) : measureString(value);
    offset = writeHeader(
      buffer,
      offset,
      10,
      measureString(attr.key) + measureMessage(valueSize),
    );
    offset = writeString(buffer, offset, 10, attr.key);
    offset = writeHeader(buffer, offset, 18, valueSize);
    offset =
      typeof value === 'bigint'
        ? writeInteger(buffer, offset, 24, value)
        : writeString(buffer, offset, 10, value);
  }
  return offset;
}

function allocate(size) {
  if (size > kMaxMessageSize)
    throw new RangeError('OTLP message exceeds size limit');
  return Buffer.allocUnsafe(size);
}

class OtlpEncoder {
  constructor(resource, scope) {
    this.resource = allocate(measureResource(resource));
    writeResource(this.resource, resource);
    this.scope = allocate(
      measureString(scope.name) + measureString(scope.version),
    );
    let offset = writeString(this.scope, 0, 10, scope.name);
    writeString(this.scope, offset, 18, scope.version);
    this.resourceFieldSize = measureMessage(this.resource.length);
    this.scopeFieldSize = measureMessage(this.scope.length);
  }

  byteLength(spans) {
    let size = this.scopeFieldSize;
    for (const span of spans) size += measureMessage(measureSpan(span));
    return measureMessage(this.resourceFieldSize + measureMessage(size));
  }

  encode(spans, onError) {
    let scopeSpansSize = this.scopeFieldSize;
    // Allocate a filtered list only on the error path. Valid batches need
    // neither a message tree, a lengths array, a Set, nor encoding closures.
    let accepted;
    for (let i = 0; i < spans.length; i++) {
      try {
        scopeSpansSize += measureMessage(measureSpan(spans[i]));
        if (accepted) accepted.push(spans[i]);
      } catch (err) {
        if (!onError) throw err;
        accepted ??= spans.slice(0, i);
        onError(err, spans[i]);
      }
    }
    if (accepted?.length === 0) return null;
    const resourceSpansSize =
      this.resourceFieldSize + measureMessage(scopeSpansSize);
    const size = measureMessage(resourceSpansSize);
    if (size > kMaxMessageSize)
      throw new RangeError('OTLP message exceeds size limit');
    const buffer = Buffer.allocUnsafe(5 + size);
    buffer[0] = 0;
    buffer.writeUInt32BE(size, 1);
    let offset = writeHeader(buffer, 5, 10, resourceSpansSize);
    offset = writeBytes(buffer, offset, 10, this.resource);
    offset = writeHeader(buffer, offset, 18, scopeSpansSize);
    offset = writeBytes(buffer, offset, 10, this.scope);
    for (const span of accepted ?? spans)
      offset = writeSpan(buffer, offset, span);
    if (offset !== buffer.length) throw new Error('OTLP encoded size changed');
    return buffer;
  }
}
function decodeResponse(buffer) {
  const result = { rejectedSpans: 0n, errorMessage: '' };
  const reader = new Reader(buffer);
  reader.fields((field, wire) => {
    if (field !== 1 || wire !== 2) return false;
    const partial = new Reader(reader.bytes());
    partial.fields((f, type) => {
      if (f === 1 && type === 0) {
        result.rejectedSpans = BigInt.asIntN(64, partial.varint());
        return true;
      }
      if (f === 2 && type === 2) {
        result.errorMessage = partial.bytes().toString('utf8');
        return true;
      }
      return false;
    });
    return true;
  });
  return result;
}

module.exports = { OtlpEncoder, measureSpan, decodeResponse };
