'use strict';

const path = require('node:path');
const { appendFileSync } = require('node:fs');
const { buildSync } = require('esbuild');

const { metafile } = buildSync({
  entryPoints: [path.join(__dirname, '..', 'index.js')],
  outfile: path.join(__dirname, '..', 'dist', 'microtel.js'),
  bundle: true,
  metafile: true,
  platform: 'node',
  format: 'cjs',
  // Function and class names stay observable, as in the unbundled source.
  keepNames: true,
  // js2c stores ASCII sources as one-byte strings, so non-ASCII
  // characters are escaped rather than emitted as UTF-8.
  charset: 'ascii',
  logLevel: 'warning',
});

if (process.argv.includes('--summary')) {
  const formatSize = (bytes) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(2)} KiB`;
    return `${(bytes / 1024 ** 2).toFixed(2)} MiB`;
  };
  const summary = ['## Build size', ''];
  for (const [file, output] of Object.entries(metafile.outputs)) {
    summary.push(
      `### ${file}: ${formatSize(output.bytes)}`,
      '',
      '| Input | Size in bundle | Share of bundle |',
      '| --- | ---: | ---: |',
    );
    for (const [input, { bytesInOutput }] of Object.entries(output.inputs).sort(
      (a, b) => b[1].bytesInOutput - a[1].bytesInOutput,
    )) {
      summary.push(
        `| ${input} | ${formatSize(bytesInOutput)} | ${((bytesInOutput / output.bytes) * 100).toFixed(2)}% |`,
      );
    }
    summary.push('');
  }
  const report = summary.join('\n');
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, report);
  } else {
    process.stdout.write(report);
  }
}
