'use strict';

// Spawned by test/test-init.js with an array of JSON init option
// sets as argv[2] (each is passed to init() in order, so a second entry
// exercises that a second init() is a no-op) and an optional module list
// as argv[3] (reports which modules the filter and exclude options leave
// enabled).

const { init, isActive } = require(process.env.MICROTEL_PATH);
const { getEndpoint, isModuleEnabled } = require(
  process.env.MICROTEL_PATH + '/lib/core',
);

for (const options of JSON.parse(process.argv[2])) init(options);

console.log(`active:${isActive()}`);
console.log(`endpoint:${getEndpoint()}`);
if (process.argv[3] !== undefined) {
  for (const moduleName of process.argv[3].split(','))
    console.log(`${moduleName}:${isModuleEnabled(moduleName)}`);
}
