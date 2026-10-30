'use strict';

const { bench } = require('node:bench');
const { Span, SPAN_KIND_CLIENT, SPAN_KIND_SERVER } = require('../lib/span');

const kSpansPerSample = 100_000;
const kTraceparent = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';

// Spans stay alive in a ring, so allocation and GC behave as they do while
// spans wait for export. They are never ended, so nothing is exported.
const ring = Array.from({ length: 1024 });

bench('client span construction', { samples: 30 }, (b) => {
  b.start();
  for (let i = 0; i < kSpansPerSample; i++) {
    const span = new Span('GET', SPAN_KIND_CLIENT);
    span.setAttribute('http.request.method', 'GET');
    span.setAttribute('server.address', '127.0.0.1');
    span.setAttribute('server.port', 8080);
    span.setAttribute('url.full', 'http://127.0.0.1:8080/api/data');
    span.setAttribute('network.protocol.version', '1.1');
    span.setAttribute('http.response.status_code', 200);
    ring[i & 1023] = span;
  }
  b.end(kSpansPerSample);
});

bench('server span from a traceparent', { samples: 30 }, (b) => {
  b.start();
  for (let i = 0; i < kSpansPerSample; i++) {
    const parent = Span.fromTraceparent(kTraceparent);
    const span = new Span('GET', SPAN_KIND_SERVER, { parent });
    span.setAttribute('http.request.method', 'GET');
    span.setAttribute('url.path', '/api/data');
    span.setAttribute('url.scheme', 'http');
    span.setAttribute('network.protocol.version', '1.1');
    span.setAttribute('server.address', '127.0.0.1');
    span.setAttribute('http.response.status_code', 200);
    ring[i & 1023] = span;
  }
  b.end(kSpansPerSample);
});
