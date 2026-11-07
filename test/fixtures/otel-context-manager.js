'use strict';

// An OpenTelemetry ContextManager backed by microtel's context store, to test
// the context adapter interface.

const { ROOT_CONTEXT, createContextKey, trace } = require('@opentelemetry/api');
const {
  RPCType,
  TraceState,
  deleteRPCMetadata,
  getRPCMetadata,
  setRPCMetadata,
} = require('@opentelemetry/core');

// microtel's operation over OpenTelemetry's RPC metadata, where framework
// instrumentations set the target as the route.
class RPCMetadataOperation {
  #metadata;

  constructor(metadata) {
    this.#metadata = metadata;
  }

  get target() {
    return this.#metadata.route;
  }

  set target(target) {
    this.#metadata.route = target;
  }
}

// How each of microtel's keys reads from and writes to an OpenTelemetry
// Context. set() removes the value when it is undefined.
const kMicrotelKeyMappings = {
  __proto__: null,
  traceContext: {
    // A SpanContext already has the fields of microtel's trace context.
    get: (ctx) => trace.getSpanContext(ctx),
    // microtel's TraceState only serializes, so it is parsed into a full
    // OpenTelemetry TraceState.
    // TODO(legendecas): remove parsing when microtel TraceState has
    // structured API.
    set(ctx, value) {
      if (value === undefined) return trace.deleteSpan(ctx);
      const { traceId, spanId, traceFlags, traceState, isRemote } = value;
      const spanContext = { traceId, spanId, traceFlags, isRemote };
      if (traceState)
        spanContext.traceState = new TraceState(traceState.serialize());
      return trace.setSpanContext(ctx, spanContext);
    },
  },
  operation: {
    get(ctx) {
      const metadata = getRPCMetadata(ctx);
      return metadata && new RPCMetadataOperation(metadata);
    },
    set(ctx, value) {
      if (value === undefined) return deleteRPCMetadata(ctx);
      return setRPCMetadata(ctx, {
        type: RPCType.HTTP,
        route: value.target,
        span: trace.getSpan(ctx),
      });
    },
  },
};

// A key without an OpenTelemetry equivalent is kept under a context key of
// its own, so a key microtel adds needs no change here.
function opaqueMapping(key) {
  const contextKey = createContextKey(`microtel ${key}`);
  return {
    get: (ctx) => ctx.getValue(contextKey),
    set: (ctx, value) =>
      value === undefined
        ? ctx.deleteValue(contextKey)
        : ctx.setValue(contextKey, value),
  };
}

const mappingOf = (key) => kMicrotelKeyMappings[key] ?? opaqueMapping(key);

// Gets and sets microtel's values in OpenTelemetry Contexts.
class MicrotelContextAdapter {
  getValue(ctx, key) {
    return mappingOf(key).get(ctx);
  }

  setValues(ctx = ROOT_CONTEXT, values) {
    for (const [key, value] of Object.entries(values))
      ctx = mappingOf(key).set(ctx, value);
    return ctx;
  }
}

// The ContextManager interface over microtel's store, in place of
// AsyncLocalStorageContextManager's own AsyncLocalStorage. Event emitters are
// not bound, which these tests don't need.
class MicrotelContextManager {
  #store;

  constructor(microtel) {
    this.#store = microtel.context.registerAdapter(
      new MicrotelContextAdapter(),
    );
  }

  active() {
    return this.#store.active() ?? ROOT_CONTEXT;
  }

  with(ctx, fn, thisArg, ...args) {
    const cb = thisArg == null ? fn : fn.bind(thisArg);
    return this.#store.with(ctx, cb, ...args);
  }

  bind(ctx, target) {
    if (typeof target !== 'function') return target;
    const manager = this;
    return function (...args) {
      return manager.with(ctx, () => target.apply(this, args));
    };
  }

  attach(ctx) {
    return this.#store.attach(ctx);
  }

  enable() {
    return this;
  }

  disable() {
    return this;
  }
}

module.exports = { MicrotelContextManager };
