#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// The line budgets are a ratchet, not a ceiling. A file may never grow past its
// budget, and once decomposition buys real slack the budget must be tightened so
// the reclaimed lines cannot be silently spent again.
//
// RATCHET_SLACK_LINES is the slack we tolerate before demanding a tightening.
// It is deliberately larger than routine edits (a few lines of churn in either
// direction is normal and should not fail lint) but far smaller than a real
// decomposition step, so any extraction that actually moves code out is caught.
const RATCHET_SLACK_LINES = 50;

// A file this large is an architecture decision, so it has to be registered in
// the budget file. This stops a new giant module from appearing unbudgeted.
const UNREGISTERED_FILE_LIMIT = 1500;

const defaultRoots = ['src', 'scripts', 'test'];
const defaultBudgetFile = 'scripts/line-budgets.json';

// Budget keys are POSIX-separated so the same budget file works on every OS.
// Windows readdir walks produce backslashes, which would miss every lookup.
function toPosix(filePath) {
  return filePath.split(path.sep).join('/');
}

function parseArguments(argv) {
  const roots = [];
  let budgetFile = defaultBudgetFile;
  let updateBudgets = false;
  let baseCheck = true;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--update-budgets') {
      updateBudgets = true;
    } else if (argument === '--no-base-check') {
      baseCheck = false;
    } else if (argument === '--root') {
      index += 1;
      if (!argv[index]) throw new Error('--root requires a directory');
      roots.push(argv[index]);
    } else if (argument === '--budgets') {
      index += 1;
      if (!argv[index]) throw new Error('--budgets requires a file path');
      budgetFile = argv[index];
    } else {
      throw new Error(`unknown argument ${argument}`);
    }
  }
  return { roots: roots.length ? roots : defaultRoots, budgetFile, updateBudgets, baseCheck };
}

// Budgets must be real integers. A budget written as a string still compares
// against a line count through JavaScript's implicit conversion, so the ordinary
// checks keep passing, but the base comparison below only trusts numbers and
// would skip the entry. Changing the JSON type would then raise a budget without
// tripping anything, so the type is rejected at load time instead.
function readBudgets(budgetFile) {
  if (!fs.existsSync(budgetFile)) return {};
  const parsed = JSON.parse(fs.readFileSync(budgetFile, 'utf8'));
  const budgets = parsed && typeof parsed === 'object' ? parsed.budgets : null;
  if (!budgets || typeof budgets !== 'object') {
    throw new Error(`${budgetFile}: expected an object with a "budgets" map`);
  }
  for (const [file, budget] of Object.entries(budgets)) {
    if (typeof budget !== 'number' || !Number.isInteger(budget) || budget < 0) {
      throw new Error(
        `${budgetFile}: budget for ${file} must be a non-negative integer, got ${JSON.stringify(budget)}`,
      );
    }
  }
  return budgets;
}

function writeBudgets(budgetFile, budgets, note) {
  const sorted = {};
  for (const key of Object.keys(budgets).sort()) sorted[key] = budgets[key];
  const payload = { note, budgets: sorted };
  fs.writeFileSync(budgetFile, `${JSON.stringify(payload, null, 2)}\n`);
}

function javascriptFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return javascriptFiles(file);
    return entry.isFile() && entry.name.endsWith('.js') ? [toPosix(file)] : [];
  });
}

// Count lines the way `wc -l` does so budgets match what a reader sees, and a
// single trailing newline never shifts the number by one.
function countLines(source) {
  if (source === '') return 0;
  const lines = source.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines.length;
}

function gitOutput(args) {
  const result = spawnSync('git', args, { encoding: 'utf8' });
  if (result.error || result.status !== 0) return null;
  return result.stdout;
}

// Prefer the merge base with the integration branch so a budget raised anywhere
// in the branch is caught, not just one raised in the working tree. CI checkouts
// name their base explicitly because the remote-tracking ref may not be fetched;
// a checkout without either can still compare against its own HEAD.
function baseBudgetRef() {
  const candidates = [process.env.CONTEXTFORGE_LINT_BASE_REF, 'origin/main'].filter(Boolean);
  for (const candidate of candidates) {
    if (gitOutput(['rev-parse', '--verify', '--quiet', candidate]) === null) continue;
    const mergeBase = gitOutput(['merge-base', candidate, 'HEAD']);
    if (mergeBase !== null && mergeBase.trim()) return mergeBase.trim();
  }
  return gitOutput(['rev-parse', '--verify', '--quiet', 'HEAD']) !== null ? 'HEAD' : null;
}

// Returns the committed budgets, or null when no baseline is obtainable. Every
// failure path here is a silent skip on purpose: the published npm package ships
// without a .git directory, and lint must still run there.
function readBaseBudgets(budgetFile) {
  if (gitOutput(['rev-parse', '--git-dir']) === null) return null;
  const ref = baseBudgetRef();
  if (ref === null) return null;
  const relative = toPosix(path.relative(process.cwd(), path.resolve(budgetFile)));
  // `<rev>:./<path>` resolves relative to the cwd; a path outside the repo
  // cannot be addressed that way, so there is nothing to compare.
  if (!relative || relative.startsWith('..')) return null;
  const shown = gitOutput(['show', `${ref}:./${relative}`]);
  if (shown === null) return null;
  try {
    const parsed = JSON.parse(shown);
    const budgets = parsed && typeof parsed === 'object' ? parsed.budgets : null;
    return budgets && typeof budgets === 'object' ? budgets : null;
  } catch {
    return null;
  }
}

const options = parseArguments(process.argv.slice(2));
const defaultNote = [
  'Ratchet budgets in lines. Budgets may only go down.',
  "Run 'node scripts/lint-source.js --update-budgets' after shrinking a file.",
].join(' ');
const existingNote = fs.existsSync(options.budgetFile)
  ? JSON.parse(fs.readFileSync(options.budgetFile, 'utf8')).note
  : null;
const budgets = readBudgets(options.budgetFile);
const files = options.roots.flatMap(javascriptFiles).sort();
// A narrower scan than the default cannot see every budgeted file, so entries
// outside it must be carried over rather than treated as deleted.
const fullScope = [...options.roots].sort().join(',') === [...defaultRoots].sort().join(',');

function underRoot(file, root) {
  const normalized = toPosix(root).replace(/\/+$/, '');
  return file === normalized || file.startsWith(`${normalized}/`);
}

// A budget entry can only be judged as an orphan when the scan could actually
// have seen it. Two cases make it unseeable, and both preserve the entry rather
// than deleting it:
//   - its root directory is absent entirely (the published npm package ships no
//     test/ directory, so every test budget would look orphaned);
//   - a narrowed --root put it outside the scanned scope.
// The test is deliberately the root directory, not the file: a file missing from
// a root that *is* present is a genuine orphan and must keep failing.
function budgetUnreachable(file) {
  const owningRoot = options.roots.find((root) => underRoot(file, root));
  if (owningRoot === undefined) return !fullScope;
  return !fs.existsSync(owningRoot);
}

const measured = new Map();
// Syntax and formatting problems are the file's own fault and must block even
// `--update-budgets`. Budget problems are exactly what an update is meant to
// resolve, so they are collected separately.
const sourceErrors = [];
const budgetErrors = [];

for (const file of files) {
  const source = fs.readFileSync(file, 'utf8');
  const lines = source.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    if (/\s+$/.test(lines[index])) sourceErrors.push(`${file}:${index + 1}: trailing whitespace`);
    if (lines[index].includes('\t')) sourceErrors.push(`${file}:${index + 1}: tab character`);
  }
  const syntax = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (syntax.status !== 0) sourceErrors.push(`${file}: syntax check failed\n${syntax.stderr.trim()}`);

  const actual = countLines(source);
  measured.set(file, actual);
  const budget = budgets[file];
  if (budget === undefined) {
    if (actual > UNREGISTERED_FILE_LIMIT) {
      budgetErrors.push(
        `${file}: ${actual} lines is unbudgeted; add "${file}": ${actual} to ${options.budgetFile}`,
      );
    }
    continue;
  }
  if (actual > budget) {
    budgetErrors.push(`${file}: ${actual} lines exceeds the architecture budget ${budget}`);
  } else if (budget - actual >= RATCHET_SLACK_LINES) {
    budgetErrors.push(
      `${file}: ${actual} lines is ${budget - actual} under the budget ${budget};`
        + ` tighten the budget to ${actual} in ${options.budgetFile}`,
    );
  }
}

for (const file of Object.keys(budgets)) {
  if (!measured.has(file) && !budgetUnreachable(file)) {
    budgetErrors.push(
      `${options.budgetFile}: ${file} is budgeted but was not found; remove the entry`,
    );
  }
}

if (options.updateBudgets) {
  if (sourceErrors.length) {
    console.error(sourceErrors.join('\n'));
    console.error('Refusing to update budgets while the source lint fails.');
    process.exit(1);
  }
  const next = {};
  const updateErrors = [];
  for (const [file, budget] of Object.entries(budgets)) {
    if (!measured.has(file)) {
      if (budgetUnreachable(file)) next[file] = budget;
      continue;
    }
    const actual = measured.get(file);
    if (actual > budget) {
      updateErrors.push(
        `${file}: ${actual} lines exceeds the recorded budget ${budget};`
          + ' --update-budgets only tightens budgets, it can never raise one',
      );
      continue;
    }
    next[file] = actual;
  }
  for (const [file, actual] of measured) {
    const isNewEntry = budgets[file] === undefined;
    if (isNewEntry && actual > UNREGISTERED_FILE_LIMIT) next[file] = actual;
  }
  if (updateErrors.length) {
    console.error(updateErrors.join('\n'));
    process.exit(1);
  }
  writeBudgets(options.budgetFile, next, existingNote || defaultNote);
  console.log(`Updated ${options.budgetFile} for ${Object.keys(next).length} files.`);
  process.exit(0);
}

if (options.baseCheck) {
  const baseBudgets = readBaseBudgets(options.budgetFile);
  if (baseBudgets) {
    for (const [file, rawBaseBudget] of Object.entries(baseBudgets)) {
      const current = budgets[file];
      // The base manifest is already committed and cannot be corrected from
      // here, so a loosely typed historical value is coerced rather than
      // rejected. The current manifest is validated strictly at load time.
      const baseBudget = Number(rawBaseBudget);
      if (typeof current === 'number' && Number.isFinite(baseBudget) && current > baseBudget) {
        budgetErrors.push(
          `${options.budgetFile}: budget for ${file} was raised from ${baseBudget} to ${current};`
            + ' budgets may only go down',
        );
      }
    }
  }
}

const errors = [...sourceErrors, ...budgetErrors];
if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}
console.log(`Source lint passed for ${files.length} JavaScript files.`);
