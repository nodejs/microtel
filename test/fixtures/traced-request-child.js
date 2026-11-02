'use strict';

// Spawned with JSON init options as argv[2]: activates tracing, serves one
// traced request from its own HTTP server, flushes, and exits. Used by
// tests that assert on the payloads reaching the collector.

const { init, flush } = require(process.env.MICROTEL_PATH);
const http = require('node:http');

const options = JSON.parse(process.argv[2]);
init(options);

// The headers were copied at init(), so mutations afterwards must not
// reach the export.
if (options.headers) {
  options.headers['x-api-key'] = 'mutated';
  options.headers['x-extra'] = 'added';
}

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
