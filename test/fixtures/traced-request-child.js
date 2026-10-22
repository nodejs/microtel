'use strict';

// Spawned with JSON init options as argv[2]: activates tracing, serves one
// traced request from its own HTTP server, flushes, and exits. Used by
// tests that assert on the payloads reaching the collector.

const { init, flush } = require(process.env.MICROTEL_PATH);
const http = require('node:http');

init(JSON.parse(process.argv[2]));

const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end('ok');
});
server.listen(0, '127.0.0.1', () => {
  const port = server.address().port;
  http.get(`http://127.0.0.1:${port}/svc`, (res) => {
    res.resume();
    res.on('end', () => {
      flush();
      server.close(() => {
        http.globalAgent.destroy();
        console.log('done');
      });
    });
  });
});
