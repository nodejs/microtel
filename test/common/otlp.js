'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const protobuf = require('protobufjs');

// OpenTelemetry Proto v1.9.0, pinned to its immutable commit. Schemas are
// downloaded only for tests and cached in the system temporary directory.
const revision = 'a8951735f7801e8adfaec5c0ace9262771cfec6e';
const cache = path.join(os.tmpdir(), 'microtel-otlp', revision);
const files = [
  'common/v1/common.proto',
  'resource/v1/resource.proto',
  'trace/v1/trace.proto',
  'collector/trace/v1/trace_service.proto',
];

async function loadOtlp() {
  await Promise.all(
    files.map(async (name) => {
      const relative = `opentelemetry/proto/${name}`;
      const filename = path.join(cache, relative);
      try {
        await fs.access(filename);
        return;
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
      try {
        const response = await fetch(
          `https://raw.githubusercontent.com/open-telemetry/opentelemetry-proto/${revision}/${relative}`,
          { signal: AbortSignal.timeout(10000) },
        );
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const source = await response.text();
        await fs.mkdir(path.dirname(filename), { recursive: true });
        const temporary = `${filename}.${process.pid}.tmp`;
        await fs.writeFile(temporary, source);
        await fs.rename(temporary, filename);
      } catch (err) {
        throw new Error(
          `Cannot download OTLP test schema ${relative}; the first test run needs access to raw.githubusercontent.com`,
          { cause: err },
        );
      }
    }),
  );
  const root = new protobuf.Root();
  root.resolvePath = (_origin, target) => path.join(cache, target);
  root.loadSync('opentelemetry/proto/collector/trace/v1/trace_service.proto');
  return {
    Request: root.lookupType(
      'opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest',
    ),
    Response: root.lookupType(
      'opentelemetry.proto.collector.trace.v1.ExportTraceServiceResponse',
    ),
    Span: root.lookupType('opentelemetry.proto.trace.v1.Span'),
  };
}

module.exports = { loadOtlp };
