'use strict';

const { performance } = require('node:perf_hooks');

const { addSpan } = require('./flush');
const { generateTraceId, generateSpanId } = require('./id');

// SpanKind and StatusCode values per the OTLP trace proto:
// https://github.com/open-telemetry/opentelemetry-proto/blob/main/opentelemetry/proto/trace/v1/trace.proto
const SPAN_KIND_INTERNAL = 1;
const SPAN_KIND_SERVER = 2;
const SPAN_KIND_CLIENT = 3;

// (Status codes: 0 UNSET, 1 OK, 2 ERROR.)
const STATUS_UNSET = 0;
const STATUS_ERROR = 2;

const kSpan = Symbol('kOtelSpan');

const kHex32 = /^[0-9a-f]{32}$/;
const kHex16 = /^[0-9a-f]{16}$/;
const kHex2 = /^[0-9a-f]{2}$/;
const kAllZero32 = '00000000000000000000000000000000';
const kAllZero16 = '0000000000000000';

class Span {
  traceId;
  spanId;
  parentSpanId;
  name;
  kind;
  // Raw W3C tracestate header value, forwarded verbatim to child
  // requests. Undefined when no tracestate was received.
  tracestate;
  // Timestamps are epoch milliseconds. The start comes from the wall
  // clock; the end is derived as start + a monotonic duration, so spans
  // survive a backward clock step while keeping human-readable absolute
  // timestamps. Conversion to OTLP nanoseconds happens only at export, so
  // unsampled or filtered spans never pay for it.
  startTime;
  endTime;
  #startMonotonic;

  #attributes;
  #events;
  #status;
  #traceFlags;

  constructor(name, kind, options) {
    const parent = options?.parent;

    this.name = name;
    this.kind = kind;
    this.spanId = generateSpanId();
    // The keys below are the complete set the instrumentations write (there
    // is no public attribute API yet). Preallocating them keeps every
    // span's attribute object the same shape, so writes never trigger
    // hidden class transitions or dictionary mode. Unused keys stay
    // undefined and are skipped at export time.
    this.#attributes = {
      __proto__: null,
      'error.type': undefined,
      'http.request.method': undefined,
      'http.response.status_code': undefined,
      'network.protocol.version': undefined,
      'server.address': undefined,
      'server.port': undefined,
      'url.full': undefined,
      'url.path': undefined,
      'url.query': undefined,
      'url.scheme': undefined,
    };
    this.#events = [];
    this.#status = { code: STATUS_UNSET, message: '' };
    this.startTime = Date.now();
    this.#startMonotonic = performance.now();

    if (parent != null) {
      this.traceId = parent.traceId;
      this.parentSpanId = parent.spanId;
      this.#traceFlags = parent.traceFlags;
    } else {
      this.traceId = generateTraceId();
      this.parentSpanId = undefined;
      this.#traceFlags = 0x01; // Sampled by default.
    }
    // An explicit tracestate wins; children inherit their parent's.
    this.tracestate = options?.tracestate ?? parent?.tracestate;
  }

  get traceFlags() {
    return this.#traceFlags;
  }

  setAttribute(key, value) {
    this.#attributes[key] = value;
    return this;
  }

  getAttributes() {
    return this.#attributes;
  }

  addEvent(name, attributes) {
    // Only the internal exception producer uses events today; cap them
    // once addEvent becomes part of a public API.
    // TODO(bengl): cap the number of events per span then.
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
    this.endTime = this.startTime + (performance.now() - this.#startMonotonic);

    // Only export sampled spans.
    if (this.#traceFlags & 0x01) addSpan(this);
  }

  // Produces the outgoing header value; the caller writes it into the
  // request. Format: {version}-{trace-id}-{span-id}-{trace-flags}.
  toTraceparent() {
    // The common case is a sampled root span (flags 0x01).
    const flags =
      this.#traceFlags === 0x01
        ? '01'
        : this.#traceFlags.toString(16).padStart(2, '0');
    return `00-${this.traceId}-${this.spanId}-${flags}`;
  }

  // Parses an incoming header value into a remote parent. Returns null
  // when invalid per the W3C spec.
  static fromTraceparent(traceparentHeader) {
    if (typeof traceparentHeader !== 'string') return null;

    const parts = traceparentHeader.split('-');
    if (parts.length !== 4) return null;

    // Only version 00 is defined; reject everything else.
    if (parts[0] !== '00') return null;
    const traceId = parts[1];
    const spanId = parts[2];
    const flags = parts[3];
    if (!kHex32.test(traceId)) return null;
    if (!kHex16.test(spanId)) return null;
    if (!kHex2.test(flags)) return null;

    if (traceId === kAllZero32) return null;
    if (spanId === kAllZero16) return null;

    return {
      __proto__: null,
      traceId,
      spanId,
      traceFlags: parseInt(flags, 16),
    };
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
