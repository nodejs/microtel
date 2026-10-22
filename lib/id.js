'use strict';

const { randomFillSync } = require('node:crypto');

// A 4KB buffer of random bytes, refilled when exhausted (once every ~170
// spans: 16 bytes per trace ID, 8 per span ID), amortizes the CSPRNG cost.
// The CSPRNG stays: the W3C Trace Context spec recommends unpredictable
// IDs, and they are visible in outgoing requests. benchmark/ tracks the
// per-request overhead.
const kBufferSize = 4096;
const randomBuffer = new Uint8Array(kBufferSize);
let randomOffset = kBufferSize; // Start at end to trigger first fill

const hexTable = new Array(256);
for (let i = 0; i < 256; i++) hexTable[i] = i.toString(16).padStart(2, '0');

function ensureRandomBytes(needed) {
  if (randomOffset + needed > kBufferSize) {
    randomFillSync(randomBuffer);
    randomOffset = 0;
  }
}

function generateId(bytes) {
  ensureRandomBytes(bytes);
  let id = '';
  for (let i = 0; i < bytes; i++) id += hexTable[randomBuffer[randomOffset++]];
  return id;
}

const generateTraceId = () => generateId(16);
const generateSpanId = () => generateId(8);

module.exports = {
  generateTraceId,
  generateSpanId,
};
