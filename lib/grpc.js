'use strict';

const { Buffer } = require('node:buffer');
const http2 = require('node:http2');
const { decodeResponse } = require('./otlp');
const { kMaxMessageSize } = require('./protobuf');

const kTraceExportPath =
  '/opentelemetry.proto.collector.trace.v1.TraceService/Export';
const kMaxResponseSize = 64 * 1024;
const kInitialBackoffMs = 1000;
const kMaxBackoffMs = 30000;

// A single active unary RPC; queued and active payloads share a byte budget.
// Failures are reported to the flusher, which owns warning/drop policy.
class GrpcExporter {
  session = null;
  sessions = new Set();
  queue = [];
  active = null;
  queuedBytes = 0;
  closed = false;
  backoffMs = kInitialBackoffMs;
  nextExportAt = 0;
  resumeTimer = null;

  constructor(url, timeout) {
    this.url = url;
    this.timeout = timeout;
  }

  send(body) {
    if (this.closed)
      return Promise.reject(new Error('OTLP gRPC exporter closed'));
    if (
      this.queue.length + (this.active ? 1 : 0) >= 100 ||
      this.queuedBytes + body.length > kMaxMessageSize + 5
    ) {
      return Promise.reject(
        new Error('OTLP gRPC export queue exceeds size limit'),
      );
    }
    return new Promise((resolve, reject) => {
      const item = {
        body,
        resolve,
        reject,
        expires: Date.now() + this.timeout,
      };
      item.timer = setTimeout(() => {
        this.finish(
          item,
          new Error(
            `OTLP gRPC export exceeded the ${this.timeout}ms export timeout`,
          ),
        );
      }, this.timeout);
      this.queuedBytes += body.length;
      this.queue.push(item);
      this.pump();
    });
  }

  getSession() {
    if (this.session && !this.session.closed && !this.session.destroyed)
      return this.session;
    const session = http2.connect(this.url.origin, {
      settings: { maxHeaderListSize: 8192 },
      maxHeaderListPairs: 128,
    });
    this.session = session;
    this.sessions.add(session);
    session.on('error', (err) => {
      if (this.session === session) this.session = null;
      if (this.active?.session === session) this.finish(this.active, err);
      session.destroy();
    });
    session.on('goaway', () => {
      if (this.session === session) this.session = null;
      session.close();
    });
    session.on('close', () => {
      this.sessions.delete(session);
      if (this.session === session) this.session = null;
      if (this.active?.session === session)
        this.finish(this.active, new Error('OTLP gRPC session closed'));
    });
    return session;
  }

  pump() {
    if (this.active || this.closed) return;
    if (this.queue.length === 0) {
      clearTimeout(this.resumeTimer);
      this.resumeTimer = null;
      return;
    }
    const delay = this.nextExportAt - Date.now();
    if (delay > 0) {
      this.resumeTimer ??= setTimeout(() => {
        this.resumeTimer = null;
        this.pump();
      }, delay);
      this.resumeTimer.unref();
      return;
    }
    const item = this.queue.shift();
    if (!item) return;
    this.active = item;
    try {
      // A previous RPC can finish before delayed timeout callbacks run.
      // Do not start a stream for a batch whose deadline has already passed.
      if (item.expires <= Date.now()) {
        throw new Error(
          `OTLP gRPC export exceeded the ${this.timeout}ms export timeout`,
        );
      }
      const session = this.getSession();
      item.session = session;
      session.ref();
      const stream = session.request({
        ':method': 'POST',
        ':path':
          this.url.pathname === '/' ? kTraceExportPath : this.url.pathname,
        'content-type': 'application/grpc+proto',
        te: 'trailers',
        'grpc-timeout': `${Math.min(99999999, Math.max(1, item.expires - Date.now()))}m`,
      });
      item.stream = stream;
      let headers;
      let status;
      let message;
      let length = 0;
      const chunks = [];
      stream.on('response', (value) => {
        headers = value;
        status = value['grpc-status'];
        message = value['grpc-message'];
      });
      stream.on('trailers', (value) => {
        status = value['grpc-status'];
        message = value['grpc-message'];
      });
      stream.on('data', (chunk) => {
        length += chunk.length;
        if (length > kMaxResponseSize + 5) {
          this.finish(item, new Error('OTLP gRPC response exceeds size limit'));
        } else chunks.push(chunk);
      });
      stream.on('error', (err) => this.finish(item, err));
      stream.on('close', () => {
        if (!item.done)
          this.finish(
            item,
            new Error('OTLP gRPC stream closed before response completed'),
          );
      });
      stream.on('end', () => {
        if (item.done) return;
        try {
          if (headers?.[':status'] !== 200)
            throw new Error(
              `OTLP gRPC collector responded with HTTP ${headers?.[':status']}`,
            );
          if (
            !/^application\/grpc(?:\+proto)?(?:;|$)/i.test(
              headers['content-type'] || '',
            )
          ) {
            throw new Error('Invalid OTLP gRPC response content-type');
          }
          if (!/^(?:[0-9]|1[0-6])$/.test(status ?? ''))
            throw new Error('Missing or invalid OTLP grpc-status');
          if (status !== '0') {
            if (status === '14') {
              // UNAVAILABLE is the OTLP overload signal. Drop this batch,
              // but throttle new work as well as work already queued.
              this.nextExportAt = Date.now() + this.backoffMs;
              this.backoffMs = Math.min(this.backoffMs * 2, kMaxBackoffMs);
            }
            let decoded = message || '';
            try {
              decoded = decodeURIComponent(decoded);
            } catch {
              /* Preserve invalid escaped diagnostics. */
            }
            throw new Error(`OTLP gRPC status ${status}: ${decoded}`);
          }
          const frame = Buffer.concat(chunks, length);
          if (length < 5 || frame.readUInt32BE(1) !== length - 5)
            throw new Error('Invalid OTLP gRPC response framing');
          if (frame[0] !== 0)
            throw new Error('Unsupported OTLP gRPC response compression');
          this.finish(item, null, decodeResponse(frame.subarray(5)));
        } catch (err) {
          this.finish(item, err);
        }
      });
      stream.end(item.body);
    } catch (err) {
      this.finish(item, err);
    }
  }

  finish(item, error, result) {
    if (item.done) return;
    item.done = true;
    clearTimeout(item.timer);
    this.queuedBytes -= item.body.length;
    if (this.active === item) {
      this.active = null;
      if (error) {
        item.stream?.close(http2.constants.NGHTTP2_CANCEL);
        if (item.session?.connecting) item.session.destroy();
      }
      item.session?.unref();
    } else {
      const index = this.queue.indexOf(item);
      if (index !== -1) this.queue.splice(index, 1);
    }
    if (error) item.reject(error);
    else {
      this.backoffMs = kInitialBackoffMs;
      this.nextExportAt = 0;
      item.resolve(result);
    }
    this.pump();
  }

  close() {
    this.closed = true;
    clearTimeout(this.resumeTimer);
    this.resumeTimer = null;
    const error = new Error('OTLP gRPC exporter closed');
    if (this.active) this.finish(this.active, error);
    for (const item of [...this.queue]) this.finish(item, error);
    for (const session of this.sessions) session.destroy();
  }
}

module.exports = { GrpcExporter, kTraceExportPath };
