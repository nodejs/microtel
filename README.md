# @nodejs/microtel

Node.js experimental OpenTelemetry built-in support.

> This module is under active development and is not yet ready for use.

This project aims to be an independent implementation of _parts_ of OpenTelemetry. It is focused on supporting the [traces](https://opentelemetry.io/docs/concepts/signals/traces/) signal alongside tracing context propagation.
It's intended to be included in Node.js core as a dependency, and wired up in there accordingly.
It seeks to enable:

* Instrumentation of inbound and outbound HTTP transactions, following [OTel Semconv](https://opentelemetry.io/docs/specs/semconv/general/trace/).
* Tracing data egress via OTLP/JSON. (JSON-only to avoid bringing in a gRPC dependency.)
* Distributed tracing via W3C Traceparent, including forwarding baggage (but not modifying it).

Anything else, including the following, should be considered initally out of scope:

* Any sort of programmatic API in Node.js core
* Creation of spans other than the built-in ones
* Metrics via OTLP
* Logs via OTLP
* Publishing to npm (it's only intended as a dependency of Node.js for now, but this could change in the future, maybe)

## Usage

Everything is controlled through a single exported function, `init()`. There
are no environment variables and no command-line flags. The other two exports,
`isActive()` and `flush()`, report state and force an export.

```js
const otel = require('@nodejs/microtel');

otel.init({
  endpoint: 'http://collector.example.com:4318',
  serviceName: 'my-service',
});
```

Tracing is activated at most once per process. Calling `init()` a second time
is a no-op, even with different options. There is no way to stop tracing once
started. Invalid options throw.

### Options

| Option           | Type   | Default                      | Description |
| ---------------- | ------ | ---------------------------- | ----------- |
| `endpoint`       | string | `http://localhost:4318`      | Base URL of an OTLP/HTTP collector. Only `http:` and `https:` URLs are accepted. `/v1/traces` is appended to the endpoint's existing path. An endpoint already ending with `/v1/traces` is used as is. |
| `serviceName`    | string | `unknown_service:node`      | Service name in exported resource attributes. The default follows the OpenTelemetry [semantic conventions](https://opentelemetry.io/docs/specs/semconv/general/trace/) for low-cardinality service names. |
| `sdkName`        | string | `microtel`                   | `telemetry.sdk.name` resource attribute, and the name of the instrumentation scope on exported spans. |
| `sdkVersion`    | string | this package's version      | `telemetry.sdk.version` resource attribute, and the scope version. |
| `filter`         | string | all modules                  | Comma-separated list of modules to instrument. Supported values: `node:http`, `node:http/client`, `node:http/server`, `node:http2`, `node:http2/server`, and `node:undici`. `node:http` covers `node:http/client` and `node:http/server`; `node:http2` covers `node:http2/server`. `node:fetch` is an alias for `node:undici`: both cover all undici requests, including `fetch()`, and either one enables them. |
| `exclude`        | string | none                         | Comma-separated list of modules to exclude from instrumentation. Same values as `filter`; takes precedence over it. |
| `maxBufferSize`  | number | `100`                        | Number of spans buffered before an immediate flush is triggered. Must be a positive integer. |
| `flushInterval`  | number | `10000`                      | Milliseconds between periodic flushes. Must be a positive integer. |
| `exportTimeout`  | number | `10000`                      | Milliseconds to wait for a collector response before an export is failed. Must be a positive integer. |

### Exported functions

* `init(options)` activates tracing. Returns nothing. Throws on invalid options.
* `isActive()` returns whether tracing was activated.
* `flush()` exports any buffered spans immediately. Also runs on `beforeExit`.

## Instrumented operations

When tracing is active, spans are created automatically for the following
operations. Per the OpenTelemetry [semantic conventions](https://opentelemetry.io/docs/specs/semconv/http/http-spans/), span
names must be low cardinality. Node.js core has no route concept, so spans are
named `{method}` and the request details live in the attributes. Requests the
exporter itself sends to the collector's export path are never traced, on
either side; other requests, including other requests to the collector's
host, are.

### HTTP server

A span with kind `SERVER` is created for each incoming HTTP request. The span
starts when the request is received and ends when the response finishes. If the
client disconnects before the response completes, the span ends with an error
status.

Server spans receive error status (`STATUS_ERROR`) for 5xx response codes. 4xx
responses are not treated as server errors per OpenTelemetry semantic
conventions.

Attributes set on server spans:

| Attribute                   | Description                      | Condition                     |
| --------------------------- | -------------------------------- | ----------------------------- |
| `http.request.method`       | HTTP method (e.g. `GET`, `POST`) | Always                        |
| `url.path`                  | Request URL path (without query) | Always                        |
| `url.query`                 | Query string (without `?`)       | When query string is present  |
| `url.scheme`                | `http` or `https`                | Always                        |
| `server.address`            | Requested host, without the port | When `Host` header is present |
| `network.protocol.version`  | HTTP version (e.g. `1.1`)        | Always                        |
| `http.response.status_code` | Response status code             | When response finishes        |
| `error.type`                | HTTP status code as string       | On 5xx responses              |

### HTTP/2 server

A span with kind `SERVER` is created for each incoming HTTP/2 request
stream, whether over cleartext (`http2.createServer`) or TLS
(`http2.createSecureServer`). The span starts when the request headers are
received and ends when the stream closes, so its duration covers the full
response transfer. Incoming `traceparent`/`tracestate` headers are parsed
with the same semantics as for HTTP/1.1 servers.

If a stream is aborted before the response completes, the span ends with an
error status. Server spans receive error status (`STATUS_ERROR`) for 5xx
response codes; 4xx responses are not server errors.

Attributes set on HTTP/2 server spans:

| Attribute                   | Description                      | Condition                     |
| --------------------------- | -------------------------------- | ----------------------------- |
| `http.request.method`       | HTTP method (e.g. `GET`, `POST`) | Always                        |
| `url.path`                  | Request URL path (without query) | Always                        |
| `url.query`                 | Query string (without `?`)       | When query string is present  |
| `url.scheme`                | `http` or `https`                | Always                        |
| `server.address`            | `:authority` pseudo-header value | When present                  |
| `network.protocol.version`  | `2.0`                            | Always                        |
| `http.response.status_code` | Response status code             | When the response is sent     |
| `error.type`                | HTTP status code as string       | On 5xx responses              |

### HTTP client

A span with kind `CLIENT` is created for each outgoing HTTP request made via
`node:http`. The span starts when the request is created and ends when the
response body completes or an error occurs.

Client spans receive error status (`STATUS_ERROR`) for 4xx and 5xx response
codes. On connection errors, an `exception` event is added to the span with
`exception.type`, `exception.message`, and `exception.stacktrace` attributes.

Attributes set on client spans:

| Attribute                   | Description               | Condition                 |
| --------------------------- | ------------------------- | ------------------------- |
| `http.request.method`       | HTTP method               | Always                    |
| `url.full`                  | Full request URL          | Always                    |
| `server.address`            | Target host                | Always                    |
| `server.port`               | Target port                | Always                    |
| `http.response.status_code` | Response status code      | When response is received |
| `network.protocol.version`  | HTTP version              | When response is received |
| `error.type`                | Status code or error name | On 4xx/5xx or errors      |

The `server.port` value is the decimal port from the Host header, or the scheme
default (`80` for `http:`, `443` for `https:`) when the header omits it; a
port that is not a decimal number is omitted.

### Undici/Fetch client

A span with kind `CLIENT` is created for each outgoing request made via
`fetch()` or undici's `request()`. Error status, `exception` event behavior,
and span end timing are the same as for the HTTP client spans above. Requests
that fail before they are dispatched, such as a refused connection, produce
no span: the undici channels only fire once the request is underway. The
injected `traceparent` replaces any caller-supplied value rather than
appending to it, a stale `tracestate` is removed when the span has none to
inherit, and the inherited `baggage` replaces any caller-supplied value the
same way.

Attributes set on undici/fetch client spans:

| Attribute                   | Description               | Condition                 |
| --------------------------- | ------------------------- | ------------------------- |
| `http.request.method`       | HTTP method               | Always                    |
| `url.full`                  | Full request URL          | Always                    |
| `server.address`            | Target host               | Always                    |
| `server.port`               | Target port               | Always                    |
| `http.response.status_code` | Response status code      | When response is received |
| `error.type`                | Status code or error name | On 4xx/5xx or errors      |

The `server.port` value is the explicit port from the request origin, or the
scheme default (`80` for `http:`, `443` for `https:`) when the origin omits it.

## W3C Trace Context propagation

Tracing automatically propagates [W3C Trace Context](https://www.w3.org/TR/trace-context/) across HTTP boundaries:

* **Incoming requests**: The `traceparent` header is read from incoming HTTP
and HTTP/2 requests, and child spans created during request processing
inherit the trace ID. `traceparent` values using a version other than `00` are
rejected, and a fresh trace is started instead. The `tracestate` header, when
present, is attached to the span and forwarded verbatim to outgoing requests.
It is never parsed or modified. The `baggage` header is likewise attached and
forwarded verbatim, never parsed or modified; per the W3C Baggage specification
it propagates independently of `traceparent`, so it is carried forward even
when the `traceparent` is absent or rejected.
* **Outgoing requests**: The `traceparent` header is injected into outgoing
HTTP and undici/fetch requests, together with the stored `tracestate` and
`baggage` when present, enabling distributed tracing across services. Baggage
is a propagated header, not a span attribute, so it never appears in the
exported span data. Outgoing `node:http2` requests receive no injection; see
the limitations below.

## Benchmarks

The HTTP benchmark uses the experimental `node:bench` runner, which is also
what sets the package's Node.js floor (`engines` requires 26.9.0 or newer):

```bash
node --experimental-bench --bench 'benchmark/*.bench.js'
```

The traced and untraced configurations live in separate files: the runner
executes each file in its own child process, and tracing activates at most
once per process. The traced run exports to a local dummy collector, so the
measurement includes the export round trip.

## Current limitations

The tracing subsystem is independent of the OpenTelemetry JavaScript packages. It
is not interoperable with `@opentelemetry/api`, and spans created by one are not
visible to the other. Running both in the same process produces duplicate trace
and span IDs. The built-in instrumentation also overwrites the `traceparent`
(and, when present, `tracestate`) header on outgoing HTTP requests, and
replaces the `baggage` header when the span carries one, discarding whatever a
userland propagator may have set. Users should run either this package or a
userland OpenTelemetry SDK, not both.

`init()` activates tracing in the thread that calls it. Worker threads
(`node:worker_threads`) are not traced unless they call `init()` themselves.

Outgoing requests made through `node:http2` are not traced, on either the
span or the propagation side. Node's HTTP/2 client diagnostics channels
publish a detached snapshot of the request headers after they have already
been serialized for the wire, so there is no seam at which the
instrumentation could inject a `traceparent` or remove a stale `tracestate`.
Inbound HTTP/2 context is fully parsed; only the client side is affected.

Buffered spans are exported periodically, when the buffer fills, and when the
event loop is about to drain. Spans that are still buffered when `process.exit()`
is called explicitly are lost, because explicit exits do not run the exit-time
flush.

## License

[MIT](./LICENSE)
