'use strict';

const { OtlpEncoder } = require('../../lib/otlp');
const { Span, SPAN_KIND_CLIENT } = require('../../lib/span');
const { version } = require('../../package.json');

// Prebuild ended span models so benchmarks measure encoding/export rather
// than instrumentation, ID generation, or span construction.
function createInput(batchSize, exceptions) {
  const spans = Array.from({ length: batchSize }, (_, i) => {
    const span = new Span('GET', SPAN_KIND_CLIENT);
    span.setAttribute('http.request.method', 'GET');
    span.setAttribute('url.full', `https://example.com/items/${i}`);
    span.setAttribute('server.address', 'example.com');
    span.setAttribute('server.port', 443);
    span.setAttribute('network.protocol.version', '1.1');
    span.setAttribute('http.response.status_code', exceptions ? 503 : 200);
    if (exceptions) {
      span.setStatus(2, 'HTTP 503');
      span.setAttribute('error.type', '503');
      span.addEvent('exception', {
        'exception.type': 'Error',
        'exception.message': 'Unavailable 日本語 💥',
        'exception.stacktrace':
          'Error: unavailable\n' +
          '    at handler (/app/server.js:42:10)\n'.repeat(20),
      });
    }
    // Do not call end(): that would enqueue the span for automatic export.
    span.endTime = span.startTime + 10;
    return span;
  });
  const resource = {
    attributes: Object.entries({
      'service.name': 'benchmark',
      'telemetry.sdk.name': 'microtel',
      'telemetry.sdk.language': 'nodejs',
      'telemetry.sdk.version': version,
      'process.runtime.name': 'nodejs',
      'process.runtime.version': process.version,
      'process.pid': process.pid,
    }).map(([key, value]) => ({
      key,
      value:
        typeof value === 'number'
          ? { intValue: String(value) }
          : { stringValue: value },
    })),
  };
  return {
    spans,
    encoder: new OtlpEncoder(resource, { name: 'microtel', version }),
  };
}

module.exports = { createInput };
