'use strict';

const { Buffer } = require('node:buffer');
const { randomFillSync } = require('node:crypto');

// A 4KB buffer of random bytes, refilled when exhausted (once every ~170
// spans: 16 bytes per trace ID, 8 per span ID), amortizes the CSPRNG cost.
// The CSPRNG stays: the W3C Trace Context spec recommends unpredictable
// IDs, and they are visible in outgoing requests. benchmark/ tracks the
// per-request overhead.
//
// IDs are slices of a hex string that encodes one chunk of the buffer.
// V8 makes a slice this long a view into that string rather than a copy,
// so one native call encodes the IDs for about five spans. A view keeps
// its whole string alive, though, and a span can outlive its request in
// AsyncLocalStorage, so the chunk is kept small. A span's two IDs pin at
// most two chunk strings.
const kBufferSize = 4096;
const kChunkSize = 128;
const randomBuffer = Buffer.allocUnsafeSlow(kBufferSize);
let randomOffset = kBufferSize; // Start at end to trigger first fill
let hexChunk = '';
let hexOffset = 0;

function generateId(bytes) {
  const chars = 2 * bytes;
  if (hexOffset + chars > hexChunk.length) {
    if (randomOffset === kBufferSize) {
      randomFillSync(randomBuffer);
      randomOffset = 0;
    }
    hexChunk = randomBuffer.toString(
      'hex',
      randomOffset,
      randomOffset + kChunkSize,
    );
    randomOffset += kChunkSize;
    hexOffset = 0;
  }
  const start = hexOffset;
  hexOffset += chars;
  return hexChunk.slice(start, hexOffset);
}

const generateTraceId = () => generateId(16);
const generateSpanId = () => generateId(8);

module.exports = {
  generateTraceId,
  generateSpanId,
};
