'use strict';

const { performance } = require('node:perf_hooks');

const { addSpan } = require('./flush');
const { generateTraceId, generateSpanId } = require('./id');
const { getSampledTracestate, sampleRoot } = require('./sampler');
const { TraceState } = require('./trace-context');

// SpanKind and StatusCode values per the OTLP trace proto:
// https://github.com/open-telemetry/opentelemetry-proto/blob/main/opentelemetry/proto/trace/v1/trace.proto
const SPAN_KIND_INTERNAL = 1;
const SPAN_KIND_SERVER = 2;
const SPAN_KIND_CLIENT = 3;

// (Status codes: 0 UNSET, 1 OK, 2 ERROR.)
const STATUS_UNSET = 0;
const STATUS_ERROR = 2;

const kSpan = Symbol('kOtelSpan');

// The known traceparent fields: version, trace ID, span ID, and flags,
// all lowercase hex. Higher versions may append extensions after these fields.
// Version ff is invalid: https://www.w3.org/TR/trace-context/#version
const kTraceparent = /^(?!ff)[0-9a-f]{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}/;
const kAllZero32 = '00000000000000000000000000000000';
const kAllZero16 = '0000000000000000';

// W3C trace flags. Trace Context Level 2 adds the random flag, which says
// a trace ID's rightmost 56 bits are random.
const kTraceFlagSampled = 0x01;
const kTraceFlagRandom = 0x02;

// A span keeps at most this many distinct attribute keys, the OpenTelemetry
// SDK's default attributeCountLimit. New keys past it are dropped and
// counted, while writes to keys the span already has always land.
const kAttributeCountLimit = 128;

// Two hex digits for every trace flags byte, so building a traceparent
// never formats a number.
const kTraceFlagsHex = Array.from({ length: 256 }, (_, i) =>
  i.toString(16).padStart(2, '0'),
);

// The attribute keys the instrumentations write, preallocated so every
// span's attributes share one shape and writes are plain property stores.
// Unused keys stay undefined and are skipped at export time. A class keeps
// the object in V8's fast mode, where an object literal with __proto__:
// null would start out in dictionary mode. Its prototype has no
// properties and no prototype of its own, so the object inherits nothing,
// and a key named __proto__ is stored as an ordinary own property.
class SpanAttributes {
  'client.address' = undefined;
  'error.type' = undefined;
  'http.request.method' = undefined;
  'http.response.status_code' = undefined;
  'http.route' = undefined;
  'network.peer.address' = undefined;
  'network.peer.port' = undefined;
  'network.protocol.version' = undefined;
  'server.address' = undefined;
  'server.port' = undefined;
  'url.full' = undefined;
  'url.path' = undefined;
  'url.query' = undefined;
  'url.scheme' = undefined;
  'user_agent.original' = undefined;
}
delete SpanAttributes.prototype.constructor;
Object.setPrototypeOf(SpanAttributes.prototype, null);

// A parent parsed from an inbound traceparent header. A class keeps it in
// V8's fast mode, unlike a __proto__: null literal. The header carries no
// tracestate or baggage, so those stay undefined.
class RemoteParent {
  traceState = undefined;
  baggage = undefined;
  isRemote = true;
  constructor(traceId, spanId, traceFlags) {
    this.traceId = traceId;
    this.spanId = spanId;
    this.traceFlags = traceFlags;
  }
}

// Spans start with these shared values, so a span without events or a
// status allocates neither. addEvent and setStatus replace them rather
// than mutating them.
const kNoEvents = Object.freeze([]);
const kUnsetStatus = Object.freeze({ code: STATUS_UNSET, message: '' });

class Span {
  traceId;
  spanId;
  parentSpanId;
  name;
  kind;
  // Raw W3C baggage header value, forwarded verbatim like tracestate:
  // never parsed, never modified, and not a span attribute, so it never
  // appears in the OTLP payload. Undefined when no baggage was received.
  baggage;
  // Set as the target of the request's Operation.
  target;
  // Timestamps are epoch milliseconds. The start comes from the wall
  // clock; the end is derived as start + a monotonic duration, so spans
  // survive a backward clock step while keeping human-readable absolute
  // timestamps. Conversion to OTLP nanoseconds happens only at export, so
  // unsampled or filtered spans never pay for it. An unsampled span is
  // never exported, so it is never given timestamps: its endTime only
  // marks that it has ended.
  startTime;
  endTime;
  #startMonotonic;

  #attributes;
  // #attributeLimit counts setAttribute calls until they reach the cap.
  // Distinct keys never outnumber writes, so spans below the cap need no
  // per-key accounting. Once writes reach the cap, it holds the exact
  // distinct count and the dropped count instead, so an ordinary span
  // initializes one field for all of this.
  #attributeLimit = 0;
  #events;
  #status;
  #traceFlags;
  #remoteParent;
  // The W3C tracestate, forwarded verbatim to child requests and serialized
  // only when the header is sent or the span is exported. Undefined when
  // there is none.
  #traceState;

  constructor(name, kind, options) {
    const parent = options?.parent;

    this.name = name;
    this.kind = kind;
    this.spanId = generateSpanId();
    this.#events = kNoEvents;
    this.#status = kUnsetStatus;

    let rootTracestate;
    if (parent != null) {
      this.traceId = parent.traceId;
      this.parentSpanId = parent.spanId;
      this.#traceFlags = parent.traceFlags;
      // "true if the SpanContext was propagated from a remote parent".
      // https://opentelemetry.io/docs/specs/otel/trace/api/#isremote
      this.#remoteParent = parent.isRemote === true;
    } else {
      this.#remoteParent = false;
      // A root span starts the trace, so it makes the sampling decision.
      // Its trace ID comes from a CSPRNG, so it also sets the random flag.
      this.traceId = generateTraceId();
      this.parentSpanId = undefined;
      if (sampleRoot(this.traceId)) {
        this.#traceFlags = kTraceFlagRandom | kTraceFlagSampled;
        rootTracestate = getSampledTracestate();
      } else {
        this.#traceFlags = kTraceFlagRandom;
      }
    }
    // An explicit tracestate header wins, children inherit their parent's
    // trace state, and a sampled root starts one with its sampling threshold.
    const tracestate = options?.tracestate ?? rootTracestate;
    this.#traceState =
      tracestate === undefined
        ? parent?.traceState
        : new TraceState(tracestate);
    // Baggage follows the same inheritance: an explicit inbound value
    // wins, children inherit their parent's.
    this.baggage = options?.baggage ?? parent?.baggage;

    // Attributes and timestamps serve only the export, so an unsampled
    // span is given neither.
    if (this.#traceFlags & kTraceFlagSampled) {
      this.#attributes = new SpanAttributes();
      this.startTime = Date.now();
      this.#startMonotonic = performance.now();
    }
  }

  get traceFlags() {
    return this.#traceFlags;
  }

  get traceState() {
    return this.#traceState;
  }

  get isSampled() {
    return (this.#traceFlags & kTraceFlagSampled) !== 0;
  }

  get hasRemoteParent() {
    return this.#remoteParent;
  }

  setAttribute(key, value) {
    // An unsampled span has no attributes to record into.
    if (this.#attributes === undefined) return this;
    const writes = this.#attributeLimit;
    if (typeof writes === 'number' && writes < kAttributeCountLimit) {
      this.#attributeLimit = writes + 1;
      this.#attributes[key] = value;
      return this;
    }
    return this.#setAttributeCapped(key, value);
  }

  // This runs only once writes reach the cap. A key the span does not
  // have yet holds undefined, and undefined values are never exported, so
  // a key counts against the cap only while it holds another value. Writing
  // undefined to a key frees its slot.
  #setAttributeCapped(key, value) {
    const attrs = this.#attributes;
    let limit = this.#attributeLimit;
    if (typeof limit === 'number') {
      let count = 0;
      for (const k of Object.keys(attrs)) if (attrs[k] !== undefined) count++;
      limit = { count, dropped: 0 };
      this.#attributeLimit = limit;
    }
    const had = attrs[key] !== undefined;
    const has = value !== undefined;
    if (has && !had) {
      if (limit.count === kAttributeCountLimit) {
        limit.dropped++;
        return this;
      }
      limit.count++;
    } else if (had && !has) {
      limit.count--;
    }
    attrs[key] = value;
    return this;
  }

  getAttributes() {
    return this.#attributes;
  }

  get droppedAttributesCount() {
    const limit = this.#attributeLimit;
    return typeof limit === 'number' ? 0 : limit.dropped;
  }

  addEvent(name, attributes) {
    // Only the internal exception producer uses events today; cap them
    // once addEvent becomes part of a public API.
    // TODO(bengl): cap the number of events per span then.
    // An unsampled span is never exported, so its events are dropped.
    if (this.#attributes === undefined) return this;
    if (this.#events === kNoEvents) this.#events = [];
    this.#events.push({
      name,
      // Anchored to the span start like endTime, for clock-step safety.
      time: this.startTime + (performance.now() - this.#startMonotonic),
      attributes: attributes || { __proto__: null },
    });
    return this;
  }

  getEvents() {
    return this.#events;
  }

  get status() {
    return this.#status;
  }

  setStatus(code, message) {
    this.#status = { code, message: message || '' };
    return this;
  }

  end() {
    if (this.endTime !== undefined) return;
    // Only export sampled spans.
    if (this.#traceFlags & kTraceFlagSampled) {
      this.endTime =
        this.startTime + (performance.now() - this.#startMonotonic);
      addSpan(this);
    } else {
      // An unsampled span reads no clock on the way out, it is only
      // marked ended.
      this.endTime = 0;
    }
  }

  // Produces the outgoing header value; the caller writes it into the
  // request. Format: {version}-{trace-id}-{span-id}-{trace-flags}.
  toTraceparent() {
    return `00-${this.traceId}-${this.spanId}-${kTraceFlagsHex[this.#traceFlags]}`;
  }

  // Parses an incoming header value into a remote parent. Returns null
  // when invalid per the W3C spec.
  static fromTraceparent(traceparentHeader) {
    if (typeof traceparentHeader !== 'string') return null;
    if (!kTraceparent.test(traceparentHeader)) return null;
    // Higher versions preserve the known fields and may append opaque
    // extensions: https://www.w3.org/TR/trace-context/#versioning-of-traceparent
    if (
      traceparentHeader.length > 55 &&
      (traceparentHeader.startsWith('00') || traceparentHeader[55] !== '-')
    )
      return null;

    const traceId = traceparentHeader.slice(3, 35);
    const spanId = traceparentHeader.slice(36, 52);
    if (traceId === kAllZero32) return null;
    if (spanId === kAllZero16) return null;

    return new RemoteParent(
      traceId,
      spanId,
      parseInt(traceparentHeader.slice(53, 55), 16),
    );
  }
}

module.exports = {
  Span,
  SPAN_KIND_INTERNAL,
  SPAN_KIND_SERVER,
  SPAN_KIND_CLIENT,
  STATUS_UNSET,
  STATUS_ERROR,
  kSpan,
};
