'use strict';

// Spawned with JSON init options as argv[2] and a shape as argv[3]: makes
// the first read of request.headers return something other than a flat
// array of name and value pairs, so the undici instrumentation falls back
// to addHeader(), while every later read sees the real array, where the
// fallback lands the header. Subscribed before init() so this handler runs
// ahead of the instrumentation's.

const dc = require('node:diagnostics_channel');
const http = require('node:http');
const { init, flush } = require(process.env.MICROTEL_PATH);

// argv[3] picks what the first read returns: an object, or an array with an
// odd number of entries.
const first = process.argv[3] === 'odd' ? ['sentinel'] : {};

dc.subscribe('undici:request:create', ({ request }) => {
  const headers = request.headers;
  let reads = 0;
  Object.defineProperty(request, 'headers', {
    configurable: true,
    get: () => (reads++ === 0 ? first : headers),
  });
});

init(JSON.parse(process.argv[2]));

let traceparent;
const target = http.createServer((req, res) => {
  traceparent = req.headers.traceparent;
  res.writeHead(200);
  res.end('ok');
});

target.listen(0, '127.0.0.1', async () => {
  const res = await fetch(`http://127.0.0.1:${target.address().port}/down`);
  await res.text();
  flush();
  target.close(() => {
    console.log(traceparent === undefined ? 'none' : traceparent);
    console.log('done');
  });
});
