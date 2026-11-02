'use strict';

// Exports a mix of spans to a real OpenTelemetry Collector and checks what
// it decoded, which the fake collector in the other tests cannot vouch for.
// The collector writes the spans to the file named by COLLECTOR_OUTPUT. CI
// starts it with test/collector/config.yaml. To run it locally, from a
// directory Docker can share, such as one under the home directory:
//
//   export COLLECTOR_OUTPUT="$HOME/.cache/microtel-collector/spans.jsonl"
//   mkdir -p "$(dirname "$COLLECTOR_OUTPUT")"
//   docker run -d --rm --name microtel-collector --user "$(id -u):$(id -g)" \
//     -p 127.0.0.1:4318:4318 -e COLLECTOR_OUTPUT \
//     -v "$PWD/test/collector/config.yaml:/etc/otelcol/config.yaml:ro" \
//     -v "$(dirname "$COLLECTOR_OUTPUT"):$(dirname "$COLLECTOR_OUTPUT")" \
//     otel/opentelemetry-collector:0.164.0 --config /etc/otelcol/config.yaml
//   node --test test/collector/
//   docker stop microtel-collector

const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const http2 = require('node:http2');
const { before, describe, it } = require('node:test');
const microtel = require('../..');
const {
  delay,
  getClientSpan,
  getServerSpan,
  rawRequest,
  spanAttrs,
} = require('../common/otel');

const kEndpoint = 'http://127.0.0.1:4318';
const kOutput = process.env.COLLECTOR_OUTPUT;
// Unique per run, so spans from earlier runs in the same file never count.
const kServiceName = `microtel-collector-test-${Date.now()}`;
// Every span the traffic below makes: a server span per path, and a client
// span per URL suffix.
const kServerPaths = [
  '/api/data',
  '/missing',
  '/boom',
  '/q"uo\\te',
  '/child',
  '/via-fetch',
  '/h2-path',
];
const kClientUrls = [
  '/api/data?x=1&y=two',
  '/missing',
  '/boom',
  '/q"uo\\te',
  '/via-fetch',
  '127.0.0.1:1/refused',
];
const kSpanCount = kServerPaths.length + kClientUrls.length;
const kCallerTraceId = '0af7651916cd43dd8448eb211c80319c';
const kCallerSpanId = 'b7ad6b7169203331';
const kCallerTraceState = 'rojo=00f067aa0ba902b7';

const get = (options) =>
  new Promise((resolve) =>
    http
      .get(options, (res) => {
        res.resume();
        res.on('end', resolve);
      })
      .on('error', () => resolve()),
  );

// The collector answers any request once it is ready.
async function waitForCollector() {
  for (let i = 0; i < 60; i++) {
    const ready = await new Promise((resolve) =>
      http
        .get(kEndpoint, { timeout: 1000 }, (res) => {
          res.resume();
          resolve(true);
        })
        .on('timeout', function () {
          this.destroy();
        })
        .on('error', () => resolve(false)),
    );
    if (ready) return;
    await delay(500);
  }
  throw new Error(`No collector answered at ${kEndpoint}`);
}

async function sendTraffic() {
  const server = http.createServer((req, res) => {
    if (req.url === '/missing') res.writeHead(404);
    else if (req.url === '/boom') res.writeHead(500);
    res.end('ok');
  });
  const h2 = http2.createServer();
  h2.on('stream', (stream) => {
    stream.respond({ ':status': 200 });
    stream.end('ok');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  await new Promise((resolve) => h2.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  await get(`http://127.0.0.1:${port}/api/data?x=1&y=two`);
  await get(`http://127.0.0.1:${port}/missing`);
  await get(`http://127.0.0.1:${port}/boom`);
  // Characters the encoder must escape. A path option is sent as written,
  // where a URL string would be percent-encoded first. Node's parser
  // rejects a raw non-ASCII byte in a path but not in a Host header.
  await get({
    host: '127.0.0.1',
    port,
    path: '/q"uo\\te',
    headers: { host: 'caf\u00e9' },
  });
  await rawRequest(port, '/child', {
    traceparent: `00-${kCallerTraceId}-${kCallerSpanId}-01`,
    tracestate: kCallerTraceState,
  });
  await fetch(`http://127.0.0.1:${port}/via-fetch`).then((res) => res.text());
  await new Promise((resolve) => {
    const session = http2.connect(`http://127.0.0.1:${h2.address().port}`);
    session.on('error', resolve);
    const stream = session.request({ ':path': '/h2-path' });
    stream.resume();
    stream.on('close', () => {
      session.close();
      resolve();
    });
  });
  await get('http://127.0.0.1:1/refused');

  server.close();
  h2.close();
}

// The spans of this run the collector has written so far. A line still being
// written has no newline yet, so only complete lines are read.
function writtenSpans() {
  if (!fs.existsSync(kOutput)) return [];
  const lines = fs.readFileSync(kOutput, 'utf8').split('\n');
  lines.pop();
  const spans = [];
  for (const line of lines) {
    for (const { resource, scopeSpans } of JSON.parse(line).resourceSpans) {
      const service = resource.attributes.find((a) => a.key === 'service.name');
      if (service?.value.stringValue !== kServiceName) continue;
      for (const scope of scopeSpans) spans.push(...scope.spans);
    }
  }
  return spans;
}

// flush() does not report when its export lands, so the file is polled.
async function collectedSpans() {
  for (let i = 0; i < 40; i++) {
    const spans = writtenSpans();
    if (spans.length >= kSpanCount) return spans;
    await delay(500);
  }
  return writtenSpans();
}

describe('otel exports to a real OpenTelemetry Collector', () => {
  const warnings = [];
  let spans;

  before(
    async () => {
      assert.ok(
        kOutput,
        'COLLECTOR_OUTPUT must name the collector output file',
      );
      process.on('warning', (w) => warnings.push(`${w.name}: ${w.message}`));
      await waitForCollector();
      microtel.init({ endpoint: kEndpoint, serviceName: kServiceName });
      await sendTraffic();
      microtel.flush();
      spans = await collectedSpans();
    },
    { timeout: 120_000 },
  );

  it('exports without warnings', () => {
    assert.deepStrictEqual(warnings, []);
  });

  it('delivers every span, once', () => {
    const count = (kind, matches) =>
      spans.filter((s) => s.kind === kind && matches(spanAttrs(s))).length;
    for (const path of kServerPaths)
      assert.strictEqual(
        count(2, (a) => a['url.path'] === path),
        1,
        path,
      );
    for (const url of kClientUrls)
      assert.strictEqual(
        count(3, (a) => a['url.full'].endsWith(url)),
        1,
        url,
      );
    assert.strictEqual(spans.length, kSpanCount);
  });

  it('keeps IDs and timestamps in OTLP form', () => {
    for (const span of spans) {
      assert.match(span.traceId, /^[0-9a-f]{32}$/);
      assert.match(span.spanId, /^[0-9a-f]{16}$/);
      assert.match(span.startTimeUnixNano, /^\d+$/);
      assert.ok(BigInt(span.endTimeUnixNano) >= BigInt(span.startTimeUnixNano));
    }
  });

  it('keeps attributes, including ones the encoder must escape', () => {
    assert.strictEqual(
      spanAttrs(getServerSpan(spans, '/api/data'))['url.query'],
      'x=1&y=two',
    );
    assert.partialDeepStrictEqual(
      spanAttrs(getServerSpan(spans, '/q"uo\\te')),
      {
        'server.address': 'caf\u00e9',
      },
    );
    assert.strictEqual(
      spanAttrs(getClientSpan(spans, '/q"uo\\te'))['url.full'],
      'http://caf\u00e9/q"uo\\te',
    );
  });

  it("keeps a caller's trace, parent, and tracestate", () => {
    assert.partialDeepStrictEqual(getServerSpan(spans, '/child'), {
      traceId: kCallerTraceId,
      parentSpanId: kCallerSpanId,
      traceState: kCallerTraceState,
      // The caller's sampled flag, and a parent known to be remote.
      flags: 0x301,
    });
  });

  it('marks trace flags and remote parents in span flags', () => {
    // A trace started here is sampled and has a random trace ID, flags
    // 0x03. The 0x100 bit means the next bit is set on purpose, and 0x200
    // marks a remote parent. Every parent here arrives in a traceparent
    // header.
    const child = getServerSpan(spans, '/child');
    for (const span of spans) {
      if (span === child) continue;
      const what = spanAttrs(span)['url.path'] ?? spanAttrs(span)['url.full'];
      assert.strictEqual(span.flags, span.parentSpanId ? 0x303 : 0x103, what);
      assert.strictEqual(span.traceState, undefined, what);
    }
  });

  it('keeps statuses and exception events', () => {
    assert.strictEqual(getClientSpan(spans, '/missing').status.code, 2);
    // The collector writes an unset status as an empty one.
    assert.strictEqual(getServerSpan(spans, '/missing').status.code, undefined);
    assert.strictEqual(getServerSpan(spans, '/boom').status.code, 2);
    const refused = getClientSpan(spans, '/refused');
    assert.strictEqual(refused.status.code, 2);
    const exception = refused.events.find((e) => e.name === 'exception');
    assert.match(exception.timeUnixNano, /^\d+$/);
    assert.strictEqual(spanAttrs(exception)['exception.type'], 'Error');
    assert.match(spanAttrs(exception)['exception.message'], /ECONNREFUSED/);
  });

  it('delivers fetch and HTTP/2 spans', () => {
    assert.ok(getClientSpan(spans, '/via-fetch'));
    assert.strictEqual(
      spanAttrs(getServerSpan(spans, '/h2-path'))['network.protocol.version'],
      '2.0',
    );
  });
});
