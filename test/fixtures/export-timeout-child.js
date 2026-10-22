'use strict';

// Spawned with JSON init options as argv[2]: buffers one span and exits.
// The pending export to the unresponsive collector must time out and the
// process must still exit.

const { init } = require(process.env.MICROTEL_PATH);
const http = require('node:http');

init(JSON.parse(process.argv[2]));

http.get('http://127.0.0.1:1/', () => {}).on('error', () => {});
