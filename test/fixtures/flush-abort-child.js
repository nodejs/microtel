'use strict';

// Spawned with JSON init options as argv[2]: buffers one span, flushes
// with an abort signal, and tells the collector through raw release
// requests (which the HTTP client instrumentation does not trace) when
// to answer the export. The printed order proves the flush rejected
// while the export was still in flight, and that a later flush still
// waits for that export.

const net = require('node:net');
const http = require('node:http');
const { getEventListeners } = require('node:events');
const { init, flush } = require(process.env.MICROTEL_PATH);

const config = JSON.parse(process.argv[2]);
const port = new URL(config.endpoint).port;

function rawRelease(port, path) {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.end(
        `GET ${path} HTTP/1.1\r\n` +
          `Host: 127.0.0.1\r\n` +
          `Connection: close\r\n` +
          `\r\n`,
      );
      socket.on('data', () => {});
      socket.on('end', resolve);
    });
  });
}

init(config);

http
  .get('http://127.0.0.1:1/', () => {})
  .on('error', async () => {
    const controller = new AbortController();
    const order = [];
    const rejected = flush({ signal: controller.signal }).then(
      () => 'resolved',
      (err) => `rejected ${err.name} ${err.code}`,
    );

    // The response proves the export has reached the collector, so the
    // abort below finds it in flight.
    await rawRelease(port, '/release-1');
    controller.abort();
    order.push(await rejected);
    order.push(
      `listeners ${getEventListeners(controller.signal, 'abort').length}`,
    );
    // A flush started after the abort still waits for the held export: it
    // is pending a turn later, and settles once the export is answered.
    let later = 'pending';
    const second = flush().then(() => (later = 'settled'));
    await new Promise((resolve) => setImmediate(resolve));
    order.push(`second flush ${later}`);
    await rawRelease(port, '/release-2');
    await second;
    order.push(`second flush ${later}`);
    console.log(order.join('\n'));
  });
