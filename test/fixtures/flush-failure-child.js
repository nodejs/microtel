'use strict';

// Spawned with JSON init options as argv[2]: buffers one span from a
// failed request, then awaits flush(). The flush must resolve once the
// export fails or times out, never reject, so printing proves it.

const { init, flush } = require(process.env.MICROTEL_PATH);
const http = require('node:http');

init(JSON.parse(process.argv[2]));

http
  .get('http://127.0.0.1:1/', () => {})
  .on('error', async () => {
    await flush();
    console.log('flush resolved');
  });
