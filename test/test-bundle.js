'use strict';

const assert = require('node:assert');
const path = require('node:path');
const { test } = require('node:test');

const {
  fixture,
  startOTelCollector,
  getSpans,
  getServerSpan,
  spanAttrs,
  spawnMicrotel,
} = require('./common/otel');

// Built by `npm run build`, which `npm test` runs first.
const bundle = path.join(__dirname, '..', 'dist', 'microtel.js');

test('the bundle exports the package API and traces requests', async () => {
  assert.deepStrictEqual(
    Object.keys(require(bundle)),
    Object.keys(require('..')),
  );

  const collector = await startOTelCollector();
  const { code, stdout } = await spawnMicrotel(
    [
      fixture('traced-request-child.js'),
      JSON.stringify({ endpoint: `http://127.0.0.1:${collector.port}` }),
    ],
    { MICROTEL_PATH: bundle },
  );
  assert.strictEqual(code, 0);
  assert.match(stdout, /done/);

  const payload = await collector.next();
  await collector.close();

  const { version } = require('../package.json');
  assert.strictEqual(
    spanAttrs(payload.resourceSpans[0].resource)['telemetry.sdk.version'],
    version,
  );
  assert.ok(getServerSpan(getSpans(payload), '/svc'));
});
