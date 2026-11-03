'use strict';

// Spawned with JSON init options as argv[2]: makes a fetch whose span
// carries a tracestate and baggage, and prints the header names microtel
// passed to addHeader() and the trace headers the fetch target received.

const dc = require('node:diagnostics_channel');
const http = require('node:http');
const { init, flush } = require(process.env.MICROTEL_PATH);

const added = [];
// Subscribed before init(), so this runs ahead of microtel's handler.
dc.subscribe('undici:request:create', ({ request }) => {
  const addHeader = request.addHeader;
  request.addHeader = function (name, value) {
    added.push(name);
    return addHeader.call(this, name, value);
  };
});

init(JSON.parse(process.argv[2]));

let received;
const target = http.createServer((req, res) => {
  const { traceparent, tracestate, baggage } = req.headers;
  received = { traceparent, tracestate, baggage };
  res.end('ok');
});
const frontend = http.createServer(async (req, res) => {
  const fetched = await fetch(`http://127.0.0.1:${target.address().port}/`);
  await fetched.text();
  res.end('ok');
});

const listen = (server) =>
  new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

(async () => {
  await listen(target);
  await listen(frontend);
  await new Promise((resolve) =>
    http.get(
      `http://127.0.0.1:${frontend.address().port}/`,
      {
        headers: {
          traceparent:
            '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
          tracestate: 'rojo=00f067aa0ba902b7',
          baggage: 'user=alice',
        },
      },
      (res) => {
        res.resume();
        res.on('end', resolve);
      },
    ),
  );
  flush();
  frontend.close();
  target.close();
  http.globalAgent.destroy();
  console.log(JSON.stringify({ added, received }));
})();
