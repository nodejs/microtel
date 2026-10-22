'use strict';

// Spawned with JSON init options as argv[2], where the endpoint carries a
// path: makes one traced request, an untraced-path request to the same
// collector authority, and two flushes. The first export exercises the
// self-trace suppression at the collector's export path; the second
// would carry any self-traced span.

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
      // A legitimate request to the collector's authority, but not to its
      // export path: it must still be traced.
      http.get(`http://127.0.0.1:${process.argv[3]}/health`, (healthRes) => {
        healthRes.resume();
        healthRes.on('end', () => {
          setTimeout(() => {
            flush();
            setTimeout(() => {
              flush();
              setTimeout(() => {
                server.close(() => http.globalAgent.destroy());
              }, 200);
            }, 200);
          }, 50);
        });
      });
    });
  });
});
