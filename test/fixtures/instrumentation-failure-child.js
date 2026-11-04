'use strict';

// Spawned with JSON init options as argv[2]: makes microtel's span
// methods and serialization throw, then writes its results at exit, after
// the beforeExit flush has run.

const fs = require('node:fs');
const http = require('node:http');
const http2 = require('node:http2');

const { init } = require(process.env.MICROTEL_PATH);
const { Span } = require(`${process.env.MICROTEL_PATH}/lib/span`);
const { addSpan } = require(`${process.env.MICROTEL_PATH}/lib/flush`);

init(JSON.parse(process.argv[2]));

const warnings = [];
const details = [];
const uncaught = [];
let completed = 0;
let injected = 0;

process.on('warning', (w) => {
  if (w.name !== 'OTelInstrumentationWarning') return;
  warnings.push(w.message);
  details.push(w.detail);
});
process.on('uncaughtException', (err) => uncaught.push(`${err}`));
process.on('exit', () => {
  const result = { completed, injected, warnings, details, uncaught };
  fs.writeSync(1, `${JSON.stringify(result)}\n`);
});

// Counts each failure a guard should catch.
const boom = (what) => {
  injected++;
  throw new Error(`${what} boom`);
};

// Moving the clock past the warning window gives the next failure a
// warning of its own.
const realDateNow = Date.now;
let clockOffset = 0;
Date.now = () => realDateNow() + clockOffset;
const nextWindow = () => (clockOffset += 31_000);

// flush() catches a span that fails to serialize and names it in an
// export warning, so a throwing name getter escapes flush() itself.
const poisonedSpan = () => ({
  get name() {
    return boom('flush');
  },
  getAttributes() {
    throw new Error('serialize boom');
  },
});

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitForWarnings = async (count) => {
  for (let i = 0; i < 50 && warnings.length < count; i++) await delay(100);
};

const httpGet = (url) =>
  new Promise((resolve) => {
    http
      .get(url, (res) => {
        res.resume();
        res.on('end', resolve);
      })
      .on('error', resolve);
  }).then(() => completed++);

// The body must be read, so the response 'end' and 'close' listeners
// run.
const fetchRequest = (url) =>
  fetch(url)
    .then((res) => res.text())
    .catch(() => {})
    .then(() => completed++);

const http2Get = (port, path) =>
  new Promise((resolve) => {
    const session = http2.connect(`http://127.0.0.1:${port}`);
    session.on('error', () => {});
    const stream = session.request({ ':path': path });
    stream.on('error', () => {});
    stream.on('response', () => stream.resume());
    stream.on('close', () => {
      session.close();
      resolve();
    });
  }).then(() => completed++);

async function main() {
  const server = http.createServer((req, res) => {
    if (req.url === '/abort') return res.destroy();
    res.end('ok');
  });
  const h2server = http2.createServer();
  h2server.on('stream', (stream, headers) => {
    stream.on('error', () => {});
    if (headers[':path'] === '/destroy')
      return stream.destroy(new Error('stream boom'));
    stream.respond({ ':status': 200 });
    stream.end('ok');
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  await new Promise((resolve) => h2server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const h2port = h2server.address().port;

  // Attribute writes throw, so each protocol's start handlers fail.
  const realSetAttribute = Span.prototype.setAttribute;
  Span.prototype.setAttribute = () => boom('setAttribute');
  Span.prototype.end = () => boom('end');
  await httpGet(`${url}/one`);
  await http2Get(h2port, '/two');
  await fetchRequest(`${url}/three`);

  // Spans now start, and the handlers that end them fail. The aborted
  // requests reach the error channels.
  Span.prototype.setAttribute = realSetAttribute;
  await httpGet(`${url}/four`);
  await fetchRequest(`${url}/five`);
  await httpGet(`${url}/abort`);
  await fetchRequest(`${url}/abort`);
  await http2Get(h2port, '/six');
  await http2Get(h2port, '/destroy');

  // The response handlers that only set attributes fail on the status
  // code they record.
  Span.prototype.setAttribute = function (key, value) {
    if (key === 'http.response.status_code') return boom('setAttribute');
    return realSetAttribute.call(this, key, value);
  };
  await http2Get(h2port, '/seven');
  await httpGet(`${url}/eight`);
  await fetchRequest(`${url}/nine`);

  server.close();
  h2server.close();
  http.globalAgent.destroy();

  // The flush timer's flush() throws.
  nextWindow();
  addSpan(poisonedSpan());
  await waitForWarnings(2);

  // A full buffer's deferred flush() throws. maxBufferSize is 2.
  nextWindow();
  addSpan(poisonedSpan());
  addSpan(poisonedSpan());
  await waitForWarnings(3);

  // The beforeExit flush() throws once nothing else is left to run.
  nextWindow();
  addSpan(poisonedSpan());
}

main();
