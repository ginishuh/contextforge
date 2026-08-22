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

async function readBudgets(directory) {
  return JSON.parse(await fs.readFile(path.join(directory, 'budgets.json'), 'utf8')).budgets;
}

async function writeBudgets(directory, budgets) {
  await fs.writeFile(
    path.join(directory, 'budgets.json'),
    `${JSON.stringify({ note: 'test fixture', budgets }, null, 2)}\n`,
  );
}

async function git(directory, ...args) {
  await execFileAsync(
    'git',
    ['-c', 'user.email=lint@test', '-c', 'user.name=Lint Test', ...args],
    { cwd: directory },
  );
}

// The base comparison only works against a real repository, so the fixture
// commits the budget file instead of stubbing git out.
async function makeGitWorkspace(budgets) {
  const directory = await makeWorkspace(budgets);
  await git(directory, 'init', '--quiet', '--initial-branch', 'main');
  return directory;
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

test('--update-budgets refuses to raise an existing budget', async () => {
  const directory = await makeWorkspace({ 'src/big.js': 200 });
  try {
    await writeSource(directory, 'src/big.js', 240);
    const result = await runLint(directory, ['--update-budgets']);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /src\/big\.js: 240 lines exceeds the recorded budget 200/);
    assert.match(result.stderr, /only tightens budgets/);

    // The budget file must be left untouched by the rejected update.
    assert.deepEqual(await readBudgets(directory), { 'src/big.js': 200 });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('--update-budgets still adds a new oversized file', async () => {
  const directory = await makeWorkspace({});
  try {
    await writeSource(directory, 'src/huge.js', 1600);
    const result = await runLint(directory, ['--update-budgets']);
    assert.equal(result.code, 0);
    assert.deepEqual(await readBudgets(directory), { 'src/huge.js': 1600 });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('--update-budgets refuses to run while the source lint fails', async () => {
  const directory = await makeWorkspace({ 'src/big.js': 200 });
  try {
    await writeSource(directory, 'src/big.js', 120);
    await fs.appendFile(path.join(directory, 'src/big.js'), 'const trailing = 1;   \n');
    const formatting = await runLint(directory, ['--update-budgets']);
    assert.equal(formatting.code, 1);
    assert.match(formatting.stderr, /trailing whitespace/);
    assert.match(formatting.stderr, /Refusing to update budgets/);
    assert.deepEqual(await readBudgets(directory), { 'src/big.js': 200 });

    await writeSource(directory, 'src/broken.js', 3);
    await fs.appendFile(path.join(directory, 'src/broken.js'), 'const = ;\n');
    await writeSource(directory, 'src/big.js', 120);
    const syntax = await runLint(directory, ['--update-budgets']);
    assert.equal(syntax.code, 1);
    assert.match(syntax.stderr, /src\/broken\.js: syntax check failed/);
    assert.deepEqual(await readBudgets(directory), { 'src/big.js': 200 });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('a narrowed --root preserves budget entries outside the scanned scope', async () => {
  const directory = await makeWorkspace({ 'src/big.js': 200, 'test/core.test.js': 300 });
  try {
    await fs.mkdir(path.join(directory, 'test'), { recursive: true });
    await writeSource(directory, 'test/core.test.js', 300);
    await writeSource(directory, 'src/big.js', 120);
    const result = await runLint(directory, ['--update-budgets']);
    assert.equal(result.code, 0);
    assert.deepEqual(await readBudgets(directory), {
      'src/big.js': 120,
      'test/core.test.js': 300,
    });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('budget entries under a missing root directory are not orphans', async () => {
  // Mirrors the published npm package, which ships src/ and scripts/ but no test/.
  const directory = await makeWorkspace({ 'src/big.js': 200, 'test/core.test.js': 300 });
  try {
    await writeSource(directory, 'src/big.js', 180);
    const result = await runLint(directory, ['--root', 'test']);
    assert.equal(result.code, 0, result.stderr);

    // An update from that same packed layout must not drop the entry either.
    const updated = await runLint(directory, ['--root', 'test', '--update-budgets']);
    assert.equal(updated.code, 0);
    assert.deepEqual(await readBudgets(directory), {
      'src/big.js': 180,
      'test/core.test.js': 300,
    });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('a budgeted file missing from an existing root is still an orphan', async () => {
  const directory = await makeWorkspace({ 'src/big.js': 200, 'src/gone.js': 300 });
  try {
    await writeSource(directory, 'src/big.js', 180);
    const result = await runLint(directory);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /src\/gone\.js is budgeted but was not found/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('budget keys stay POSIX-separated in nested directories', async () => {
  const directory = await makeWorkspace({});
  try {
    await fs.mkdir(path.join(directory, 'src', 'nested'), { recursive: true });
    await writeSource(directory, path.join('src', 'nested', 'deep.js'), 1600);
    const failing = await runLint(directory);
    assert.equal(failing.code, 1);
    assert.match(failing.stderr, /"src\/nested\/deep\.js": 1600/);
    assert.doesNotMatch(failing.stderr, /src\\nested/);

    const updated = await runLint(directory, ['--update-budgets']);
    assert.equal(updated.code, 0);
    assert.deepEqual(Object.keys(await readBudgets(directory)), ['src/nested/deep.js']);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('a budget raised since the committed baseline fails the lint', async () => {
  const directory = await makeGitWorkspace({ 'src/big.js': 200 });
  try {
    await writeSource(directory, 'src/big.js', 180);
    await git(directory, 'add', '-A');
    await git(directory, 'commit', '--quiet', '-m', 'baseline');
    const baseline = await runLint(directory);
    assert.equal(baseline.code, 0, baseline.stderr);

    // Raising the budget and spending the room is the exact bypass being closed.
    await writeBudgets(directory, { 'src/big.js': 300 });
    await writeSource(directory, 'src/big.js', 280);
    const raised = await runLint(directory);
    assert.equal(raised.code, 1);
    assert.match(raised.stderr, /budget for src\/big\.js was raised from 200 to 300/);

    // The opt-out exists for callers that cannot rely on git history.
    const skipped = await runLint(directory, ['--no-base-check']);
    assert.equal(skipped.code, 0, skipped.stderr);

    // Tightening in the same place is always allowed.
    await writeBudgets(directory, { 'src/big.js': 190 });
    await writeSource(directory, 'src/big.js', 180);
    const lowered = await runLint(directory);
    assert.equal(lowered.code, 0, lowered.stderr);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('the baseline is the merge base with origin/main, not HEAD', async () => {
  const directory = await makeGitWorkspace({ 'src/big.js': 200 });
  try {
    await writeSource(directory, 'src/big.js', 180);
    await git(directory, 'add', '-A');
    await git(directory, 'commit', '--quiet', '-m', 'baseline');
    const { stdout: baseSha } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
      cwd: directory,
    });
    await git(directory, 'update-ref', 'refs/remotes/origin/main', baseSha.trim());

    // Commit the raise, so a HEAD-only comparison would see nothing wrong.
    await writeBudgets(directory, { 'src/big.js': 300 });
    await writeSource(directory, 'src/big.js', 280);
    await git(directory, 'add', '-A');
    await git(directory, 'commit', '--quiet', '-m', 'raise the budget');

    const result = await runLint(directory);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /budget for src\/big\.js was raised from 200 to 300/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('the base comparison is skipped outside a git repository', async () => {
  const directory = await makeWorkspace({ 'src/big.js': 300 });
  try {
    await writeSource(directory, 'src/big.js', 280);
    const result = await runLint(directory);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Source lint passed/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('a budget that is not an integer fails the lint', async () => {
  const directory = await makeWorkspace({ 'src/big.js': '300' });
  try {
    await writeSource(directory, 'src/big.js', 280);
    const result = await runLint(directory);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /budget for src\/big\.js must be a non-negative integer, got "300"/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('retyping a budget as a string cannot raise it past the baseline', async () => {
  const directory = await makeGitWorkspace({ 'src/big.js': 200 });
  try {
    await writeSource(directory, 'src/big.js', 180);
    await git(directory, 'add', '-A');
    await git(directory, 'commit', '--quiet', '-m', 'baseline');

    // A string budget still compares against the line count by implicit
    // conversion, so without the type check the ordinary ratchet would pass
    // while the base comparison silently skipped the entry.
    await writeBudgets(directory, { 'src/big.js': '300' });
    await writeSource(directory, 'src/big.js', 280);
    const result = await runLint(directory);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /must be a non-negative integer/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
