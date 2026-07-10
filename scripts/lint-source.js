#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const roots = ['src', 'scripts', 'test'];
const lineBudgets = Object.freeze({
  'src/core.js': 8750,
  'src/storage/sqlite.js': 5300,
  'src/mcp.js': 1900,
  'test/core.test.js': 17100,
});

function javascriptFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return javascriptFiles(file);
    return entry.isFile() && entry.name.endsWith('.js') ? [file] : [];
  });
}

const files = roots.flatMap(javascriptFiles).sort();
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
  const budget = lineBudgets[file];
  if (budget && lines.length > budget) {
    errors.push(`${file}: ${lines.length} lines exceeds the architecture budget ${budget}`);
  }
}

if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}
console.log(`Source lint passed for ${files.length} JavaScript files.`);
