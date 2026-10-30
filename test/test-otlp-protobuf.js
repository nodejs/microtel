'use strict';

const assert = require('node:assert/strict');
const { before, test } = require('node:test');
const { loadOtlp } = require('./common/otlp');
let Request, Response, Span;
before(async () => {
  ({ Request, Response, Span } = await loadOtlp());
});

// Literal OTLP model, independent of the encoder's schema traversal.
function referenceSpan() {
  return {
    traceId: Buffer.from('ab'.repeat(16), 'hex'),
    spanId: Buffer.from('cd'.repeat(8), 'hex'),
    parentSpanId: Buffer.from('ef'.repeat(8), 'hex'),
    traceState: 'vendor=value',
    name: 'GET /日本語',
    kind: 2,
    flags: 1,
    startTimeUnixNano: '1700000000000000000',
    endTimeUnixNano: '1700000000001000000',
    status: { code: 2, message: 'failed' },
    attributes: [
      { key: 'empty', value: { stringValue: '' } },
      { key: 'zero', value: { intValue: '0' } },
      { key: 'no', value: { boolValue: false } },
      { key: 'negative', value: { intValue: '-1' } },
      { key: 'fraction', value: { doubleValue: 1.5 } },
    ],
    events: [
      {
        name: 'exception',
        timeUnixNano: '1700000000000000000',
        attributes: [{ key: 'message', value: { stringValue: '💥' } }],
      },
    ],
  };
}

function referenceRequest(
  spans,
  resource = { attributes: [] },
  scope = { name: 'test', version: '0' },
) {
  return Buffer.from(
    Request.encode(
      Request.fromObject({
        resourceSpans: [{ resource, scopeSpans: [{ scope, spans }] }],
      }),
    ).finish(),
  );
}

const makeSpan = () => ({
  traceId: 'ab'.repeat(16),
  spanId: 'cd'.repeat(8),
  parentSpanId: 'ef'.repeat(8),
  name: 'GET /日本語',
  kind: 2,
  startTime: 1700000000000,
  endTime: 1700000000001,
  traceFlags: 1,
  tracestate: 'vendor=value',
  status: { code: 2, message: 'failed' },
  getAttributes: () => ({
    empty: '',
    zero: 0,
    no: false,
    negative: -1,
    fraction: 1.5,
    unused: undefined,
  }),
  getEvents: () => [
    { name: 'exception', time: 1700000000000, attributes: { message: '💥' } },
  ],
});

test('direct OTLP encoder matches protobufjs using the official OTLP schemas', () => {
  const { OtlpEncoder } = require('../lib/otlp');
  const encoder = new OtlpEncoder(
    { attributes: [{ key: 'service.name', value: { stringValue: 'test' } }] },
    { name: 'microtel', version: '0' },
  );
  const frame = encoder.encode([makeSpan(), makeSpan()]);
  assert.equal(frame[0], 0);
  assert.equal(frame.readUInt32BE(1), frame.length - 5);
  assert.deepEqual(
    frame.subarray(5),
    referenceRequest(
      [referenceSpan(), referenceSpan()],
      { attributes: [{ key: 'service.name', value: { stringValue: 'test' } }] },
      { name: 'microtel', version: '0' },
    ),
  );
});

test('export response decoder accepts partial success and rejects malformed protobuf', () => {
  const { decodeResponse } = require('../lib/otlp');
  const bytes = Response.encode(
    Response.fromObject({
      partialSuccess: {
        rejectedSpans: '9007199254740993',
        errorMessage: 'rejected',
      },
    }),
  ).finish();
  assert.deepEqual(decodeResponse(bytes), {
    rejectedSpans: 9007199254740993n,
    errorMessage: 'rejected',
  });
  assert.deepEqual(decodeResponse(Buffer.alloc(0)), {
    rejectedSpans: 0n,
    errorMessage: '',
  });
  for (const malformed of [[10, 20], [8, 128], [0], [15], [10, 2, 8, 128]]) {
    assert.throws(() => decodeResponse(Buffer.from(malformed)), /protobuf/);
  }
});

test('encoder validates IDs, integer range and maximum payload before allocating', () => {
  const { OtlpEncoder } = require('../lib/otlp');
  const encoder = new OtlpEncoder(
    { attributes: [] },
    { name: 'test', version: '0' },
  );
  assert.throws(
    () => encoder.encode([{ ...makeSpan(), traceId: 'bad' }]),
    /traceId/,
  );
  assert.throws(
    () =>
      encoder.encode([
        { ...makeSpan(), getAttributes: () => ({ bad: Number.MAX_VALUE }) },
      ]),
    /integer/,
  );
  assert.throws(
    () =>
      encoder.encode([{ ...makeSpan(), name: 'x'.repeat(16 * 1024 * 1024) }]),
    /size/,
  );
});

test('encoder can discard a malformed span without losing the rest of the batch', () => {
  const { OtlpEncoder } = require('../lib/otlp');
  const encoder = new OtlpEncoder(
    { attributes: [] },
    { name: 'test', version: '0' },
  );
  const errors = [];
  const frame = encoder.encode(
    [{ ...makeSpan(), traceId: 'bad' }, makeSpan()],
    (err) => errors.push(err),
  );
  assert.equal(errors.length, 1);
  assert.deepEqual(frame.subarray(5), referenceRequest([referenceSpan()]));
});

test('response decoder skips unknown fields and validates all wire boundaries', () => {
  const { decodeResponse } = require('../lib/otlp');
  // Unknown varint, fixed64, bytes, fixed32 fields before a known partial success.
  const unknown = Buffer.from([
    16, 1, 25, 0, 0, 0, 0, 0, 0, 0, 0, 34, 1, 99, 45, 0, 0, 0, 0,
  ]);
  assert.deepEqual(
    decodeResponse(Buffer.concat([unknown, Buffer.from([10, 2, 8, 3])])),
    { rejectedSpans: 3n, errorMessage: '' },
  );
  for (const invalid of [
    [17, 0],
    [21, 0],
    [8, ...Array(10).fill(128)],
    [10, 1, 0],
  ]) {
    assert.throws(() => decodeResponse(Buffer.from(invalid)), /protobuf/);
  }
});

test('OTLP sizes are computed explicitly before one exact-sized buffer allocation', (t) => {
  const { OtlpEncoder, measureSpan } = require('../lib/otlp');
  assert.equal(typeof measureSpan, 'function');
  const span = makeSpan();
  assert.equal(
    measureSpan(span),
    Span.encode(Span.fromObject(referenceSpan())).finish().length,
  );
  const encoder = new OtlpEncoder(
    { attributes: [] },
    { name: 'test', version: '0' },
  );
  const expectedPayload = referenceRequest([referenceSpan(), referenceSpan()]);
  const allocations = [];
  for (const method of [
    'alloc',
    'allocUnsafe',
    'allocUnsafeSlow',
    'from',
    'concat',
  ]) {
    const original = Buffer[method];
    t.mock.method(Buffer, method, (...args) => {
      allocations.push({ method, size: args[0] });
      const result = Reflect.apply(original, Buffer, args);
      // Make every unwritten byte visible to the independent byte-for-byte
      // comparison, rather than relying on zero-filled memory.
      if (method === 'allocUnsafe') result.fill(0xa5);
      return result;
    });
  }
  const size = encoder.byteLength([span, span]);
  assert.equal(size, expectedPayload.length);
  assert.deepEqual(allocations, [], 'sizing must not allocate any buffers');
  const buffer = encoder.encode([span, span]);
  t.mock.restoreAll();
  assert.equal(buffer.length, size + 5);
  assert.deepEqual(allocations, [{ method: 'allocUnsafe', size: size + 5 }]);
  assert.equal(buffer[0], 0);
  assert.equal(buffer.readUInt32BE(1), expectedPayload.length);
  assert.deepEqual(
    buffer.subarray(5),
    expectedPayload,
    'every output byte must match the independent protobufjs encoding',
  );
});

test('explicit sizing covers length and integer varint boundaries', () => {
  const { OtlpEncoder } = require('../lib/otlp');
  const encoder = new OtlpEncoder(
    { attributes: [] },
    { name: 'test', version: '0' },
  );
  for (const length of [1, 127, 128, 16383, 16384]) {
    const attrs = {
      false: false,
      zero: 0,
      empty: '',
      min: Number.MIN_SAFE_INTEGER,
      max: Number.MAX_SAFE_INTEGER,
      small: 127,
      larger: 128,
    };
    const span = {
      ...makeSpan(),
      name: 'x'.repeat(length),
      getAttributes: () => attrs,
    };
    const frame = encoder.encode([span]);
    assert.equal(frame.length, encoder.byteLength([span]) + 5);
    const expected = referenceSpan();
    expected.name = 'x'.repeat(length);
    expected.attributes = [
      { key: 'false', value: { boolValue: false } },
      { key: 'zero', value: { intValue: '0' } },
      { key: 'empty', value: { stringValue: '' } },
      { key: 'min', value: { intValue: '-9007199254740991' } },
      { key: 'max', value: { intValue: '9007199254740991' } },
      { key: 'small', value: { intValue: '127' } },
      { key: 'larger', value: { intValue: '128' } },
    ];
    assert.deepEqual(frame.subarray(5), referenceRequest([expected]));
  }
});

test('oversized requests are rejected without allocating an output buffer', (t) => {
  const { OtlpEncoder } = require('../lib/otlp');
  const encoder = new OtlpEncoder(
    { attributes: [] },
    { name: 'test', version: '0' },
  );
  const span = { ...makeSpan(), name: 'x'.repeat(16 * 1024 * 1024) };
  const allocations = [];
  for (const method of [
    'alloc',
    'allocUnsafe',
    'allocUnsafeSlow',
    'from',
    'concat',
  ]) {
    const original = Buffer[method];
    t.mock.method(Buffer, method, (...args) => {
      allocations.push(method);
      return Reflect.apply(original, Buffer, args);
    });
  }
  assert.throws(() => encoder.encode([span]), /size/);
  t.mock.restoreAll();
  assert.deepEqual(allocations, []);
});

test('sizing rejects invalid timestamps before writing and isolates malformed spans', () => {
  const { OtlpEncoder } = require('../lib/otlp');
  const encoder = new OtlpEncoder(
    { attributes: [] },
    { name: 'test', version: '0' },
  );
  const errors = [];
  const buffer = encoder.encode(
    [{ ...makeSpan(), startTime: NaN }, makeSpan()],
    (err) => errors.push(err),
  );
  assert.equal(errors.length, 1);
  assert.deepEqual(buffer.subarray(5), referenceRequest([referenceSpan()]));
});
