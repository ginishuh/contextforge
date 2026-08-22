import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

const execFileAsync = promisify(execFile);
const lintScript = path.resolve('scripts/lint-source.js');

async function makeWorkspace(budgets) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'contextforge-lint-ratchet-'));
  await fs.mkdir(path.join(directory, 'src'), { recursive: true });
  await fs.writeFile(
    path.join(directory, 'budgets.json'),
    `${JSON.stringify({ note: 'test fixture', budgets }, null, 2)}\n`,
  );
  return directory;
}

async function writeSource(directory, relativePath, lineCount) {
  const body = Array.from({ length: lineCount }, (_, index) => `const line${index} = ${index};`);
  await fs.writeFile(path.join(directory, relativePath), `${body.join('\n')}\n`);
}

async function runLint(directory, extraArguments = []) {
  try {
    const result = await execFileAsync(
      'node',
      [lintScript, '--root', 'src', '--budgets', 'budgets.json', ...extraArguments],
      { cwd: directory },
    );
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return { code: error.code, stdout: error.stdout, stderr: error.stderr };
  }
}

test('a file over its budget fails the lint', async () => {
  const directory = await makeWorkspace({ 'src/big.js': 200 });
  try {
    await writeSource(directory, 'src/big.js', 260);
    const result = await runLint(directory);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /src\/big\.js: 260 lines exceeds the architecture budget 200/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('a file well under its budget fails until the budget is tightened', async () => {
  const directory = await makeWorkspace({ 'src/big.js': 200 });
  try {
    await writeSource(directory, 'src/big.js', 120);
    const failing = await runLint(directory);
    assert.equal(failing.code, 1);
    assert.match(failing.stderr, /src\/big\.js: 120 lines is 80 under the budget 200/);
    assert.match(failing.stderr, /tighten the budget to 120/);

    // Small slack stays quiet so ordinary edits do not churn the budget file.
    await writeSource(directory, 'src/big.js', 180);
    const tolerated = await runLint(directory);
    assert.equal(tolerated.code, 0);

    // The tightening escape hatch rewrites the budget file to the real counts.
    await writeSource(directory, 'src/big.js', 120);
    const updated = await runLint(directory, ['--update-budgets']);
    assert.equal(updated.code, 0);
    const written = JSON.parse(await fs.readFile(path.join(directory, 'budgets.json'), 'utf8'));
    assert.equal(written.budgets['src/big.js'], 120);
    const afterUpdate = await runLint(directory);
    assert.equal(afterUpdate.code, 0);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('a large unbudgeted file must be registered', async () => {
  const directory = await makeWorkspace({});
  try {
    await writeSource(directory, 'src/small.js', 1400);
    const passing = await runLint(directory);
    assert.equal(passing.code, 0);

    await writeSource(directory, 'src/huge.js', 1600);
    const failing = await runLint(directory);
    assert.equal(failing.code, 1);
    assert.match(failing.stderr, /src\/huge\.js: 1600 lines is unbudgeted/);
    assert.match(failing.stderr, /"src\/huge\.js": 1600/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
