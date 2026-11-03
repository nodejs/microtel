'use strict';

// Spawned with JSON init options as argv[2]: activates tracing, mutates
// the options object to prove init copied the resource attributes, serves
// two traced requests from its own HTTP server with a flush after each,
// and exits.

const { init, flush } = require(process.env.MICROTEL_PATH);
const http = require('node:http');

const options = JSON.parse(process.argv[2]);
init(options);
options.resourceAttributes ??= {};
options.resourceAttributes['service.version'] = 'mutated';

const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end('ok');
});
server.listen(0, '127.0.0.1', async () => {
  const port = server.address().port;
  for (const path of ['/one', '/two']) {
    await new Promise((resolve) => {
      http.get(`http://127.0.0.1:${port}${path}`, (res) => {
        res.resume();
        res.on('end', resolve);
      });
    });
    flush();
  }
  server.close(() => {
    http.globalAgent.destroy();
    console.log('done');
  });
});
