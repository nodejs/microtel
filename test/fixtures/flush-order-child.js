'use strict';

// Spawned with JSON init options as argv[2]: buffers one span, calls
// flush() twice without awaiting the first, and awaits the second. The
// second must wait for the export the first started, so the printed
// order proves it.

const { init, flush } = require(process.env.MICROTEL_PATH);
const http = require('node:http');

init(JSON.parse(process.argv[2]));

http
  .get('http://127.0.0.1:1/', () => {})
  .on('error', async () => {
    const order = [];
    const first = flush();
    const second = flush();
    first.then(() => order.push('first'));
    await second;
    order.push('second');
    console.log(order.join(' '));
  });
