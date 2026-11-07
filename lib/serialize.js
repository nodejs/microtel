'use strict';

// Encodes spans as an OTLP/JSON export request body.

const { hostname } = require('node:os');

const {
  getInstanceId,
  getResourceAttributes,
  getServiceName,
  getSdkName,
  getSdkVersion,
} = require('./core');

// OTLP span flags hold the W3C trace flags in the low 8 bits. The next two
// bits say that whether the parent is remote is known, and that it is. The
// OpenTelemetry SDKs always know, so they always set the first.
const kSpanFlagsHasIsRemote = 0x100;
const kSpanFlagsIsRemote = 0x200;

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

  // The OTLP field is dropped_attributes_count, spelled
  // droppedAttributesCount in ProtoJSON.
  const droppedAttributesCount = span.droppedAttributesCount;
  if (droppedAttributesCount > 0)
    otlpSpan.droppedAttributesCount = droppedAttributesCount;

  const status = span.status;
  if (status.code !== 0 || status.message) otlpSpan.status = status;

  if (span.parentSpanId) otlpSpan.parentSpanId = span.parentSpanId;

  if (span.tracestate) otlpSpan.traceState = span.tracestate;

  if (events.length > 0) otlpSpan.events = events;

  return otlpSpan;
}

// A span that fails to serialize is skipped and reported through
// onFailure(message), so the rest of the batch still exports. Returns
// undefined when nothing is left to send.
function serializeSpans(spans, onFailure) {
  const otlpSpans = [];
  for (let i = 0; i < spans.length; i++) {
    try {
      otlpSpans.push(spanToOtlp(spans[i]));
    } catch (err) {
      onFailure(`Failed to serialize span "${spans[i].name}": ${err.message}`);
    }
  }

  if (otlpSpans.length === 0) return undefined;

  try {
    return JSON.stringify({
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
    onFailure(`Failed to serialize ${otlpSpans.length} spans: ${err.message}`);
    return undefined;
  }
}

// Resets per-run state for the test suite.
function resetSerializeCaches() {
  cachedResource = null;
  cachedScope = null;
}

module.exports = {
  resetSerializeCaches,
  serializeSpans,
};
