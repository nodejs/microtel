'use strict';

// Node rethrows an error from a diagnostics_channel subscriber or a timer
// as an uncaught exception, and one from an event listener skips the
// listeners after it. Every function microtel hands to Node goes through
// guard(), so a bug in microtel can't do either to the app it traces.

const kWarningThrottleMs = 30_000;

let failureCount = 0;
let lastWarningTime = 0;

// The warnings are throttled like export failures, so a bug that fires
// on every request can't flood the logs.
function warnInstrumentationFailure(name, err) {
  try {
    failureCount++;
    const now = Date.now();
    if (now - lastWarningTime < kWarningThrottleMs) return;
    lastWarningTime = now;
    const suffix = failureCount > 1 ? ` (${failureCount} total failures)` : '';
    process.emitWarning(
      `microtel ${name} handler failed: ${err?.message ?? err}${suffix}`,
      { type: 'OTelInstrumentationWarning', detail: err?.stack },
    );
  } catch {
    // Reporting a failure must not become a new failure.
  }
}

// Each wrapper is made once per handler, so a guarded call allocates
// nothing. A plain function keeps `this` for the response listeners.
function guard(name, handler) {
  return function () {
    try {
      handler.apply(this, arguments);
    } catch (err) {
      warnInstrumentationFailure(name, err);
    }
  };
}

module.exports = {
  guard,
  warnInstrumentationFailure,
};
