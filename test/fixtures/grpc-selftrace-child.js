'use strict';

const assert = require('node:assert/strict');
const http2 = require('node:http2');
const otel = require(process.env.MICROTEL_PATH);
const { Span } = require(process.env.MICROTEL_PATH + '/lib/span');
let exportsReceived = 0;
const server = http2.createServer();
server.on('stream', (stream) => {
  stream.resume();
  stream.on('end', () => {
    exportsReceived++;
    stream.respond(
      { ':status': 200, 'content-type': 'application/grpc' },
      { waitForTrailers: true },
    );
    stream.on('wantTrailers', () =>
      stream.sendTrailers({ 'grpc-status': '0' }),
    );
    stream.end(Buffer.from([0, 0, 0, 0, 0]));
    // Keep the collector alive beyond the next periodic flush. An export
    // span would otherwise cause a loop of requests to this same server.
    setTimeout(() => {
      assert.equal(exportsReceived, 1);
      server.close();
      stream.session?.close();
    }, 100);
  });
});
server.listen(0, '127.0.0.1', () => {
  otel.init({
    protocol: 'grpc',
    endpoint: `http://127.0.0.1:${server.address().port}`,
    flushInterval: 10,
  });
  new Span('seed', 1).end();
  otel.flush();
});
