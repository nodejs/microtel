'use strict';

const { randomUUID } = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');
const { validateHeaderName, validateHeaderValue } = require('node:http');

const { configureSampler } = require('./sampler');
const {
  invalidArgTypeError,
  invalidArgValueError,
  validateInteger,
  validateNumber,
  validateObject,
  validateString,
} = require('./validate');

const kDefaultEndpoint = 'http://localhost:4318';
const kDefaultServiceName = 'unknown_service:node';
const kDefaultSdkName = 'microtel';

let endpoint = null;
let active = false;
let filter = null; // null = all modules enabled; Set = only listed modules.
let exclude = null; // null = nothing excluded; Set = listed modules disabled.
let spanStorage = null;
let collectorHost = null; // Normalized host (e.g. "localhost:4318") for self-trace suppression.
let exportUrl = null; // The collector's full export URL, fixed after start.
let serviceName = kDefaultServiceName;
let sdkName = kDefaultSdkName;
let sdkVersion = null;
let exportHeaders = null; // Copied at init, sent with every export request.
let resourceAttributes = null; // A copy of options.resourceAttributes, made at init.
let instanceId = null; // Random per-process identity, made at init.

function getSpanStorage() {
  spanStorage ??= new AsyncLocalStorage();
  return spanStorage;
}

// A filter or exclude entry matches the module itself; a broader entry
// also matches its subscopes, so 'node:http' covers node:http/client and
// node:http/server.
function setMatches(set, moduleName) {
  if (set.has(moduleName)) return true;
  const slash = moduleName.lastIndexOf('/');
  return slash !== -1 && set.has(moduleName.slice(0, slash));
}

function isModuleEnabled(moduleName) {
  // Excluded modules are never instrumented, even when also included
  // through options.filter.
  if (exclude != null && setMatches(exclude, moduleName)) return false;
  if (filter == null) return true;
  return setMatches(filter, moduleName);
}

function parseFilter(name, filter) {
  if (filter == null) return null;
  if (typeof filter === 'string') {
    const parts = filter.split(',');
    const set = new Set();
    for (let i = 0; i < parts.length; i++) {
      const trimmed = parts[i].trim();
      if (trimmed) set.add(trimmed);
    }
    return set;
  }
  throw invalidArgTypeError(name, ['string', 'null', 'undefined'], filter);
}

// Header names the exporter itself sets or depends on, refused at any
// letter case. content-type and content-length are set on each export,
// host is matched against the collector's for self-trace suppression, and
// transfer-encoding, trailer, and connection belong to the framing and the
// keep-alive agent. Node refuses to send a trailer next to content-length.
const kReservedHeaders = new Set([
  'content-type',
  'content-length',
  'host',
  'transfer-encoding',
  'trailer',
  'connection',
]);

// Validates and copies the configured export headers, so a caller changing
// its object after init() has no effect.
// TODO(bengl): Accept a function for headers, called before each export and
// allowed to return a promise, so credentials that expire, such as OAuth2
// access tokens, can be refreshed while the process runs.
function parseHeaders(headers) {
  if (headers === undefined) return null;
  validateObject(headers, 'options.headers');
  const copy = { __proto__: null };
  for (const name of Object.keys(headers)) {
    const value = headers[name];
    validateHeaderName(name);
    if (kReservedHeaders.has(name.toLowerCase())) {
      throw invalidArgValueError(
        `options.headers['${name}']`,
        value,
        'is a header microtel sets itself',
      );
    }
    validateString(value, `options.headers['${name}']`);
    validateHeaderValue(name, value);
    copy[name] = value;
  }
  return copy;
}

// Resource keys that other options set. They are refused here, so each key
// has one place to be set.
const kOptionResourceKeys = {
  __proto__: null,
  'service.name': 'options.serviceName',
  'telemetry.sdk.name': 'options.sdkName',
  'telemetry.sdk.version': 'options.sdkVersion',
};

// Validates and copies options.resourceAttributes, so changes to the
// caller's object after init have no effect.
function validateResourceAttributes(attrs) {
  if (attrs === undefined) return null;
  validateObject(attrs, 'options.resourceAttributes');
  const copy = { __proto__: null };
  for (const key of Object.keys(attrs)) {
    const name = `options.resourceAttributes['${key}']`;
    const value = attrs[key];
    if (key === '')
      throw invalidArgValueError(
        'options.resourceAttributes',
        attrs,
        'must not have an empty key',
      );
    const option = kOptionResourceKeys[key];
    if (option !== undefined)
      throw invalidArgValueError(name, value, `is set through ${option}`);
    if (key.startsWith('telemetry.sdk.'))
      throw invalidArgValueError(name, value, 'is set by microtel');
    switch (typeof value) {
      case 'string':
      case 'boolean':
        break;
      case 'number':
        if (!Number.isFinite(value))
          throw invalidArgValueError(name, value, 'must be a finite number');
        break;
      default:
        throw invalidArgTypeError(name, ['string', 'boolean', 'number'], value);
    }
    copy[key] = value;
  }
  return copy;
}

function optionalString(options, name, fallback) {
  const value = options[name];
  if (value === undefined) return fallback;
  validateString(value, `options.${name}`);
  if (!value) {
    throw invalidArgValueError(
      `options.${name}`,
      value,
      'must be a non-empty string',
    );
  }
  return value;
}

function start(options = { __proto__: null }) {
  // Activation happens at most once per process and cannot be undone.
  if (active) return;

  validateObject(options, 'options');

  const endpointValue = optionalString(options, 'endpoint', kDefaultEndpoint);

  let parsed;
  try {
    parsed = new URL(endpointValue);
  } catch {
    throw invalidArgValueError(
      'options.endpoint',
      endpointValue,
      'must be a valid URL',
    );
  }

  // The exporter only speaks http(s). Since activation cannot be undone,
  // an unsupported protocol must throw here rather than disable tracing
  // for the whole process.
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw invalidArgValueError(
      'options.endpoint',
      endpointValue,
      'only http: and https: endpoints are supported',
    );
  }

  // /v1/traces is appended to the endpoint's path, unless the path already
  // ends with it. The resolved URL is fixed at activation: it drives both
  // the exports and the self-trace suppression.
  let pathname = parsed.pathname.replace(/\/+$/, '');
  if (!pathname.endsWith('/v1/traces')) pathname += '/v1/traces';
  parsed.pathname = pathname;
  parsed.search = '';

  if (options.maxBufferSize !== undefined)
    validateInteger(options.maxBufferSize, 'options.maxBufferSize', 1);
  if (options.flushInterval !== undefined)
    validateInteger(options.flushInterval, 'options.flushInterval', 1);
  if (options.exportTimeout !== undefined)
    validateInteger(options.exportTimeout, 'options.exportTimeout', 1);
  if (options.sampleRatio !== undefined)
    validateNumber(options.sampleRatio, 'options.sampleRatio', 0, 1);

  const parsedHeaders = parseHeaders(options.headers);

  const serviceNameValue = optionalString(
    options,
    'serviceName',
    kDefaultServiceName,
  );
  const sdkNameValue = optionalString(options, 'sdkName', kDefaultSdkName);
  const sdkVersionValue = optionalString(
    options,
    'sdkVersion',
    require('../package.json').version,
  );

  const parsedFilter = parseFilter('options.filter', options.filter);
  const parsedExclude = parseFilter('options.exclude', options.exclude);
  const parsedResourceAttributes = validateResourceAttributes(
    options.resourceAttributes,
  );

  endpoint = endpointValue;
  filter = parsedFilter;
  exclude = parsedExclude;
  active = true;
  collectorHost = parsed.host;
  exportUrl = parsed;
  serviceName = serviceNameValue;
  sdkName = sdkNameValue;
  sdkVersion = sdkVersionValue;
  exportHeaders = parsedHeaders;
  resourceAttributes = parsedResourceAttributes;
  instanceId = randomUUID();
  configureSampler(options.sampleRatio ?? 1);

  const { enableInstrumentations } = require('./instrumentations');
  enableInstrumentations();

  const { startFlusher } = require('./flush');
  startFlusher(options);
}

module.exports = {
  start,
  isActive: () => active,
  getEndpoint: () => endpoint,
  getSpanStorage,
  isModuleEnabled,
  getCollectorHost: () => collectorHost,
  getExportUrl: () => exportUrl,
  getServiceName: () => serviceName,
  getSdkName: () => sdkName,
  getSdkVersion: () => sdkVersion,
  getExportHeaders: () => exportHeaders,
  getResourceAttributes: () => resourceAttributes,
  getInstanceId: () => instanceId,
};
