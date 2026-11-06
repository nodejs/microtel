# AGENTS.md

Guidance for coding agents working in this repository. Read README.md and
CONTRIBUTING.md as well: README.md documents the public API and its behavior,
and CONTRIBUTING.md has the rules for contributing.

## What this is

microtel is a small implementation of parts of OpenTelemetry for Node.js. It
traces `http` and `https` clients and servers, HTTP/2 servers, and undici and
`fetch()` through `diagnostics_channel`, propagates W3C trace context and
baggage, and exports spans as OTLP/HTTP JSON. It's meant to be included in
Node.js core as a dependency, so it's written the way Node.js core code is.

- It's CommonJS, with `'use strict'`, for Node.js 26.9 or newer (the `engines`
  field in package.json).
- It has no runtime dependencies. The dev dependencies only build, test, and
  format it.
- All configuration goes through `init(options)`. There is no configuration
  through environment variables.
- The public API is `init()`, `isActive()`, and `flush()`, from index.js.

## Layout

| Path | What it holds |
|---|---|
| `index.js` | The public API. |
| `lib/core.js` | `init()` option validation and the state it sets. |
| `lib/instrumentations.js` | The `diagnostics_channel` subscribers that create spans and propagate context. |
| `lib/span.js` | The `Span` class, trace flags, and `traceparent` parsing and formatting. |
| `lib/sampler.js` | The root sampling decision for `sampleRatio`. |
| `lib/id.js` | Trace and span ID generation. |
| `lib/flush.js` | The span buffer, OTLP JSON serialization, the export, and `flush()`. |
| `lib/guard.js` | `guard()`, which keeps a bug in microtel from breaking the app it traces. |
| `lib/validate.js` | Ports of Node.js core's argument validators and error helpers. |
| `scripts/` | The bundle build and the benchmark comparison that CI runs. |
| `test/` | The tests (`test-*.js`), shared helpers in `test/common/`, and child process fixtures in `test/fixtures/`. |
| `test/collector/` | A smoke test against a real OpenTelemetry Collector, which runs in its own CI job. |
| `benchmark/` | The `node:bench` benchmarks. |
| `dist/microtel.js` | The generated CommonJS bundle from `npm run build`. It's ignored, and `test/test-bundle.js` loads and tests it. |

## Commands

```sh
npm ci
npm run build         # writes dist/microtel.js
npm test              # builds the bundle, then runs node --test 'test/test-*.js'
npm run format:check  # prettier --check .
npx prettier --write <files>
npm run bench         # node --experimental-bench --bench 'benchmark/*.bench.js'
```

The collector smoke test needs Docker. The header of
`test/collector/test-collector.js` says how to run it locally.

CI runs separate `build`, `test`, `prettier`, and `collector` jobs, and the
benchmark workflow runs the benchmarks on every push and compares them against
the base branch on pull requests.

## Code conventions

- Write it the way Node.js core would. An error for a bad argument uses core's
  error code and message, through the helpers in `lib/validate.js`.
- A validator ported from core goes into `lib/validate.js` and into the parity
  battery in `test/common/validate-battery.js`, which
  `test/test-validate-parity.js` runs against core's own validators under
  `--expose-internals`.
- `init()` validates every option before it changes any state, and it copies
  any object it keeps, so a caller changing that object later has no effect.
- Nothing microtel hands to Node.js may throw into the app. That covers
  `diagnostics_channel` subscribers, event listeners, and timers. Wrap each one
  with `guard()` from `lib/guard.js`, once rather than on every call.
- Every export settles, on every path, by its `exportTimeout` deadline at the
  latest. `flush()` never rejects for a failed export. Failures are reported as
  throttled `OTelExportWarning` process warnings instead.
- The traced request path is hot. Avoid allocations and closures there, and
  measure any change to it (see Performance below).
- Prettier formats everything except Markdown and the built bundle, with
  single quotes. Match the style of the code around a change.
- Use comments for non-obvious decisions and constraints. A TODO names its
  author, as `TODO(handle):`, and says everything needed to act on it, with no
  links to pull requests.
- Don't name specific observability vendors in code, docs, commit messages, or
  pull request descriptions. Say "an OTLP backend", and use example.com in
  examples.

## OpenTelemetry behavior

Follow the OpenTelemetry specification and semantic conventions, and match what
the official SDKs and instrumentations do. Where microtel differs on purpose,
say so in the pull request, and in README.md if users can see it.

## Tests

- Tracing activates once per process. Tests that activate tracing in-process
  normally call `startTracing()` once in `before()` and share its collector.
  Use `spawnMicrotel()` for another activation in the same test file. Tracing
  fixtures usually receive JSON init options in `process.argv[2]`.
- `spawnMicrotel()` accepts a `timeout` option and returns `code: null` when
  that timeout kills the child. Use it for a child that could block, and close
  servers and collectors a test creates.
- A test must not depend on timing or randomness. Wait on events rather than
  sleeping.
- Add tests for the change itself, and check that each new test fails when the
  behavior it covers is broken.
- Keep tests DRY, with table-driven cases and `assert.partialDeepStrictEqual`
  where they fit.

## Performance

For pull requests, CI compares the benchmarks of the change and its base over
five interleaved rounds. It reports the mean of each run's mean rate and the
spread, and highlights a change only when every run on one side is faster or
slower than every run on the other.

When measuring by hand, interleave runs of main and the change on the same
machine, report several runs rather than one, and use the untraced benchmarks
as a control for noise. For small changes, CPU profiles of microtel's own time
are steadier than throughput.

## Pull requests and commits

- Commit subjects use conventional commits, with lowercase text after the
  type. Examples in the history include `feat:`, `fix:`, `perf:`, `test:`,
  `ci:`, `chore:`, and `docs:`.
- Contributions are made under the Developer's Certificate of Origin in
  CONTRIBUTING.md.
- A pull request stays open for at least 24 hours before it merges, unless the
  maintainers judge it trivial.
- Update README.md for any change users can see.
