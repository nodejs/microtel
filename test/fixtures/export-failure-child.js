'use strict';

// Spawned with JSON init options as argv[2]: fakes http.request so each
// export callback can be made to throw, then prints the sites that
// reported a failure and any failure that got past its guard.

const { EventEmitter } = require('node:events');
const http = require('node:http');

const { init, flush } = require(process.env.MICROTEL_PATH);
const { Span, SPAN_KIND_INTERNAL } = require(
  `${process.env.MICROTEL_PATH}/lib/span`,
);

init(JSON.parse(process.argv[2]));

const warnings = [];
const escaped = [];
const uncaught = [];

process.on('warning', (w) => {
  if (w.name === 'OTelInstrumentationWarning') warnings.push(w.message);
});
process.on('uncaughtException', (err) => uncaught.push(`${err}`));

const realEmitWarning = process.emitWarning;
process.emitWarning = function (warning, type, ...rest) {
  if (type === 'OTelExportWarning') throw new Error('export warning boom');
  return realEmitWarning.call(this, warning, type, ...rest);
};

// Both throttles read Date.now(), so moving it gives each site its own
// warning.
const realDateNow = Date.now;
let clockOffset = 0;
Date.now = () => realDateNow() + clockOffset;

const requests = [];
http.request = (options, onResponse) => {
  const req = new EventEmitter();
  req.end = () => {};
  req.destroy = () => {
    if (req === requests[0].req) throw new Error('destroy boom');
  };
  requests.push({ req, onResponse });
  return req;
};

// The sites whose flush() resolved. A guard that caught a failure before
// the export settled would leave its flush() waiting.
const settled = [];
const startExport = (site) => {
  new Span('export', SPAN_KIND_INTERNAL).end();
  flush().then(() => settled.push(site));
  return requests.at(-1);
};

const response = (statusCode, resume = () => {}) =>
  Object.assign(new EventEmitter(), { statusCode, resume });

// A throw that reaches here got past its guard.
const trigger = (site, fn) => {
  clockOffset += 31_000;
  try {
    fn();
  } catch {
    escaped.push(site);
  }
};

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitForWarnings = async (count) => {
  for (let i = 0; i < 50 && warnings.length < count; i++) await delay(100);
};

async function main() {
  // Nothing answers, so the deadline fires and destroy() throws.
  startExport('export timeout');
  await waitForWarnings(1);

  trigger('export response', () => {
    const { onResponse } = startExport('export response');
    onResponse(
      response(200, () => {
        throw new Error('resume boom');
      }),
    );
  });
  trigger('export response end', () => {
    const { onResponse } = startExport('export response end');
    const res = response(500);
    onResponse(res);
    res.emit('end');
  });
  trigger('export response error', () => {
    const { onResponse } = startExport('export response error');
    const res = response(200);
    onResponse(res);
    res.emit('error', new Error('reset'));
  });
  trigger('export request error', () => {
    const { req } = startExport('export request error');
    req.emit('error', new Error('refused'));
  });

  await waitForWarnings(5);
  for (let i = 0; i < 50 && settled.length < 5; i++) await delay(100);
  console.log(JSON.stringify({ warnings, escaped, uncaught, settled }));
}

main();
