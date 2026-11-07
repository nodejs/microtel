# Context

microtel propagates a [Context] across async execution. microtel sets its
values while tracing is active, or a registered adapter can supply them. This
document has two sections, for different readers of the API:

- [API consumers](#api-consumers), such as web frameworks and logging
  libraries, read and set values in the current Context.
- [Context adapters](#context-adapters) get and set microtel's values in
  another implementation's Context objects, so both share one current
  Context.

## API consumers

`microtel.context` holds a closed set of values, each with its own accessor.
There is no string-keyed access. Libraries that need other values keep them
in their own `AsyncLocalStorage`. These functions work the same whichever
adapter is registered.

Each accessor takes the Context to read or write. Get the current Context
once with `context.active()` and pass it to every accessor you call:

```js
const ctx = context.active();
const traceContext = context.getTraceContext(ctx);
const target = context.getTarget(ctx);
```

### `context.active()`

- Returns: {any} The current Context, or `undefined` when none is current.

The Context is an opaque value. Pass it to the accessors without reading it
directly.

### Type: `TraceContext`

A read-only object. Modifying any of its fields is undefined behavior.

- `traceId` {string} The [trace-id].
- `spanId` {string} The span's ID, propagated as the [parent-id].
- `traceFlags` {number} The [trace-flags].
- `traceState` {Object|undefined} The [tracestate header], as an object with:
  - `serialize()` Returns: {string} The header.
- `isRemote` {boolean|undefined} [IsRemote], `true` when the trace context
  came from another process.

### `context.getTraceContext(ctx)`

- `ctx` {any} A Context from `context.active()`.
- Returns: {TraceContext|undefined}

Returns the trace context of the span in `ctx`, or `undefined` when it
has none.

### `context.getTarget(ctx)`

- `ctx` {any} A Context from `context.active()`.
- Returns: {string|undefined}

Returns the target of the operation being traced in `ctx`. It is a
low-cardinality name for what the operation is performed against, such as
the route template `/users/:id`. Returns `undefined` when none was set or
`ctx` has no operation.

### `context.setTarget(ctx, target)`

- `ctx` {any} A Context from `context.active()`.
- `target` {string} A low-cardinality name for what the operation is
  performed against, such as the route template `/users/:id`.
- Returns: {boolean}

Sets the target of the operation being traced in `ctx`, which microtel
records on the operation's span. Returns `false` when `ctx` has no
operation, and `true` otherwise. microtel puts an operation in the Context of
each incoming request it traces. Only the code that resolved the target, such
as a framework's router, should set it.

The target is the low-cardinality part of a span name that says what the
operation acts on, like `{target}` in an [HTTP span name], the method in an
[RPC span name], or `{destination}` in a [messaging span name].

## Context adapters

### Adapter and store

microtel treats each Context as an opaque value. It never reads or builds
one directly, only through the adapter, so an adapter can represent a
Context however it likes, such as its own Context objects with values of its
own next to microtel's.

Two objects with separate roles handle Contexts:

- The **adapter** defines what a Context is. It gets microtel's values from
  a Context and makes new Contexts with values set. It never decides which
  Context is current.
- The **store** tracks which Context is current in each async execution. It
  holds Contexts without looking inside them.

microtel starts with a default adapter, whose Contexts hold only microtel's
values, and a store of its own.

### `context.registerAdapter(adapter)`

- `adapter` {Object} An [adapter](#adapter-interface).

Replaces the default adapter and returns a new [store](#store), which the
adapter uses to make its Contexts current.

Call it as soon as the process starts, before microtel traces any request. A
request already in flight keeps its Context in the old store, so the requests
it makes after the call start new traces.

It can be called once per Node.js environment, such as the main thread or a
worker. A second call throws `ERR_INVALID_STATE`.

### Adapter interface

An adapter implements the Context API's [Get value] and [Set value] for
microtel's [keys](#keys).

#### `adapter.getValue(context, key)`

- `context` A Context this adapter made.
- `key` {string} One of the [keys](#keys).

Returns microtel's value for `key` in `context`.

#### `adapter.setValues(context, values)`

- `context` A Context this adapter made, or `undefined` for the root
  Context.
- `values` {Object} Values by [key](#keys).

Returns a new Context with each key of `values` set, or removed when its
value is `undefined`.

#### Keys

- `traceContext` The trace context `context.getTraceContext()` returns.
- `operation` {Operation} The metadata of the operation being traced. See
  [`Operation`](#type-operation).

microtel may set other keys. An adapter maps the keys it understands onto its
own Context and stores the rest as they are, so a key microtel adds needs no
change to the adapter.

#### Type: `Operation`

The metadata of the operation being traced. It is shared by every Context
derived while the operation is traced, so a value set on it stays visible
until the operation ends.

- `target` {string|undefined} See
  [`context.getTarget()`](#contextgettargetctx). microtel reads it when the
  operation's span ends, and `context.setTarget()` writes it.

### Store

The store's methods are the Context API's [optional global operations].

#### `store.active()`

Returns the current Context, or `undefined` for the root Context.

#### `store.with(context, fn[, ...args])`

Calls `fn` with `context` current, and returns what `fn` returns.

#### `store.attach(context)`

Makes `context` current, and returns a token whose `dispose()` restores the
previous Context.

[Context]: https://opentelemetry.io/docs/specs/otel/context/
[Get value]: https://opentelemetry.io/docs/specs/otel/context/#get-value
[HTTP span name]: https://opentelemetry.io/docs/specs/semconv/http/http-spans/#name
[IsRemote]: https://opentelemetry.io/docs/specs/otel/trace/api/#isremote
[messaging span name]: https://opentelemetry.io/docs/specs/semconv/messaging/messaging-spans/#span-name
[optional global operations]: https://opentelemetry.io/docs/specs/otel/context/#optional-global-operations
[parent-id]: https://www.w3.org/TR/trace-context/#parent-id
[RPC span name]: https://opentelemetry.io/docs/specs/semconv/rpc/rpc-spans/#name
[Set value]: https://opentelemetry.io/docs/specs/otel/context/#set-value
[trace-flags]: https://www.w3.org/TR/trace-context/#trace-flags
[trace-id]: https://www.w3.org/TR/trace-context/#trace-id
[tracestate header]: https://www.w3.org/TR/trace-context/#tracestate-header
