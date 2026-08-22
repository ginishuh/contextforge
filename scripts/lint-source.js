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

function parseArguments(argv) {
  const roots = [];
  let budgetFile = defaultBudgetFile;
  let updateBudgets = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--update-budgets') {
      updateBudgets = true;
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
  return { roots: roots.length ? roots : defaultRoots, budgetFile, updateBudgets };
}

function readBudgets(budgetFile) {
  if (!fs.existsSync(budgetFile)) return {};
  const parsed = JSON.parse(fs.readFileSync(budgetFile, 'utf8'));
  const budgets = parsed && typeof parsed === 'object' ? parsed.budgets : null;
  if (!budgets || typeof budgets !== 'object') {
    throw new Error(`${budgetFile}: expected an object with a "budgets" map`);
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
    return entry.isFile() && entry.name.endsWith('.js') ? [file] : [];
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
const measured = new Map();
const errors = [];

for (const file of files) {
  const source = fs.readFileSync(file, 'utf8');
  const lines = source.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    if (/\s+$/.test(lines[index])) errors.push(`${file}:${index + 1}: trailing whitespace`);
    if (lines[index].includes('\t')) errors.push(`${file}:${index + 1}: tab character`);
  }
  const syntax = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (syntax.status !== 0) errors.push(`${file}: syntax check failed\n${syntax.stderr.trim()}`);

  const actual = countLines(source);
  measured.set(file, actual);
  const budget = budgets[file];
  if (budget === undefined) {
    if (actual > UNREGISTERED_FILE_LIMIT) {
      errors.push(
        `${file}: ${actual} lines is unbudgeted; add "${file}": ${actual} to ${options.budgetFile}`,
      );
    }
    continue;
  }
  if (actual > budget) {
    errors.push(`${file}: ${actual} lines exceeds the architecture budget ${budget}`);
  } else if (budget - actual >= RATCHET_SLACK_LINES) {
    errors.push(
      `${file}: ${actual} lines is ${budget - actual} under the budget ${budget};`
        + ` tighten the budget to ${actual} in ${options.budgetFile}`,
    );
  }
}

for (const file of Object.keys(budgets)) {
  if (!measured.has(file)) {
    errors.push(`${options.budgetFile}: ${file} is budgeted but was not found; remove the entry`);
  }
}

if (options.updateBudgets) {
  const next = {};
  for (const file of Object.keys(budgets)) {
    if (measured.has(file)) next[file] = measured.get(file);
  }
  for (const [file, actual] of measured) {
    if (next[file] === undefined && actual > UNREGISTERED_FILE_LIMIT) next[file] = actual;
  }
  writeBudgets(options.budgetFile, next, existingNote || defaultNote);
  console.log(`Updated ${options.budgetFile} for ${Object.keys(next).length} files.`);
  process.exit(0);
}

if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}
console.log(`Source lint passed for ${files.length} JavaScript files.`);
