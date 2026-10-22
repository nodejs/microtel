'use strict';

// Spawned with JSON init options as argv[2]: activates tracing, makes one
// traced request, and exits without an explicit flush. The beforeExit
// handler must flush the buffered spans.

const { init } = require(process.env.MICROTEL_PATH);
const http = require('node:http');

init(JSON.parse(process.argv[2]));

const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end('ok');
});
server.listen(0, () => {
  http.get(`http://127.0.0.1:${server.address().port}/test`, (res) => {
    res.resume();
    res.on('end', () => {
      server.close(() => http.globalAgent.destroy());
    });
  });
});
