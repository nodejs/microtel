'use strict';

// Spawned with JSON init options as argv[2]: activates tracing at a
// sampleRatio of 0, then drives one sampled and one unsampled request
// through an HTTP frontend, an unsampled fetch, and an unsampled HTTP/2
// stream. The inbound requests go over raw sockets and an HTTP/2 session,
// so the incoming trace flags are under the test's control. Prints what
// each backend hop saw, and the listener counts around the frontend's
// responses, as one JSON line.

const dc = require('node:diagnostics_channel');
const http = require('node:http');
const http2 = require('node:http2');
const net = require('node:net');

const { init, flush } = require(process.env.MICROTEL_PATH);
const { kSpan } = require(`${process.env.MICROTEL_PATH}/lib/span`);

init(JSON.parse(process.argv[2]));

// Subscribed after init(), so these run after microtel's handlers and see
// whether they stashed a span for the export-only handlers to find.
const stashed = {};
dc.subscribe('http2.server.stream.start', ({ stream, headers }) => {
  stashed[headers[':path']] = stream[kSpan] !== undefined;
});
dc.subscribe('undici:request:create', ({ request }) => {
  stashed[request.path] = request[kSpan] !== undefined;
});

const listen = (server) =>
  new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

// What each backend hop received, keyed by request path.
const saw = {};
// Listener counts on the frontend's responses, keyed by request path.
// Plain node leaves no 'close' listener on a server response and no
// 'end' or 'close' listener on a client response, so microtel's own
// listeners are the whole difference.
const listeners = {};

let backendPort;

const backend = http.createServer((req, res) => {
  saw[req.url] = {
    traceparent: req.headers.traceparent,
    tracestate: req.headers.tracestate,
    baggage: req.headers.baggage,
  };
  res.end('ok');
});

// The frontend records its listener counts, then forwards to the backend
// carrying stale propagation headers that the span's own context, or its
// absence, must replace.
const frontend = http.createServer((req, res) => {
  listeners[req.url] = { serverClose: res.listenerCount('close') };
  http.get(
    `http://127.0.0.1:${backendPort}${req.url}`,
    { headers: { tracestate: 'stale=yes', baggage: 'stale=yes' } },
    (clientRes) => {
      listeners[req.url].clientEnd = clientRes.listenerCount('end');
      listeners[req.url].clientClose = clientRes.listenerCount('close');
      clientRes.resume();
      clientRes.on('end', () => res.end('ok'));
    },
  );
});

// The HTTP/2 span is current while its stream is handled, so the request
// it makes carries the incoming trace ID.
const h2Frontend = http2.createServer();
h2Frontend.on('stream', (stream) => {
  http.get(`http://127.0.0.1:${backendPort}/h2-hop`, (res) => {
    res.resume();
    res.on('end', () => {
      stream.respond({ ':status': 200 });
      stream.end('ok');
    });
  });
});

function rawRequest(port, path, headers) {
  const lines = Object.entries(headers).map(
    ([name, value]) => `${name}: ${value}`,
  );
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write(
        `GET ${path} HTTP/1.1\r\n` +
          `Host: 127.0.0.1:${port}\r\n` +
          `${lines.join('\r\n')}\r\n` +
          `Connection: close\r\n` +
          `\r\n`,
      );
      socket.on('data', () => {});
      socket.on('end', resolve);
    });
  });
}

async function main() {
  await listen(backend);
  backendPort = backend.address().port;
  await listen(frontend);
  await listen(h2Frontend);

  const frontendPort = frontend.address().port;
  await rawRequest(frontendPort, '/sampled', {
    traceparent: `00-${'7'.repeat(32)}-0123456789abcdef-01`,
    tracestate: 'kept=yes',
    baggage: 'kept=yes',
  });
  await rawRequest(frontendPort, '/unsampled', {
    traceparent: `00-${'2'.repeat(32)}-0123456789abcdef-02`,
    tracestate: 'kept=yes',
    baggage: 'kept=yes',
  });

  const session = http2.connect(
    `http://127.0.0.1:${h2Frontend.address().port}`,
  );
  await new Promise((resolve) => {
    const stream = session.request({
      ':path': '/h2',
      traceparent: `00-${'3'.repeat(32)}-0123456789abcdef-02`,
    });
    stream.resume();
    stream.on('end', () => session.close(resolve));
  });

  await fetch(`http://127.0.0.1:${backendPort}/fetch`, {
    headers: { tracestate: 'stale=yes', baggage: 'stale=yes' },
  }).then((res) => res.arrayBuffer());

  backend.close();
  frontend.close();
  h2Frontend.close();
  http.globalAgent.destroy();
  flush();
  console.log(JSON.stringify({ saw, listeners, stashed }));
}

main();
