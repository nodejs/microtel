'use strict';

const { bench } = require('node:bench');
const { generateSpanId, generateTraceId } = require('../lib/id');

const kValuesPerSample = 100_000;

// The check setHeader applies to a header value. It flattens any string
// built by concatenation, so how an ID was built shows up here too.
const kInvalidHeaderChar = /[^\t\x20-\x7e\x80-\xff]/;

bench('IDs into a traceparent value', { samples: 30 }, (b) => {
  let invalid = 0;
  b.start();
  for (let i = 0; i < kValuesPerSample; i++) {
    const value = `00-${generateTraceId()}-${generateSpanId()}-01`;
    if (kInvalidHeaderChar.test(value)) invalid++;
  }
  b.end(kValuesPerSample);
  if (invalid !== 0) throw new Error(`${invalid} invalid traceparent values`);
});
