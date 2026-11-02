'use strict';

// Runs `npm run bench` in two checkouts and prints a markdown table
// comparing them:
//
//   node scripts/compare-benchmarks.js <base-dir> <head-dir>
//
// Benchmark names are escaped so that characters such as `|` and `<`
// can't break the table or be dropped as HTML.

const { spawnSync } = require('node:child_process');
const {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');

// Fewer rounds make a significant change happen by chance more often:
// about 1% of benchmarks with 5 rounds, 10% with 3.
const kRounds = 5;

// Results drift over time, so each side runs several times and the order
// flips every round. Each side then runs early and late equally often.
function runRounds(trees) {
  const out = mkdtempSync(path.join(tmpdir(), 'microtel-bench-'));
  for (const side of Object.keys(trees)) mkdirSync(path.join(out, side));
  for (let round = 1; round <= kRounds; round++) {
    const order = round % 2 ? ['base', 'head'] : ['head', 'base'];
    for (const side of order) {
      const destination = path.join(out, side, `${round}.ndjson`);
      // The runner ignores options after the file pattern, so they can't
      // be passed as npm run arguments. NODE_OPTIONS also needs
      // --experimental-bench to accept the reporter options.
      const { status } = spawnSync('npm', ['run', 'bench'], {
        cwd: trees[side],
        // Progress goes to stderr, so stdout carries only the table.
        stdio: ['ignore', 2, 2],
        env: {
          ...process.env,
          NODE_OPTIONS: `--experimental-bench --bench-reporter=json --bench-reporter-destination=${destination}`,
        },
      });
      if (status !== 0) {
        throw new Error(`npm run bench failed in ${trees[side]}`);
      }
    }
  }
  return out;
}

// Each run's mean rate is one sample. Results shift more between runs
// than within one, so the spread is taken across runs.
const summarize = (means) => ({
  mean: means.reduce((sum, value) => sum + value, 0) / means.length,
  min: Math.min(...means),
  max: Math.max(...means),
});

function readResults(dir) {
  const means = new Map();
  for (const file of readdirSync(dir)) {
    const text = readFileSync(path.join(dir, file), 'utf8');
    for (const line of text.split('\n')) {
      if (!line) continue;
      const { type, data } = JSON.parse(line);
      if (type !== 'bench:complete') continue;
      let key = data.namePath.join(' > ');
      if (Object.keys(data.params).length > 0) {
        key += ` ${JSON.stringify(data.params)}`;
      }
      if (!means.has(key)) means.set(key, []);
      means.get(key).push(data.summary.mean);
    }
  }
  const results = new Map();
  for (const [key, values] of means) results.set(key, summarize(values));
  return results;
}

const escape = (text) =>
  text
    .replace(/[\r\n]+/g, ' ')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\|/g, '\\|');

const formatRate = (rate) =>
  rate.toLocaleString('en-US', { maximumSignificantDigits: 4 });

// The mean rate with half the range between the slowest and fastest run.
function formatSummary(summary) {
  if (!summary) return '-';
  const { mean, min, max } = summary;
  const margin = ((max - min) / 2 / mean) * 100;
  return `${formatRate(mean)} ±${margin.toFixed(1)}%`;
}

// A change counts as significant when every run of one side is faster
// than every run of the other.
function compare(name, base, head) {
  if (!base || !head) return { name, base, head, change: null };
  return {
    name,
    base,
    head,
    change: ((head.mean - base.mean) / base.mean) * 100,
    significant: head.min > base.max || head.max < base.min,
  };
}

function formatChange({ change, significant }) {
  if (change === null) return '-';
  const text = `${change >= 0 ? '+' : ''}${change.toFixed(1)}%`;
  if (!significant) return text;
  return `**${text}** ${change > 0 ? ':green_circle:' : ':red_circle:'}`;
}

function formatTable(rows) {
  const lines = [
    '| Benchmark | base (ops/s) | PR (ops/s) | Change |',
    '| --- | ---: | ---: | ---: |',
  ];
  for (const row of rows) {
    const cells = [
      escape(row.name),
      formatSummary(row.base),
      formatSummary(row.head),
      formatChange(row),
    ];
    lines.push(`| ${cells.join(' | ')} |`);
  }
  return lines.join('\n');
}

const [baseDir, headDir] = process.argv.slice(2);
const runs = runRounds({ base: baseDir, head: headDir });
const base = readResults(path.join(runs, 'base'));
const head = readResults(path.join(runs, 'head'));
const names = [...new Set([...base.keys(), ...head.keys()])];
const rows = names.map((name) => compare(name, base.get(name), head.get(name)));
const significant = rows
  .filter((row) => row.significant)
  .sort((a, b) => Math.abs(b.change) - Math.abs(a.change));

// The full table is collapsed so that significant changes stay visible
// however many benchmarks there are.
console.log(
  [
    significant.length > 0
      ? formatTable(significant)
      : 'No significant changes.',
    '',
    '<details>',
    `<summary>All ${rows.length} benchmarks</summary>`,
    '',
    formatTable(rows),
    '',
    '</details>',
    '',
    'Each side ran several times, taking turns. The ± shows how far its runs',
    'spread. A change is bold when every PR run was faster than every base',
    'run, or every one was slower.',
    '',
    'Each side runs its own benchmark files. If this PR changes a benchmark,',
    'its row compares the old and new versions of that benchmark too.',
  ].join('\n'),
);
