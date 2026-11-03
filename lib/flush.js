'use strict';

const { Buffer } = require('node:buffer');
const http = require('node:http');
const https = require('node:https');
const { hostname } = require('node:os');
const { addAbortListener } = require('node:events');
const { clearTimeout, setImmediate, setTimeout } = require('node:timers');

const { guard } = require('./guard');

const {
  getEndpoint,
  getExportHeaders,
  getExportUrl,
  getInstanceId,
  getResourceAttributes,
  getServiceName,
  getSdkName,
  getSdkVersion,
} = require('./core');
const { validateAbortSignal, validateObject } = require('./validate');

const kDefaultMaxBufferSize = 100;
const kDefaultFlushIntervalMs = 10_000;
const kDefaultExportTimeoutMs = 10_000;
const kWarningThrottleMs = 30_000;

// OTLP span flags hold the W3C trace flags in the low 8 bits. The next two
// bits say that whether the parent is remote is known, and that it is. The
// OpenTelemetry SDKs always know, so they always set the first.
const kSpanFlagsHasIsRemote = 0x100;
const kSpanFlagsIsRemote = 0x200;
// One keep-alive socket per protocol: batches queue behind it, bounding
// in-flight exports to a slow collector.
const kExportAgents = {
  __proto__: null,
  'http:': new http.Agent({ keepAlive: true, maxSockets: 1 }),
  'https:': new https.Agent({ keepAlive: true, maxSockets: 1 }),
};

let spanBuffer = [];
let flushTimer = null; // One-shot timer; only set while spans are buffered.
let flushScheduled = false; // A deferred flush is already scheduled.
let flushIntervalMs = kDefaultFlushIntervalMs;
let maxBufferSize = kDefaultMaxBufferSize;
let exportTimeoutMs = kDefaultExportTimeoutMs;
let exportFailureCount = 0;
let lastExportWarningTime = 0;
// Exports whose requests have not settled yet. flush() snapshots it so a
// later flush also waits for the exports an earlier one started.
const inFlightExports = new Set();

let cachedResource = null;
let cachedScope = null;

// A user value replaces microtel's default for the same key, so each key
// appears once. User keys microtel does not set are appended.
function buildResource() {
  const values = {
    __proto__: null,
    'service.name': getServiceName(),
    'service.instance.id': getInstanceId(),
    'host.name': hostname(),
    'telemetry.sdk.name': getSdkName(),
    'telemetry.sdk.language': 'nodejs',
    'telemetry.sdk.version': getSdkVersion(),
    'process.runtime.name': 'nodejs',
    'process.runtime.version': process.version,
    'process.pid': process.pid,
  };
  const userValues = getResourceAttributes();
  const keys = Object.keys(values);
  if (userValues != null) {
    for (const key of Object.keys(userValues)) {
      values[key] = userValues[key];
      // Keys microtel also sets are already in the list.
      if (!keys.includes(key)) keys.push(key);
    }
  }
  const attributes = [];
  for (let i = 0; i < keys.length; i++) {
    attributes.push({
      key: keys[i],
      value: encodeAttributeValue(values[keys[i]]),
    });
  }
  return { attributes };
}

function getResource() {
  cachedResource ??= buildResource();
  return cachedResource;
}

function getScope() {
  cachedScope ??= {
    name: getSdkName(),
    version: getSdkVersion(),
  };
  return cachedScope;
}

function encodeAttributeValue(value) {
  switch (typeof value) {
    case 'string':
      return { stringValue: value };
    // OTLP writes an int64 as a decimal string. Integers past the safe range
    // print in exponent form or lose their exact value, so they export as
    // doubles.
    case 'number':
      return Number.isSafeInteger(value)
        ? { intValue: String(value) }
        : { doubleValue: value };
    case 'boolean':
      return { boolValue: value };
    default:
      return { stringValue: String(value) };
  }
}

// Converts epoch milliseconds into an OTLP nanosecond string. Rounding
// to whole milliseconds first keeps the product exactly representable in
// double precision.
const timeToUnixNano = (t) => `${BigInt(Math.round(t)) * 1_000_000n}`;

function spanToOtlp(span) {
  // TODO(bengl): A lot of objects are created in here for all the atributes.
  // As a future optimization, we could hand-write the JSON encoding.
  const rawAttrs = span.getAttributes();
  const attrKeys = Object.keys(rawAttrs);
  const attributes = [];
  for (let i = 0; i < attrKeys.length; i++) {
    // Unused preallocated keys stay undefined and are skipped.
    if (rawAttrs[attrKeys[i]] === undefined) continue;
    attributes.push({
      key: attrKeys[i],
      value: encodeAttributeValue(rawAttrs[attrKeys[i]]),
    });
  }

  const rawEvents = span.getEvents();
  const events = [];
  for (let i = 0; i < rawEvents.length; i++) {
    const event = rawEvents[i];
    const eventAttrs = [];
    const eventAttrKeys = Object.keys(event.attributes);
    for (let j = 0; j < eventAttrKeys.length; j++) {
      if (event.attributes[eventAttrKeys[j]] === undefined) continue;
      eventAttrs.push({
        key: eventAttrKeys[j],
        value: encodeAttributeValue(event.attributes[eventAttrKeys[j]]),
      });
    }
    const otlpEvent = {
      name: event.name,
      timeUnixNano: timeToUnixNano(event.time),
    };
    if (eventAttrs.length > 0) otlpEvent.attributes = eventAttrs;
    events.push(otlpEvent);
  }

  const otlpSpan = {
    traceId: span.traceId,
    spanId: span.spanId,
    flags:
      span.traceFlags |
      kSpanFlagsHasIsRemote |
      (span.hasRemoteParent ? kSpanFlagsIsRemote : 0),
    name: span.name,
    kind: span.kind,
    startTimeUnixNano: timeToUnixNano(span.startTime),
    endTimeUnixNano: timeToUnixNano(span.endTime),
  };

  if (attributes.length > 0) otlpSpan.attributes = attributes;

  const status = span.status;
  if (status.code !== 0 || status.message) otlpSpan.status = status;

  if (span.parentSpanId) otlpSpan.parentSpanId = span.parentSpanId;

  if (span.tracestate) otlpSpan.traceState = span.tracestate;

  if (events.length > 0) otlpSpan.events = events;

  return otlpSpan;
}

function addSpan(span) {
  spanBuffer.push(span);
  if (spanBuffer.length >= maxBufferSize) {
    // Deferred so serialization does not run inside the request that
    // filled the buffer.
    if (!flushScheduled) {
      flushScheduled = true;
      setImmediate(guardedDeferredFlush);
    }
  } else if (flushTimer == null) {
    flushTimer = setTimeout(guardedTimerFlush, flushIntervalMs);
    flushTimer.unref();
  }
}

// Resolves once every export in the list has settled. It resolves
// rather than rejects even for export failures: they warn through
// warnExportFailure, and a rejection would surface as an unhandled
// rejection in every caller that ignores the return value.
function settleAll(pending) {
  if (pending.length === 0) return Promise.resolve();
  return Promise.all(pending).then(() => {});
}

// Node core builds its AbortError from an internal class this package
// cannot import, so flush() builds the same shape itself.
function abortError(signal) {
  const err = new Error('The operation was aborted', {
    cause: signal.reason,
  });
  err.code = 'ABORT_ERR';
  err.name = 'AbortError';
  return err;
}

// Starts an export of every buffered span and resolves once it and every
// export already in flight have settled.
function exportBuffered() {
  if (flushTimer != null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }

  // The returned promise covers exactly the spans buffered and the
  // exports in flight when flush() runs: spans ending later belong to a
  // later flush.
  const pending = [...inFlightExports];

  if (spanBuffer.length === 0 || getEndpoint() == null)
    return settleAll(pending);

  const spans = spanBuffer;
  spanBuffer = [];

  const otlpSpans = [];
  for (let i = 0; i < spans.length; i++) {
    try {
      otlpSpans.push(spanToOtlp(spans[i]));
    } catch (err) {
      warnExportFailure(
        `Failed to serialize span "${spans[i].name}": ${err.message}`,
      );
    }
  }

  if (otlpSpans.length === 0) return settleAll(pending);

  let payload;
  try {
    payload = JSON.stringify({
      resourceSpans: [
        {
          resource: getResource(),
          scopeSpans: [
            {
              scope: getScope(),
              spans: otlpSpans,
            },
          ],
        },
      ],
    });
  } catch (err) {
    warnExportFailure(
      `Failed to serialize ${otlpSpans.length} spans: ${err.message}`,
    );
    return settleAll(pending);
  }

  pending.push(sendToCollector(payload));
  return settleAll(pending);
}

function flush(options = { __proto__: null }) {
  validateObject(options, 'options');
  const { signal } = options;
  validateAbortSignal(signal, 'options.signal');

  // With a signal that has already aborted, the promise rejects before any
  // export starts, the way core's APIs check signal.aborted first. The
  // spans stay buffered for a later flush.
  if (signal?.aborted) return Promise.reject(abortError(signal));

  const settled = exportBuffered();
  if (signal === undefined) return settled;

  return new Promise((resolve, reject) => {
    // addAbortListener's listener runs even when an earlier listener stops
    // the event's propagation, as core's own abort listeners do.
    const listener = addAbortListener(signal, () => reject(abortError(signal)));
    // Aborting stops the waiting, not the export: the export it took
    // keeps running in the background, bounded by exportTimeout, and its
    // spans still reach the collector if it succeeds.
    settled.then(() => {
      listener[Symbol.dispose]();
      resolve();
    });
  });
}

function deferredFlush() {
  flushScheduled = false;
  flush();
}

const guardedDeferredFlush = guard('deferred flush', deferredFlush);
const guardedTimerFlush = guard('flush timer', flush);
// Node passes the exit code to beforeExit listeners, which flush() would
// reject as its options.
const guardedBeforeExitFlush = guard('beforeExit flush', () => flush());

// Counts failures and emits an OTelExportWarning, throttled to at most one
// per kWarningThrottleMs.
function warnExportFailure(message) {
  exportFailureCount++;
  const now = Date.now();
  if (now - lastExportWarningTime >= kWarningThrottleMs) {
    lastExportWarningTime = now;
    const suffix =
      exportFailureCount > 1 ? ` (${exportFailureCount} total failures)` : '';
    process.emitWarning(`${message}${suffix}`, 'OTelExportWarning');
  }
}

function sendToCollector(body) {
  const endpoint = getEndpoint();
  if (endpoint == null) return;

  // Settled by done() from whichever comes first: the response ending, a
  // request or response error, or the export deadline. Settling twice is
  // harmless, since a promise keeps its first resolution. Each handler
  // settles before anything that can throw, so a failure its guard catches
  // cannot leave a flush() waiting.
  let settle;
  const exportDone = new Promise((resolve) => {
    settle = resolve;
  });
  const done = () => {
    inFlightExports.delete(exportDone);
    settle();
  };
  inFlightExports.add(exportDone);

  let req;
  try {
    // The endpoint is fixed after start, so core resolved the export URL
    // once at activation.
    const parsed = getExportUrl();

    const transport = parsed.protocol === 'https:' ? https : http;

    // Encoding once serves both the length and the write. A string body is
    // scanned for its byte length, then joined to the header block and
    // encoded again on write.
    const encoded = Buffer.from(body);

    req = transport.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname,
        method: 'POST',
        agent: kExportAgents[parsed.protocol],
        headers: {
          ...getExportHeaders(),
          'content-type': 'application/json',
          'content-length': encoded.length,
        },
      },
      guard('export response', (res) => {
        // TODO(bengl): Once retry logic is added, parse the response body for
        // ExportTraceServiceResponse.partial_success.rejected_spans.
        res.resume();
        res.on(
          'end',
          guard('export response end', () => {
            clearDeadline();
            done();
            // Anything outside 2xx is a failed export: redirects are not
            // followed, so a 3xx would silently drop every span.
            if (res.statusCode < 200 || res.statusCode >= 300) {
              warnExportFailure(
                `OTLP collector responded with HTTP ${res.statusCode}`,
              );
            }
          }),
        );
        res.on(
          'error',
          guard('export response error', (err) => {
            clearDeadline();
            done();
            warnExportFailure(
              `OTLP export response stream error: ${err.message}`,
            );
          }),
        );
      }),
    );

    // exportTimeout is an absolute deadline for the whole export, not a
    // socket idle timeout: a collector that trickles response bytes would
    // reset an idle timer forever. The deadline settles the export itself,
    // so a flush() waiting on it resolves by then, whatever else fails.
    const deadline = setTimeout(
      guard('export timeout', () => {
        done();
        req.destroy(
          new Error(`exceeded the ${exportTimeoutMs}ms export timeout`),
        );
      }),
      exportTimeoutMs,
    );
    const clearDeadline = () => clearTimeout(deadline);

    req.on(
      'error',
      guard('export request error', (err) => {
        clearDeadline();
        done();
        warnExportFailure(
          `Failed to export spans to ${endpoint}: ${err.message}`,
        );
      }),
    );

    req.end(encoded);
  } catch (err) {
    // Once the request exists, destroying it releases its socket and runs
    // its 'error' listener, which clears the deadline, reports the
    // failure, and settles the export.
    if (req !== undefined) {
      req.destroy(err);
    } else {
      done();
      warnExportFailure(
        `Failed to export spans to ${endpoint}: ${err.message}`,
      );
    }
  }
  return exportDone;
}

function startFlusher(options) {
  maxBufferSize = options?.maxBufferSize ?? kDefaultMaxBufferSize;
  flushIntervalMs = options?.flushInterval ?? kDefaultFlushIntervalMs;
  exportTimeoutMs = options?.exportTimeout ?? kDefaultExportTimeoutMs;

  process.on('beforeExit', guardedBeforeExitFlush);
}

// Resets per-run state for the test suite; tracing itself never resets
// once started.
function resetCaches() {
  if (flushTimer != null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  flushScheduled = false;
  flushIntervalMs = kDefaultFlushIntervalMs;
  exportTimeoutMs = kDefaultExportTimeoutMs;
  cachedResource = null;
  cachedScope = null;
  exportFailureCount = 0;
  lastExportWarningTime = 0;
  maxBufferSize = kDefaultMaxBufferSize;
  spanBuffer = [];
  inFlightExports.clear();
}

module.exports = {
  addSpan,
  flush,
  startFlusher,
  resetCaches,
};
