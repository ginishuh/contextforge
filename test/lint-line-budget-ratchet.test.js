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

// runLint always passes `--root src`, which would mask how a differently
// spelled root behaves on its own.
async function runLintWithRoots(directory, roots, extraArguments = []) {
  const rootArguments = roots.flatMap((root) => ['--root', root]);
  try {
    const result = await execFileAsync(
      'node',
      [lintScript, ...rootArguments, '--budgets', 'budgets.json', ...extraArguments],
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

test('a narrowed --root cannot drop an out-of-scope entry the baseline still has', async () => {
  const directory = await makeGitWorkspace({ 'src/big.js': 200, 'test/core.test.js': 300 });
  try {
    await fs.mkdir(path.join(directory, 'test'), { recursive: true });
    await writeSource(directory, 'test/core.test.js', 300);
    await writeSource(directory, 'src/big.js', 180);
    await git(directory, 'add', '-A');
    await git(directory, 'commit', '--quiet', '-m', 'baseline');

    // The out-of-scope entry is deleted from the manifest, then a narrow update
    // is run. Nothing measures test/, so only the baseline can catch this.
    await writeBudgets(directory, { 'src/big.js': 200 });
    const result = await runLint(directory, ['--update-budgets']);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /budget for test\/core\.test\.js was removed while the file still exists/);
    assert.deepEqual(await readBudgets(directory), { 'src/big.js': 200 });

    // Deleting the file too is the legitimate case and must still pass.
    await fs.rm(path.join(directory, 'test/core.test.js'));
    const legitimate = await runLint(directory, ['--update-budgets']);
    assert.equal(legitimate.code, 0, legitimate.stderr);
    assert.deepEqual(await readBudgets(directory), { 'src/big.js': 180 });
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

test('an unreachable merge base fails instead of comparing HEAD to itself', async () => {
  const directory = await makeGitWorkspace({ 'src/big.js': 200 });
  try {
    await writeSource(directory, 'src/big.js', 180);
    await git(directory, 'add', '-A');
    await git(directory, 'commit', '--quiet', '-m', 'baseline');

    // A shallow clone has the base ref but no shared history with it. Building
    // the same condition here without touching the working tree.
    const { stdout: emptyTree } = await execFileAsync('git', ['hash-object', '-t', 'tree', '/dev/null'], {
      cwd: directory,
    });
    const { stdout: unrelated } = await execFileAsync(
      'git',
      ['-c', 'user.email=lint@test', '-c', 'user.name=Lint Test', 'commit-tree', emptyTree.trim(), '-m', 'unrelated'],
      { cwd: directory },
    );
    await git(directory, 'update-ref', 'refs/remotes/origin/main', unrelated.trim());

    // Commit the raise. A HEAD baseline would be the raised manifest itself,
    // so the ratchet would compare the branch against its own budget and pass.
    await writeBudgets(directory, { 'src/big.js': 300 });
    await writeSource(directory, 'src/big.js', 280);
    await git(directory, 'add', '-A');
    await git(directory, 'commit', '--quiet', '-m', 'raise the budget');

    const result = await runLint(directory);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /no merge base between origin\/main and HEAD/);

    // The update path must refuse for the same reason, not write 280.
    const updated = await runLint(directory, ['--update-budgets']);
    assert.equal(updated.code, 1);
    assert.match(updated.stderr, /no merge base between origin\/main and HEAD/);
    assert.deepEqual(await readBudgets(directory), { 'src/big.js': 300 });

    // The documented escape hatch still works for callers without history.
    const skipped = await runLint(directory, ['--no-base-check']);
    assert.equal(skipped.code, 0, skipped.stderr);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('orphan entries are caught however the root is spelled', async () => {
  const directory = await makeWorkspace({ 'src/gone.js': 300 });
  try {
    await writeSource(directory, 'src/keep.js', 10);
    // `./src` and `src/` must collapse to the same key the file walk produces,
    // or every budget entry looks out of scope and the orphan check passes.
    for (const root of ['src', './src', 'src/', path.join(directory, 'src')]) {
      // Bypasses runLint so the spelling under test is the only --root given.
      const result = await runLintWithRoots(directory, [root]);
      assert.equal(result.code, 1, `root ${root} should have failed`);
      assert.match(result.stderr, /src\/gone\.js is budgeted but was not found/);
    }
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

test('dropping a budget entry for a file that still exists fails the lint', async () => {
  const directory = await makeGitWorkspace({ 'src/big.js': 200 });
  try {
    await writeSource(directory, 'src/big.js', 180);
    await git(directory, 'add', '-A');
    await git(directory, 'commit', '--quiet', '-m', 'baseline');

    // Deleting the entry lifts the budget to infinity, and a file under the
    // unregistered limit would otherwise sail through unnoticed.
    await writeBudgets(directory, {});
    const result = await runLint(directory);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /budget for src\/big\.js was removed while the file still exists/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('--update-budgets cannot write a budget above the committed baseline', async () => {
  const directory = await makeGitWorkspace({ 'src/big.js': 200 });
  try {
    await writeSource(directory, 'src/big.js', 180);
    await git(directory, 'add', '-A');
    await git(directory, 'commit', '--quiet', '-m', 'baseline');

    // Hand-raising the budget and then updating would otherwise record the
    // grown line count and exit 0, even though the ordinary lint rejects it.
    await writeBudgets(directory, { 'src/big.js': 300 });
    await writeSource(directory, 'src/big.js', 280);
    const result = await runLint(directory, ['--update-budgets']);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /budget for src\/big\.js was raised from 200 to 280/);

    // The rejected update must leave the manifest exactly as it found it.
    assert.deepEqual(await readBudgets(directory), { 'src/big.js': 300 });

    // Callers that opted out of the base check keep the old behaviour.
    const skipped = await runLint(directory, ['--update-budgets', '--no-base-check']);
    assert.equal(skipped.code, 0, skipped.stderr);
    assert.deepEqual(await readBudgets(directory), { 'src/big.js': 280 });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('--update-budgets refuses to drop an orphan entry', async () => {
  const directory = await makeWorkspace({ 'src/big.js': 200, 'src/gone.js': 300 });
  try {
    await writeSource(directory, 'src/big.js', 120);
    const result = await runLint(directory, ['--update-budgets']);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /src\/gone\.js is budgeted but was not found/);
    assert.match(result.stderr, /will not drop it for you/);

    // Both entries survive: a typo must not be laundered into a deletion.
    assert.deepEqual(await readBudgets(directory), { 'src/big.js': 200, 'src/gone.js': 300 });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('dropping a budget entry for a deleted file is allowed', async () => {
  const directory = await makeGitWorkspace({ 'src/big.js': 200 });
  try {
    await writeSource(directory, 'src/big.js', 180);
    await git(directory, 'add', '-A');
    await git(directory, 'commit', '--quiet', '-m', 'baseline');

    await fs.rm(path.join(directory, 'src/big.js'));
    await writeBudgets(directory, {});
    const result = await runLint(directory);
    assert.equal(result.code, 0, result.stderr);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('an import nobody uses fails the lint', async () => {
  const directory = await makeWorkspace({});
  try {
    await fs.writeFile(
      path.join(directory, 'src/helpers.js'),
      'export const used = 1;\nexport const dead = 2;\n',
    );
    await fs.writeFile(
      path.join(directory, 'src/app.js'),
      "import { used, dead } from './helpers.js';\n\nconsole.log(used);\n",
    );
    const result = await runLint(directory);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /src\/app\.js:1: unused import dead/);
    assert.doesNotMatch(result.stderr, /unused import used/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('unused import detection covers every import form', async () => {
  const directory = await makeWorkspace({});
  try {
    await fs.writeFile(path.join(directory, 'src/dep.js'), 'export default 1;\nexport const named = 2;\n');
    // A renamed binding is dead under its local name, not its exported one; a
    // namespace and a default binding have to be seen too. The side-effect
    // import binds nothing and must never be reported.
    await fs.writeFile(
      path.join(directory, 'src/app.js'),
      [
        "import './dep.js';",
        "import fallback from './dep.js';",
        "import * as everything from './dep.js';",
        "import { named as renamed } from './dep.js';",
        '',
        'console.log(1);',
        '',
      ].join('\n'),
    );
    const result = await runLint(directory);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /src\/app\.js:2: unused import fallback/);
    assert.match(result.stderr, /src\/app\.js:3: unused import everything/);
    assert.match(result.stderr, /src\/app\.js:4: unused import renamed/);
    // The exported name is not the local binding, so it must not be reported.
    assert.doesNotMatch(result.stderr, /unused import named\b/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('a multi-line import list is read as one statement', async () => {
  const directory = await makeWorkspace({});
  try {
    await fs.writeFile(
      path.join(directory, 'src/dep.js'),
      'export const alpha = 1;\nexport const beta = 2;\n',
    );
    await fs.writeFile(
      path.join(directory, 'src/app.js'),
      ['import {', '  alpha,', '  beta,', "} from './dep.js';", '', 'console.log(alpha);', ''].join('\n'),
    );
    const result = await runLint(directory);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /src\/app\.js:1: unused import beta/);
    assert.doesNotMatch(result.stderr, /unused import alpha/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('a name used only in a comment counts as used', async () => {
  const directory = await makeWorkspace({});
  try {
    await fs.writeFile(path.join(directory, 'src/dep.js'), 'export const thing = 1;\n');
    await fs.writeFile(
      path.join(directory, 'src/app.js'),
      "import { thing } from './dep.js';\n\n// thing is documented here\nconsole.log(1);\n",
    );
    // Deliberately lenient: a false failure costs more than a missed dead import.
    const result = await runLint(directory);
    assert.equal(result.code, 0, result.stderr);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('a trailing comment does not hide the import from the check', async () => {
  const directory = await makeWorkspace({});
  try {
    await fs.writeFile(
      path.join(directory, 'src/dep.js'),
      'export const dead = 1;\nexport const alsoDead = 2;\n',
    );
    // Annotating a leftover is exactly what someone does while decomposing, so
    // the check has to survive it — including the statement that follows.
    await fs.writeFile(
      path.join(directory, 'src/app.js'),
      [
        "import { dead } from './dep.js'; // moved",
        "import { alsoDead } from './dep.js';",
        '',
        'console.log(1);',
        '',
      ].join('\n'),
    );
    const result = await runLint(directory);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /src\/app\.js:1: unused import dead/);
    assert.match(result.stderr, /src\/app\.js:2: unused import alsoDead/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('a comment inside the specifier list does not swallow the next name', async () => {
  const directory = await makeWorkspace({});
  try {
    await fs.writeFile(
      path.join(directory, 'src/dep.js'),
      'export const dead = 1;\nexport const alsoDead = 2;\n',
    );
    await fs.writeFile(
      path.join(directory, 'src/app.js'),
      ['import {', '  dead, // note', '  alsoDead,', "} from './dep.js';", '', 'console.log(1);', ''].join('\n'),
    );
    const result = await runLint(directory);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /unused import dead/);
    assert.match(result.stderr, /unused import alsoDead/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('a $ binding is checked like any other identifier', async () => {
  const directory = await makeWorkspace({});
  try {
    await fs.writeFile(path.join(directory, 'src/dep.js'), 'export default 1;\n');
    await fs.writeFile(
      path.join(directory, 'src/app.js'),
      "import $ from './dep.js';\n\nconsole.log(1);\n",
    );
    const unused = await runLint(directory);
    assert.equal(unused.code, 1);
    assert.match(unused.stderr, /src\/app\.js:1: unused import \$/);

    // And using it must clear the error — `\b` does not hold at a `$` edge.
    await fs.writeFile(
      path.join(directory, 'src/app.js'),
      "import $ from './dep.js';\n\nconsole.log($);\n",
    );
    const used = await runLint(directory);
    assert.equal(used.code, 0, used.stderr);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('an import line inside a template or block comment is not a statement', async () => {
  const directory = await makeWorkspace({});
  try {
    // A code-generating template is text. Reading it as an import would fail
    // the lint over a name that was never imported — the false positive this
    // check is meant to avoid.
    await fs.writeFile(
      path.join(directory, 'src/template.js'),
      ['const source = `', "import { parseThing } from './parser.js';", '`;', 'console.log(source);', ''].join('\n'),
    );
    await fs.writeFile(
      path.join(directory, 'src/commented.js'),
      ['/*', "import { oldThing } from './old.js';", '*/', 'console.log(1);', ''].join('\n'),
    );
    const result = await runLint(directory);
    assert.equal(result.code, 0, result.stderr);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('an import attribute clause still closes the statement', async () => {
  const directory = await makeWorkspace({});
  try {
    await fs.writeFile(path.join(directory, 'src/app.js'), [
      "import data from './data.json' with { type: 'json' };",
      '',
      'console.log(1);',
      '',
    ].join('\n'));
    const result = await runLint(directory);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /src\/app\.js:1: unused import data/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('a comment that looks like a from clause does not close the statement', async () => {
  const directory = await makeWorkspace({});
  try {
    await fs.writeFile(
      path.join(directory, 'src/dep.js'),
      'export const dead = 1;\nexport const alsoDead = 2;\n',
    );
    await fs.writeFile(path.join(directory, 'src/app.js'), [
      'import {',
      '  dead,',
      "  // from './fake.js'",
      '  alsoDead,',
      "} from './dep.js';",
      '',
      'console.log(1);',
      '',
    ].join('\n'));
    const result = await runLint(directory);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /unused import dead/);
    assert.match(result.stderr, /unused import alsoDead/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('an attribute clause spanning lines keeps the statement open', async () => {
  const directory = await makeWorkspace({});
  try {
    await fs.writeFile(path.join(directory, 'src/app.js'), [
      "import data from './data.json' with {",
      "  type: 'json',",
      '};',
      '',
      'console.log(1);',
      '',
    ].join('\n'));
    const result = await runLint(directory);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /src\/app\.js:1: unused import data/);
    // The attribute key is not a specifier and must never be reported as one.
    assert.doesNotMatch(result.stderr, /unused import type/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('an indented import is still checked', async () => {
  const directory = await makeWorkspace({});
  try {
    await fs.writeFile(path.join(directory, 'src/dep.js'), 'export const dead = 1;\n');
    await fs.writeFile(
      path.join(directory, 'src/app.js'),
      "  import { dead } from './dep.js';\n\nconsole.log(1);\n",
    );
    const result = await runLint(directory);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /unused import dead/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('a block comment between specifiers does not break the statement', async () => {
  const directory = await makeWorkspace({});
  try {
    await fs.writeFile(
      path.join(directory, 'src/dep.js'),
      'export const dead = 1;\nexport const used = 2;\n',
    );
    // Reported as unused before: the comment ate the rest of the line, so the
    // statement never closed and swallowed the code that used the binding.
    await fs.writeFile(
      path.join(directory, 'src/app.js'),
      "import { used } /* explanation */ from './dep.js';\nconsole.log(used);\n",
    );
    const ok = await runLint(directory);
    assert.equal(ok.code, 0, ok.stderr);

    await fs.writeFile(
      path.join(directory, 'src/app.js'),
      "import { dead } /* explanation */ from './dep.js';\nconsole.log(1);\n",
    );
    const failing = await runLint(directory);
    assert.equal(failing.code, 1);
    assert.match(failing.stderr, /unused import dead/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('an attribute clause ended by ASI closes the statement', async () => {
  const directory = await makeWorkspace({});
  try {
    // Without a semicolon the statement used to run on and consume the next
    // line, hiding the very usage that made the import live.
    await fs.writeFile(path.join(directory, 'src/app.js'), [
      "import data from './data.json' with { type: 'json' }",
      'console.log(data);',
      '',
    ].join('\n'));
    const ok = await runLint(directory);
    assert.equal(ok.code, 0, ok.stderr);

    await fs.writeFile(path.join(directory, 'src/app.js'), [
      "import data from './data.json' with { type: 'json' }",
      'console.log(1);',
      '',
    ].join('\n'));
    const failing = await runLint(directory);
    assert.equal(failing.code, 1);
    assert.match(failing.stderr, /unused import data/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('a regex literal below the imports cannot hide them', async () => {
  const directory = await makeWorkspace({});
  try {
    await fs.writeFile(path.join(directory, 'src/dep.js'), 'export const dead = 1;\n');
    // A backtick or `/*` inside a regex used to corrupt the context tracking
    // for every later line. Only the leading import run is read now, so code
    // below it cannot affect the scan at all.
    await fs.writeFile(path.join(directory, 'src/app.js'), [
      "import { dead } from './dep.js';",
      '',
      'const backtick = /`/;',
      'const opener = /[/*]/;',
      'console.log(backtick, opener);',
      '',
    ].join('\n'));
    const result = await runLint(directory);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /unused import dead/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('the scan starts after a shebang and leading line comments', async () => {
  const directory = await makeWorkspace({});
  try {
    await fs.writeFile(path.join(directory, 'src/dep.js'), 'export const dead = 1;\n');
    await fs.writeFile(path.join(directory, 'src/app.js'), [
      '#!/usr/bin/env node',
      '// header note',
      '',
      "import { dead } from './dep.js';",
      '',
      'console.log(1);',
      '',
    ].join('\n'));
    const result = await runLint(directory);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /src\/app\.js:4: unused import dead/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('an import below other code is out of scope rather than a false failure', async () => {
  const directory = await makeWorkspace({});
  try {
    await fs.writeFile(path.join(directory, 'src/dep.js'), 'export const dead = 1;\n');
    // The deliberate cost of reading only the leading run: this is a miss, and
    // a miss is the direction this check is allowed to be wrong in.
    await fs.writeFile(path.join(directory, 'src/app.js'), [
      'const first = 1;',
      "import { dead } from './dep.js';",
      'console.log(first);',
      '',
    ].join('\n'));
    const result = await runLint(directory);
    assert.equal(result.code, 0, result.stderr);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('code sharing a line with the import still counts as usage', async () => {
  const directory = await makeWorkspace({});
  try {
    await fs.writeFile(
      path.join(directory, 'src/dep.js'),
      'export const used = 1;\nexport const dead = 2;\n',
    );
    // Blanking the whole line used to remove this usage along with the import.
    await fs.writeFile(
      path.join(directory, 'src/app.js'),
      "import { used } from './dep.js'; console.log(used);\n",
    );
    const ok = await runLint(directory);
    assert.equal(ok.code, 0, ok.stderr);

    await fs.writeFile(
      path.join(directory, 'src/app.js'),
      "import { dead } from './dep.js'; console.log(1);\n",
    );
    const failing = await runLint(directory);
    assert.equal(failing.code, 1);
    assert.match(failing.stderr, /unused import dead/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('a non-ASCII binding is checked like any other', async () => {
  const directory = await makeWorkspace({});
  try {
    await fs.writeFile(path.join(directory, 'src/dep.js'), 'export default 1;\nexport const value = 2;\n');
    await fs.writeFile(
      path.join(directory, 'src/app.js'),
      "import café from './dep.js';\n\nconsole.log(1);\n",
    );
    const unused = await runLint(directory);
    assert.equal(unused.code, 1);
    assert.match(unused.stderr, /unused import café/);

    // Using it must clear the error, so the boundary has to be Unicode-aware
    // on both sides of the probe.
    await fs.writeFile(
      path.join(directory, 'src/app.js'),
      "import café from './dep.js';\n\nconsole.log(café);\n",
    );
    const used = await runLint(directory);
    assert.equal(used.code, 0, used.stderr);

    await fs.writeFile(
      path.join(directory, 'src/app.js'),
      "import { value as 이름 } from './dep.js';\n\nconsole.log(1);\n",
    );
    const renamed = await runLint(directory);
    assert.equal(renamed.code, 1);
    assert.match(renamed.stderr, /unused import 이름/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('text inside an unterminated block comment is not read as an import', async () => {
  const directory = await makeWorkspace({});
  try {
    await fs.writeFile(path.join(directory, 'src/dep.js'), 'export default 1;\n');
    // The comment opens on the import's own line, so everything below it is
    // comment text. Reading it as a statement would fail the lint over a name
    // nobody imported.
    await fs.writeFile(path.join(directory, 'src/app.js'), [
      "import used from './dep.js'; /*",
      "import { fake } from './nope.js';",
      '*/',
      'console.log(used);',
      '',
    ].join('\n'));
    const result = await runLint(directory);
    assert.equal(result.code, 0, result.stderr);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('a block comment closed on the same line leaves the check running', async () => {
  const directory = await makeWorkspace({});
  try {
    await fs.writeFile(path.join(directory, 'src/dep.js'), 'export const dead = 1;\n');
    await fs.writeFile(
      path.join(directory, 'src/app.js'),
      "import { dead } from './dep.js'; /* note */\nconsole.log(1);\n",
    );
    const result = await runLint(directory);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /unused import dead/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('snake_case bindings are checked in both directions', async () => {
  const directory = await makeWorkspace({});
  try {
    await fs.writeFile(
      path.join(directory, 'src/dep.js'),
      'export default 1;\nexport const dead_name = 2;\nexport const used_name = 3;\n',
    );
    // `_` is ID_Continue, so these work already; the test pins that against a
    // future narrowing of the identifier pattern.
    await fs.writeFile(
      path.join(directory, 'src/app.js'),
      "import dead_name from './dep.js';\n\nconsole.log(1);\n",
    );
    const defaultUnused = await runLint(directory);
    assert.equal(defaultUnused.code, 1);
    assert.match(defaultUnused.stderr, /unused import dead_name/);

    await fs.writeFile(
      path.join(directory, 'src/app.js'),
      "import { dead_name } from './dep.js';\n\nconsole.log(1);\n",
    );
    const namedUnused = await runLint(directory);
    assert.equal(namedUnused.code, 1);
    assert.match(namedUnused.stderr, /unused import dead_name/);

    await fs.writeFile(
      path.join(directory, 'src/app.js'),
      "import { used_name } from './dep.js';\n\nconsole.log(used_name);\n",
    );
    const used = await runLint(directory);
    assert.equal(used.code, 0, used.stderr);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
