'use strict';

// Tracks the current span. When the OpenTelemetry SDK runs in the same
// process, the current span lives in the SDK's context store instead of
// microtel's own, so spans from either side parent spans from the other.
// The OpenTelemetry API registers its parts on a global and names its
// context keys with Symbol.for, so this needs no dependency on it.

const { AsyncLocalStorage } = require('node:async_hooks');

const { STATUS_ERROR, STATUS_UNSET } = require('./span');

const kOtelApi = Symbol.for('opentelemetry.js.api.1');
const kSpanKey = Symbol.for('OpenTelemetry Context Key SPAN');
const kSuppressTracingKey = Symbol.for(
  'OpenTelemetry SDK Context Key SUPPRESS_TRACING',
);

const kTraceId = /^(?!0{32})[0-9a-f]{32}$/;
const kSpanId = /^(?!0{16})[0-9a-f]{16}$/;

// Returned by activeParent() when the SDK has asked for no tracing, as its
// exporters do for their own requests.
const kSuppressed = Symbol('kSuppressed');

// microtel's span rides along in the context next to its bridge. The SDK's
// child contexts keep it, so a client span under an SDK span still inherits
// the baggage microtel received.
const kMicrotelSpan = Symbol('kMicrotelSpan');

const storage = new AsyncLocalStorage();

// The handlers run in diagnostics_channel subscribers, before the code they
// trace, so they cannot wrap it in the SDK's with(). Sharing needs a context
// manager that can also take a context imperatively, through attach().
function sdkContextManager() {
  const manager = globalThis[kOtelApi]?.context;
  return typeof manager?.attach === 'function' ? manager : undefined;
}

// The parent for a new client span: a microtel span, the span context of an
// SDK span, or undefined for none.
function activeParent() {
  const manager = sdkContextManager();
  if (manager === undefined) return storage.getStore();

  const context = manager.active();
  if (context.getValue(kSuppressTracingKey) === true) return kSuppressed;

  const span = context.getValue(kSpanKey);
  if (span === undefined) return undefined;
  if (span instanceof BridgeSpan) return span.span;

  const { traceId, spanId, traceFlags, traceState, isRemote } =
    span.spanContext();
  if (!kTraceId.test(traceId) || !kSpanId.test(spanId)) return undefined;
  return {
    traceId,
    spanId,
    traceFlags,
    isRemote: isRemote === true,
    tracestate: traceState?.serialize() || undefined,
    baggage: context.getValue(kMicrotelSpan)?.baggage,
  };
}

// Makes a span current for the rest of the async chain it was created in,
// including the request handler that runs next.
function enterSpan(span) {
  const manager = sdkContextManager();
  if (manager === undefined) {
    storage.enterWith(span);
    return;
  }
  // TODO(bengl): The SDK's framework instrumentations, such as Express,
  // report the matched route through an RPC metadata object they look up in
  // this context. Adding one here, and reading its route when the response
  // finishes, would give server spans http.route and a route in their name.
  manager.attach(
    new Context(
      new Map([
        [kSpanKey, new BridgeSpan(span)],
        [kMicrotelSpan, span],
      ]),
    ),
  );
}

// A minimal OpenTelemetry Context. Each server request starts from an empty
// one, as the SDK's own HTTP instrumentation does, so nothing from the code
// that started the server leaks into requests.
class Context {
  #values;

  constructor(values) {
    this.#values = values;
  }

  getValue(key) {
    return this.#values?.get(key);
  }

  setValue(key, value) {
    return new Context(new Map(this.#values).set(key, value));
  }

  deleteValue(key) {
    const values = new Map(this.#values);
    values.delete(key);
    return new Context(values);
  }
}

// The OpenTelemetry Span interface over a microtel span, for the SDK and for
// code that calls trace.getActiveSpan(). Writes land on the microtel span
// while it is recording, the way the SDK's own spans take them. microtel ends
// its own spans, so end() does nothing, and links are dropped because
// microtel spans have none.
class BridgeSpan {
  #spanContext;

  constructor(span) {
    this.span = span;
  }

  spanContext() {
    const { span } = this;
    this.#spanContext ??= {
      traceId: span.traceId,
      spanId: span.spanId,
      traceFlags: span.traceFlags,
      traceState: span.tracestate ? new TraceState(span.tracestate) : undefined,
      isRemote: false,
    };
    return this.#spanContext;
  }

  // As in the SDK, a span whose trace is not sampled records nothing.
  isRecording() {
    return this.span.endTime === undefined && this.span.isSampled;
  }

  setAttribute(key, value) {
    if (this.isRecording()) this.span.setAttribute(key, value);
    return this;
  }

  setAttributes(attributes) {
    if (this.isRecording()) {
      for (const key of Object.keys(attributes))
        this.span.setAttribute(key, attributes[key]);
    }
    return this;
  }

  // The second argument is either attributes or a time. microtel times
  // events itself, so a time is ignored.
  addEvent(name, attributesOrTime) {
    if (!this.isRecording()) return this;
    const isAttributes =
      typeof attributesOrTime === 'object' &&
      attributesOrTime !== null &&
      !Array.isArray(attributesOrTime) &&
      !(attributesOrTime instanceof Date);
    this.span.addEvent(
      name,
      isAttributes ? { __proto__: null, ...attributesOrTime } : undefined,
    );
    return this;
  }

  addLink() {
    return this;
  }

  addLinks() {
    return this;
  }

  // As the SDK does, an unset status is ignored, and only an error keeps a
  // message. The span itself keeps an ok status final.
  setStatus({ code, message }) {
    if (this.isRecording() && code !== STATUS_UNSET) {
      const isError = code === STATUS_ERROR && typeof message === 'string';
      this.span.setStatus(code, isError ? message : '');
    }
    return this;
  }

  updateName(name) {
    if (this.isRecording()) this.span.name = name;
    return this;
  }

  // Maps an exception the way the SDK does. An error's code wins over its
  // name as the type, and nothing is recorded without a type or a message.
  recordException(exception) {
    if (!this.isRecording()) return;
    const attributes = { __proto__: null };
    if (typeof exception === 'string') {
      attributes['exception.message'] = exception;
    } else if (exception) {
      const type = exception.code ? String(exception.code) : exception.name;
      if (type) attributes['exception.type'] = type;
      if (exception.message)
        attributes['exception.message'] = exception.message;
      if (exception.stack) attributes['exception.stacktrace'] = exception.stack;
    }
    if (attributes['exception.type'] || attributes['exception.message'])
      this.span.addEvent('exception', attributes);
  }

  end() {}
}

// OpenTelemetry's TraceState interface over a tracestate header. It hands the
// header back unchanged, and a change makes a new one with the changed key
// first, as the W3C spec asks.
class TraceState {
  #header;

  constructor(header) {
    this.#header = header;
  }

  #members() {
    const members = [];
    for (const member of this.#header.split(',')) {
      const eq = member.indexOf('=');
      if (eq > 0)
        members.push([member.slice(0, eq).trim(), member.slice(eq + 1).trim()]);
    }
    return members;
  }

  get(key) {
    return this.#members().find(([k]) => k === key)?.[1];
  }

  set(key, value) {
    const rest = this.#members().filter(([k]) => k !== key);
    return TraceState.#of([[key, value], ...rest]);
  }

  unset(key) {
    return TraceState.#of(this.#members().filter(([k]) => k !== key));
  }

  serialize() {
    return this.#header;
  }

  static #of(members) {
    return new TraceState(members.map(([k, v]) => `${k}=${v}`).join(','));
  }
}

module.exports = {
  BridgeSpan,
  TraceState,
  activeParent,
  enterSpan,
  kSuppressed,
};
