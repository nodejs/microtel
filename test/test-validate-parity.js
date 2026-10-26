'use strict';

const assert = require('node:assert');
const path = require('node:path');
const { describe, it } = require('node:test');

const validate = require('../lib/validate');
const { runBattery } = require('./common/validate-battery');
const { fixture, spawnMicrotel } = require('./common/otel');

// lib/validate.js ports a subset of core's validators and error message
// builders. This test proves the port: the same battery runs through the
// port and through the real internals (a child under --expose-internals),
// and the outcomes must match down to the error messages. If core changes
// these formats, this test fails and the port needs updating.

describe('validate.js parity with node core', () => {
  it('matches internal/validators and internal/errors exactly', async () => {
    const { code, stdout, stderr } = await spawnMicrotel(
      ['--expose-internals', fixture('parity-child.js')],
      {
        BATTERY_MODULE: path.join(__dirname, 'common', 'validate-battery.js'),
      },
    );

    assert.strictEqual(code, 0, `child failed: ${stderr}`);

    const core = JSON.parse(stdout);
    const ported = runBattery(validate);

    // Normalize through JSON so values like undefined compare cleanly.
    const portedJson = JSON.parse(JSON.stringify(ported));

    assert.strictEqual(core.length, portedJson.length);
    for (let i = 0; i < portedJson.length; i++) {
      assert.deepStrictEqual(
        core[i],
        portedJson[i],
        `${portedJson[i].call} diverges from core`,
      );
    }
  });
});
