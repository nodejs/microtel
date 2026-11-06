'use strict';

// Spawned with JSON on argv[2], { mode, init }: runs microtel next to the
// OpenTelemetry SDK, sends one request with a caller's trace context through
// a traced frontend, flushes microtel, and prints the SDK's finished spans
// and the headers the backend received as JSON. The modes:
//   microtel-inbound: microtel traces every request, and OTel code in the
//     handler writes to the current span. A second request runs under a
//     remote span context the SDK holds, with no SDK span around it.
//   sdk-inbound: the SDK's HTTP instrumentation traces inbound requests, and
//     microtel traces outbound ones.
//   no-attach: the SDK's context manager has no attach(), so microtel keeps
//     its own context.

const { init, flush } = require(process.env.MICROTEL_PATH);
const { mode, init: options } = JSON.parse(process.argv[2]);
init(options);

const { context, trace } = require('@opentelemetry/api');
const {
  AsyncLocalStorageContextManager,
} = require('@opentelemetry/context-async-hooks');
const { suppressTracing } = require('@opentelemetry/core');
const { registerInstrumentations } = require('@opentelemetry/instrumentation');
const { HttpInstrumentation } = require('@opentelemetry/instrumentation-http');
const {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} = require('@opentelemetry/sdk-trace-base');
const { NodeTracerProvider } = require('@opentelemetry/sdk-trace-node');

const exporter = new InMemorySpanExporter();
const provider = new NodeTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(exporter)],
});
if (mode === 'no-attach') {
  const manager = new AsyncLocalStorageContextManager();
  provider.register({
    contextManager: {
      active: () => manager.active(),
      with: (...args) => manager.with(...args),
      bind: (...args) => manager.bind(...args),
      enable() {
        manager.enable();
        return this;
      },
      disable() {
        manager.disable();
        return this;
      },
    },
  });
} else {
  provider.register();
}
if (mode === 'sdk-inbound') {
  registerInstrumentations({
    instrumentations: [
      new HttpInstrumentation({ disableOutgoingRequestInstrumentation: true }),
    ],
  });
}

// Loaded after the instrumentation is registered, so it gets patched.
const http = require('node:http');
const tracer = trace.getTracer('test');

const get = (url, headers, done) =>
  http.get(url, { headers }, (res) => {
    res.resume();
    res.on('end', done);
  });

const received = {};
const backend = http.createServer((req, res) => {
  received[req.url] = req.headers;
  res.end('ok');
});
const frontend = http.createServer((req, res) => {
  // Without a current span the writes are skipped, so a broken bridge
  // fails the test's assertions instead of crashing this process.
  const current = trace.getActiveSpan();
  if (mode === 'microtel-inbound' && current) {
    current.setAttribute('app.tier', 'web');
    current.updateName('GET /users/:id');
    current.recordException(new Error('boom'));
    current.setStatus({ code: 2, message: 'failed' });
    current.end();
    // microtel has ended the span by the time this runs, so it must not
    // change.
    res.on('finish', () => current.setAttribute('app.late', 'yes'));
  }
  tracer.startActiveSpan('work', (work) => {
    get(`http://127.0.0.1:${backend.address().port}/down`, {}, () => {
      work.end();
      res.end('ok');
    });
  });
});

const listen = (server) =>
  new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

(async () => {
  await listen(backend);
  await listen(frontend);

  // This request stands in for an outside caller. Suppressing it keeps it
  // out of the trace, the same way the SDK's exporters opt out.
  await new Promise((resolve) =>
    context.with(suppressTracing(context.active()), () =>
      get(
        `http://127.0.0.1:${frontend.address().port}/front`,
        {
          traceparent:
            '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
          tracestate: 'vendor=state',
          baggage: 'user=alice',
        },
        resolve,
      ),
    ),
  );

  // A span context the SDK took from a caller, as its propagator extracts
  // one before any SDK span starts.
  if (mode === 'microtel-inbound') {
    const remote = trace.setSpanContext(context.active(), {
      traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
      spanId: '00f067aa0ba902b7',
      traceFlags: 1,
      isRemote: true,
    });
    await new Promise((resolve) =>
      context.with(remote, () =>
        get(`http://127.0.0.1:${backend.address().port}/remote`, {}, resolve),
      ),
    );
  }

  flush();
  frontend.close();
  backend.close();
  http.globalAgent.destroy();

  const spans = exporter.getFinishedSpans().map((span) => ({
    name: span.name,
    kind: span.kind,
    traceId: span.spanContext().traceId,
    spanId: span.spanContext().spanId,
    parentSpanId: span.parentSpanContext?.spanId,
    traceState: span.spanContext().traceState?.serialize(),
    attributes: span.attributes,
  }));
  process.stdout.write(JSON.stringify({ spans, received }));
})();
