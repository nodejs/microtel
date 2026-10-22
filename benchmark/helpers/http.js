'use strict';

// Shared machinery for the HTTP benchmarks. Each .bench.js file runs in
// its own child process and tracing activates once per process, so the
// traced and untraced benchmarks live in separate files that each
// register one benchmark through this helper.

const { after, before, bench } = require('node:bench');
const http = require('node:http');
const microtel = require('../../index');

const listen = (server) =>
  new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const close = (server) => new Promise((resolve) => server.close(resolve));

// Sets up a local target server, a keep-alive agent for the load, and,
// when tracing, a dummy collector: the measurement then covers span
// creation, serialization, and the export round trip.
async function setup({ tracing = false } = {}) {
  let collector = null;
  if (tracing) {
    collector = http.createServer((req, res) => {
      req.resume();
      res.end();
    });
    await listen(collector);
    microtel.init({ endpoint: `http://127.0.0.1:${collector.address().port}` });
  }

  const server = http.createServer((req, res) => {
    res.end('ok');
  });
  await listen(server);

  const port = server.address().port;
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });

  return {
    // One request over the shared connection, resolved when the response
    // body completes.
    request: () =>
      new Promise((resolve, reject) => {
        http
          .get({ host: '127.0.0.1', port, agent, path: '/bench' }, (res) => {
            res.resume();
            res.on('end', resolve);
          })
          .on('error', reject);
      }),
    async close() {
      agent.destroy();
      await close(server);
      if (collector != null) await close(collector);
    },
  };
}

// Registers one HTTP request benchmark. Requests are sequential over one
// keep-alive connection, so the traced/untraced difference reflects
// per-request work (two spans per request), not scheduling or connection
// noise.
function registerHttpBenchmark(name, { tracing = false } = {}) {
  const kRequestsPerSample = 200;

  let ctx;

  before(async () => {
    ctx = await setup({ tracing });
  });

  after(() => ctx.close());

  bench(name, { samples: 30 }, async (b) => {
    b.start();
    for (let i = 0; i < kRequestsPerSample; i++) await ctx.request();
    b.end(kRequestsPerSample);
  });
}

module.exports = {
  registerHttpBenchmark,
};
