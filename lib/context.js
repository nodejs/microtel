'use strict';

// The Context microtel propagates. A context adapter gets and sets
// microtel's values in Context objects, and a ContextStore tracks the
// current one. Another implementation can set its own adapter, so
// both share the current Context. See docs/context.md.
// https://opentelemetry.io/docs/specs/otel/context/

const { AsyncLocalStorage } = require('node:async_hooks');

const { TraceContext } = require('./trace-context');
const { invalidArgTypeError, validateObject } = require('./validate');

// The methods an adapter must implement.
const kAdapterMethods = ['getValue', 'setValues'];

// One frozen field per key. The null prototype makes any other key read as
// undefined.
class DefaultContext {
  constructor(traceContext, operation, baggage) {
    this.traceContext = traceContext;
    this.operation = operation;
    this.baggage = baggage;
    Object.freeze(this);
  }
}
delete DefaultContext.prototype.constructor;
Object.setPrototypeOf(DefaultContext.prototype, null);

const kRootContext = new DefaultContext(undefined, undefined, undefined);

class DefaultContextAdapter {
  getValue(context, key) {
    return context[key];
  }

  // A key present in values wins, even when undefined.
  setValues(context = kRootContext, values) {
    return new DefaultContext(
      'traceContext' in values ? values.traceContext : context.traceContext,
      'operation' in values ? values.operation : context.operation,
      'baggage' in values ? values.baggage : context.baggage,
    );
  }
}

// The Context API's optional global operations.
// https://opentelemetry.io/docs/specs/otel/context/#optional-global-operations
class ContextStore {
  #storage = new AsyncLocalStorage();

  active() {
    return this.#storage.getStore();
  }

  with(context, fn, ...args) {
    return this.#storage.run(context, fn, ...args);
  }

  attach(context) {
    return this.#storage.withScope(context);
  }
}

// The adapter defines what a Context is, and gets and sets values in one.
// The store tracks which Context is current in each async execution. The
// default store is made only when instrumentations are enabled, so loading
// microtel without enabling them creates no AsyncLocalStorage.
let adapter = new DefaultContextAdapter();
let store = null;

function enableContextStore() {
  store ??= new ContextStore();
}

function isValidTarget(target) {
  return typeof target === 'string' && target !== '';
}

// Makes a request's Context current for its handler. Each request starts
// from the root Context, with the span as its operation and the inbound
// baggage header. The token is never disposed, so the Context stays current
// after the request ends. Returns the request's Operation, which the caller
// keeps to read the target when the span ends, without the adapter.
// https://nodejs.org/api/async_context.html#asynclocalstoragewithscopestore
// TODO(legendecas): Return the token too, once a caller needs to restore the
// previous Context.
function enterRequest(span) {
  const context = adapter.setValues(undefined, {
    traceContext: TraceContext.fromSpan(span),
    // The span itself is the Operation, since it already holds the target.
    // TODO(legendecas): Give the Operation an object of its own, so an
    // adapter can't reach the span through it.
    operation: span,
    baggage: span.baggage,
  });
  store.attach(context);
  return getOperation(context);
}

// The current Context, or undefined for the root Context.
function getCurrentContext() {
  return store?.active();
}

// Get TraceContext from the given context.
// A malformed value from an adapter reads as absent rather than throwing.
// The SDK "SHOULD provide safe defaults for missing or invalid arguments".
// A TraceContext microtel built from a span's own IDs needs no check.
// https://opentelemetry.io/docs/specs/otel/error-handling/#basic-error-handling-principles
function getTraceContext(ctx) {
  if (ctx == null) return undefined;
  const traceContext = adapter.getValue(ctx, 'traceContext');
  if (traceContext instanceof TraceContext) return traceContext;
  return TraceContext.isValid(traceContext) ? traceContext : undefined;
}

// Get Operation from the given context.
// The Context is immutable, but the Operation it holds is not. A consumer
// sets `operation.target`, the low-cardinality part of a span name, like
// {target} for HTTP or {destination} for messaging, which "SHOULD describe
// the entity that the operation is performed against".
// https://opentelemetry.io/docs/specs/semconv/http/http-spans/#name
// https://opentelemetry.io/docs/specs/semconv/messaging/messaging-spans/#span-name
function getOperation(context) {
  if (context == null) return undefined;
  const operation = adapter.getValue(context, 'operation');
  return typeof operation === 'object' && operation !== null
    ? operation
    : undefined;
}

// Get inbound baggage header from the given context.
// TODO(legendecas): Add a baggage API with structured access, following the
// W3C Baggage format and the OpenTelemetry Baggage API, and document the key.
// https://www.w3.org/TR/baggage/
// https://opentelemetry.io/docs/specs/otel/baggage/api/
function getBaggage(context) {
  if (context == null) return undefined;
  const baggage = adapter.getValue(context, 'baggage');
  return typeof baggage === 'string' && baggage !== '' ? baggage : undefined;
}

// Once per Node.js environment, before any request is traced.
function setAdapter(newAdapter) {
  if (!(adapter instanceof DefaultContextAdapter)) {
    const err = new Error('Invalid state: a context adapter is already set');
    err.code = 'ERR_INVALID_STATE';
    throw err;
  }
  validateObject(newAdapter, 'adapter');
  for (const name of kAdapterMethods) {
    if (typeof newAdapter[name] !== 'function')
      throw invalidArgTypeError(
        `adapter.${name}`,
        'Function',
        newAdapter[name],
      );
  }
  adapter = newAdapter;
  store = new ContextStore();
  return store;
}

module.exports = {
  enableContextStore,
  enterRequest,
  getBaggage,
  getCurrentContext,
  getOperation,
  getTraceContext,
  isValidTarget,
  setAdapter,
};
