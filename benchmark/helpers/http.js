'use strict';

// Shared machinery for the HTTP and fetch benchmarks. Each .bench.js file
// runs in its own child process and tracing activates once per process,
// so the traced and untraced benchmarks live in separate files that each
// register one benchmark through this helper.

const { after, before, bench } = require('node:bench');
const http = require('node:http');
const microtel = require('../../index');

const listen = (server) =>
  new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const close = (server) => new Promise((resolve) => server.close(resolve));

// Starts, when tracing, a dummy collector: the measurement then covers
// span creation, serialization, and the export round trip. A sampleRatio
// of 0 traces requests without exporting anything, so it measures the
// work a request that only propagates its context pays for.
async function startCollector({ tracing, sampleRatio }) {
  if (!tracing) return null;

  const collector = http.createServer((req, res) => {
    req.resume();
    res.end();
  });
  await listen(collector);
  microtel.init({
    endpoint: `http://127.0.0.1:${collector.address().port}`,
    sampleRatio,
  });
  return collector;
}

// Starts the local target server the benchmark load is sent to.
async function startTargetServer() {
  const server = http.createServer((req, res) => {
    res.end('ok');
  });
  await listen(server);
  return server;
}

// Sets up a local target server, a keep-alive agent for the load, and,
// when tracing, a dummy collector.
async function setup({ tracing = false, sampleRatio } = {}) {
  const collector = await startCollector({ tracing, sampleRatio });
  const server = await startTargetServer();

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
function registerHttpBenchmark(name, { tracing = false, sampleRatio } = {}) {
  const kRequestsPerSample = 200;

  let ctx;

  before(async () => {
    ctx = await setup({ tracing, sampleRatio });
  });

  after(() => ctx.close());

  bench(name, { samples: 30 }, async (b) => {
    b.start();
    for (let i = 0; i < kRequestsPerSample; i++) await ctx.request();
    b.end(kRequestsPerSample);
  });
}

// Registers one fetch() benchmark. fetch() pools connections through
// undici's global dispatcher, so no agent is built; the same batch size
// and sample count keep the numbers comparable with the HTTP benchmark.
// Requests are sequential over the pooled connection, so the
// traced/untraced difference reflects per-request work (two spans per
// request), not scheduling or connection noise.
function registerFetchBenchmark(name, { tracing = false, sampleRatio } = {}) {
  const kRequestsPerSample = 200;

  let server;
  let collector;
  let url;

  before(async () => {
    collector = await startCollector({ tracing, sampleRatio });
    server = await startTargetServer();
    url = `http://127.0.0.1:${server.address().port}/bench`;
  });

  after(async () => {
    await close(server);
    if (collector != null) await close(collector);
  });

  bench(name, { samples: 30 }, async (b) => {
    b.start();
    for (let i = 0; i < kRequestsPerSample; i++) {
      // The response body is fully consumed, so one iteration covers the
      // complete request.
      const res = await fetch(url);
      await res.arrayBuffer();
    }
    b.end(kRequestsPerSample);
  });
}

module.exports = {
  registerFetchBenchmark,
  registerHttpBenchmark,
};
