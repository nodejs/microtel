'use strict';

const { Buffer } = require('node:buffer');
const http = require('node:http');
const https = require('node:https');
const { clearTimeout, setImmediate, setTimeout } = require('node:timers');

const {
  getEndpoint,
  getExportUrl,
  getServiceName,
  getSdkName,
  getSdkVersion,
} = require('./core');

const kDefaultMaxBufferSize = 100;
const kDefaultFlushIntervalMs = 10_000;
const kDefaultExportTimeoutMs = 10_000;
const kWarningThrottleMs = 30_000;
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

let cachedResource = null;
let cachedScope = null;

function getResource() {
  cachedResource ??= {
    attributes: [
      { key: 'service.name', value: { stringValue: getServiceName() } },
      { key: 'telemetry.sdk.name', value: { stringValue: getSdkName() } },
      { key: 'telemetry.sdk.language', value: { stringValue: 'nodejs' } },
      { key: 'telemetry.sdk.version', value: { stringValue: getSdkVersion() } },
      { key: 'process.runtime.name', value: { stringValue: 'nodejs' } },
      {
        key: 'process.runtime.version',
        value: { stringValue: process.version },
      },
      { key: 'process.pid', value: { intValue: String(process.pid) } },
    ],
  };
  return cachedResource;
}

function getScope() {
  cachedScope ??= {
    name: getSdkName(),
    version: getSdkVersion(),
  };
  return cachedScope;
}

// Characters that can need escaping in a JSON string. Surrogates are
// included because a lone one must be escaped, so any string with a
// surrogate goes through JSON.stringify, which handles pairs and lone
// ones alike.
const kNeedsEscape = /[\\"\x00-\x1f\ud800-\udfff]/;

// Encodes a string as a JSON string value. A string with none of the
// characters above is valid JSON once quoted, exactly what JSON.stringify
// would produce, so it skips the call.
function jsonString(value) {
  if (!kNeedsEscape.test(value)) return `"${value}"`;
  return JSON.stringify(value);
}

// Encoded key prefixes, cached since the instrumentations write the same
// few keys on every span. The cap keeps a stream of distinct keys from
// growing the cache without bound.
const kKeyPrefixes = new Map();
function keyPrefix(key) {
  let prefix = kKeyPrefixes.get(key);
  if (prefix === undefined) {
    prefix = `{"key":${jsonString(key)},"value":`;
    if (kKeyPrefixes.size < 256) kKeyPrefixes.set(key, prefix);
  }
  return prefix;
}

// Encodes a single attribute value as an OTLP AnyValue JSON fragment.
function encodeAttributeValueJson(value) {
  if (typeof value === 'string') return `{"stringValue":${jsonString(value)}}`;
  if (typeof value === 'number') {
    if (Number.isInteger(value)) return `{"intValue":"${value}"}`;
    // NaN and the infinities have no JSON number form. ProtoJSON writes
    // them as the strings "NaN", "Infinity", and "-Infinity".
    if (!Number.isFinite(value)) return `{"doubleValue":"${value}"}`;
    return `{"doubleValue":${value}}`;
  }
  if (typeof value === 'boolean') return `{"boolValue":${value}}`;
  return `{"stringValue":${jsonString(String(value))}}`;
}

// Converts epoch milliseconds into an OTLP nanosecond string. For positive
// safe integers, appending six zeros is exact and skips the BigInt math.
// Anything else takes the BigInt path, so the result always matches it,
// and non-finite input still throws, which drops the span.
function timeToUnixNano(t) {
  const ms = Math.round(t);
  if (ms > 0 && ms <= Number.MAX_SAFE_INTEGER) return `${ms}000000`;
  return `${BigInt(ms) * 1_000_000n}`;
}

// Builds the JSON string for one OTLP span directly, without intermediate
// objects: the string is ready for the wire. Trace and span IDs are always
// hex, from the ID generator or a validated traceparent, so they are
// written as is. Every other string goes through the escape check.
function spanToOtlpJson(span) {
  let s = '{"traceId":"';
  s += span.traceId;
  s += '","spanId":"';
  s += span.spanId;
  s += '","name":';
  s += jsonString(String(span.name));
  s += ',"kind":';
  s += span.kind;
  s += ',"startTimeUnixNano":"';
  s += timeToUnixNano(span.startTime);
  s += '","endTimeUnixNano":"';
  s += timeToUnixNano(span.endTime);
  s += '"';

  const rawAttrs = span.getAttributes();
  const attrKeys = Object.keys(rawAttrs);
  let attrCount = 0;
  for (let i = 0; i < attrKeys.length; i++) {
    // Unused preallocated keys stay undefined and are skipped.
    if (rawAttrs[attrKeys[i]] === undefined) continue;
    if (attrCount === 0) s += ',"attributes":[';
    else s += ',';
    s += keyPrefix(attrKeys[i]);
    s += encodeAttributeValueJson(rawAttrs[attrKeys[i]]);
    s += '}';
    attrCount++;
  }
  if (attrCount > 0) s += ']';

  const status = span.status;
  if (status.code !== 0 || status.message) {
    s += ',"status":{"code":';
    s += status.code;
    if (status.message) {
      s += ',"message":';
      s += jsonString(status.message);
    }
    s += '}';
  }

  if (span.parentSpanId) {
    s += ',"parentSpanId":"';
    s += span.parentSpanId;
    s += '"';
  }

  const rawEvents = span.getEvents();
  if (rawEvents.length > 0) {
    s += ',"events":[';
    for (let i = 0; i < rawEvents.length; i++) {
      if (i > 0) s += ',';
      const event = rawEvents[i];
      s += '{"name":';
      s += jsonString(String(event.name));
      s += ',"timeUnixNano":"';
      s += timeToUnixNano(event.time);
      s += '"';
      const eAttrs = event.attributes;
      const eKeys = Object.keys(eAttrs);
      let eCount = 0;
      for (let j = 0; j < eKeys.length; j++) {
        if (eAttrs[eKeys[j]] === undefined) continue;
        if (eCount === 0) s += ',"attributes":[';
        else s += ',';
        s += keyPrefix(eKeys[j]);
        s += encodeAttributeValueJson(eAttrs[eKeys[j]]);
        s += '}';
        eCount++;
      }
      if (eCount > 0) s += ']';
      s += '}';
    }
    s += ']';
  }

  s += '}';
  return s;
}

function addSpan(span) {
  spanBuffer.push(span);
  if (spanBuffer.length >= maxBufferSize) {
    // Deferred so serialization does not run inside the request that
    // filled the buffer.
    if (!flushScheduled) {
      flushScheduled = true;
      setImmediate(() => {
        flushScheduled = false;
        flush();
      });
    }
  } else if (flushTimer == null) {
    flushTimer = setTimeout(flush, flushIntervalMs);
    flushTimer.unref();
  }
}

// The envelope prefix and suffix around the spans array are fixed after
// start, so they are cached once.
let envelopePrefix = null;
const envelopeSuffix = ']}]}]}';

function flush() {
  if (flushTimer != null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (spanBuffer.length === 0) return;
  if (getEndpoint() == null) return;

  const spans = spanBuffer;
  spanBuffer = [];

  // A span that fails to serialize is skipped on its own, so one bad span
  // never costs the rest of the batch.
  const parts = [];
  for (let i = 0; i < spans.length; i++) {
    try {
      parts.push(spanToOtlpJson(spans[i]));
    } catch (err) {
      warnExportFailure(
        `Failed to serialize span "${spans[i].name}": ${err.message}`,
      );
    }
  }

  if (parts.length === 0) return;

  envelopePrefix ??=
    `{"resourceSpans":[{"resource":${JSON.stringify(getResource())},` +
    `"scopeSpans":[{"scope":${JSON.stringify(getScope())},"spans":[`;

  sendToCollector(envelopePrefix + parts.join(',') + envelopeSuffix);
}

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

  try {
    // The endpoint is fixed after start, so core resolved the export URL
    // once at activation.
    const parsed = getExportUrl();

    const transport = parsed.protocol === 'https:' ? https : http;

    const req = transport.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname,
        method: 'POST',
        agent: kExportAgents[parsed.protocol],
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
        },
      },
      (res) => {
        // TODO(bengl): Once retry logic is added, parse the response body for
        // ExportTraceServiceResponse.partial_success.rejected_spans.
        res.resume();
        res.on('end', () => {
          clearDeadline();
          // Anything outside 2xx is a failed export: redirects are not
          // followed, so a 3xx would silently drop every span.
          if (res.statusCode < 200 || res.statusCode >= 300) {
            warnExportFailure(
              `OTLP collector responded with HTTP ${res.statusCode}`,
            );
          }
        });
        res.on('error', (err) => {
          clearDeadline();
          warnExportFailure(
            `OTLP export response stream error: ${err.message}`,
          );
        });
      },
    );

    // exportTimeout is an absolute deadline for the whole export, not a
    // socket idle timeout: a collector that trickles response bytes would
    // reset an idle timer forever.
    const deadline = setTimeout(() => {
      req.destroy(
        new Error(`exceeded the ${exportTimeoutMs}ms export timeout`),
      );
    }, exportTimeoutMs);
    const clearDeadline = () => clearTimeout(deadline);

    req.on('error', (err) => {
      clearDeadline();
      warnExportFailure(
        `Failed to export spans to ${endpoint}: ${err.message}`,
      );
    });

    req.end(body);
  } catch (err) {
    warnExportFailure(`Failed to export spans to ${endpoint}: ${err.message}`);
  }
}

function startFlusher(options) {
  maxBufferSize = options?.maxBufferSize ?? kDefaultMaxBufferSize;
  flushIntervalMs = options?.flushInterval ?? kDefaultFlushIntervalMs;
  exportTimeoutMs = options?.exportTimeout ?? kDefaultExportTimeoutMs;

  process.on('beforeExit', flush);
}

// Resets per-run state for the test suite; tracing itself never resets
// once started.
function resetCaches() {
  envelopePrefix = null;
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
}

module.exports = {
  addSpan,
  flush,
  startFlusher,
  resetCaches,
};
