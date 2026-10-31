'use strict';

const assert = require('node:assert');
const { describe, it } = require('node:test');

const { generateTraceId, generateSpanId } = require('../lib/id');

describe('otel ID generation buffer refill', () => {
  // The random buffer is 4096 bytes. Each trace ID uses 16 bytes and each
  // span ID 8 bytes, so generating enough IDs forces at least one refill.
  const cases = [
    ['trace', generateTraceId, 32, 300],
    ['span', generateSpanId, 16, 600],
  ];

  for (const [name, generate, idLength, count] of cases) {
    it(`generates valid ${name} IDs after exhausting the random buffer`, () => {
      const ids = new Set();
      for (let i = 0; i < count; i++) {
        const id = generate();
        assert.strictEqual(id.length, idLength);
        assert.match(id, new RegExp(`^[0-9a-f]{${idLength}}$`));
        ids.add(id);
      }
      assert.strictEqual(ids.size, count);
    });
  }

  it('never reuses random bytes when trace and span IDs interleave', () => {
    // A trace ID that does not fit the rest of a chunk starts a new one,
    // so every 8-byte piece of every ID must be distinct.
    const pieces = new Set();
    let total = 0;
    for (let i = 0; i < 1000; i++) {
      const id = i % 3 === 0 ? generateSpanId() : generateTraceId();
      for (let j = 0; j < id.length; j += 16, total++)
        pieces.add(id.slice(j, j + 16));
    }
    assert.strictEqual(pieces.size, total);
  });
});
