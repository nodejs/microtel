'use strict';

// The W3C Trace Context a span propagates: its trace context and trace
// state.
// https://www.w3.org/TR/trace-context/

// "trace-id = 32HEXDIGLC" and "parent-id = 16HEXDIGLC", all zeros invalid.
// https://www.w3.org/TR/trace-context/#trace-id
// https://www.w3.org/TR/trace-context/#parent-id
const kTraceId = /^(?!0{32})[0-9a-f]{32}$/;
const kSpanId = /^(?!0{16})[0-9a-f]{16}$/;

// A tracestate header, behind the serialize() of OpenTelemetry's TraceState,
// so a trace state from either side is kept the same way and serialized only
// when the header is sent or the span is exported.
// https://opentelemetry.io/docs/specs/otel/trace/api/#tracestate
// TODO(legendecas): Add the operations a TraceState "MUST provide": get,
// add, update, and delete a key-value pair, each returning a new TraceState.
class TraceState {
  #header;

  constructor(header) {
    this.#header = header;
  }

  // Technically, serialization happens at mutation as mutation is less likely
  // to happen than serialization.
  serialize() {
    return this.#header;
  }
}

// The fields of a SpanContext.
// https://opentelemetry.io/docs/specs/otel/trace/api/#spancontext
class TraceContext {
  constructor(traceId, spanId, traceFlags, traceState, isRemote) {
    this.traceId = traceId;
    this.spanId = spanId;
    this.traceFlags = traceFlags;
    this.traceState = traceState;
    this.isRemote = isRemote;
    Object.freeze(this);
  }

  // The trace context a span's children inherit, which is local to them.
  static fromSpan(span) {
    return new TraceContext(
      span.traceId,
      span.spanId,
      span.traceFlags,
      span.traceState,
      false,
    );
  }

  // "true if the SpanContext has a non-zero TraceID and a non-zero SpanID",
  // with the field types checked too.
  // https://opentelemetry.io/docs/specs/otel/trace/api/#isvalid
  static isValid(value) {
    return (
      typeof value === 'object' &&
      value !== null &&
      kTraceId.test(value.traceId) &&
      kSpanId.test(value.spanId) &&
      Number.isInteger(value.traceFlags) &&
      value.traceFlags >= 0 &&
      value.traceFlags <= 0xff &&
      (value.traceState === undefined ||
        typeof value.traceState?.serialize === 'function')
    );
  }
}

module.exports = {
  TraceContext,
  TraceState,
};
