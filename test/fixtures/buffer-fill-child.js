'use strict';

// Spawned with JSON init options as argv[2]: issues traced requests to its
// own HTTP server until it is killed, so that buffer-fill flushes must
// happen while the process is still alive.

const { init } = require(process.env.MICROTEL_PATH);
const http = require('node:http');

init(JSON.parse(process.argv[2]));

const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end('ok');
});
server.listen(0, '127.0.0.1', () => {
  const port = server.address().port;
  let remaining = 12;
  function next() {
    if (remaining-- === 0) return;
    http
      .get(`http://127.0.0.1:${port}/fill`, () => next())
      .on('error', () => {});
  }
  next();
});
