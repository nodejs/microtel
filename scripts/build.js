'use strict';

const path = require('node:path');
const { buildSync } = require('esbuild');

buildSync({
  entryPoints: [path.join(__dirname, '..', 'index.js')],
  outfile: path.join(__dirname, '..', 'dist', 'microtel.js'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  // Function and class names stay observable, as in the unbundled source.
  keepNames: true,
  // js2c stores ASCII sources as one-byte strings, so non-ASCII
  // characters are escaped rather than emitted as UTF-8.
  charset: 'ascii',
  logLevel: 'warning',
});
