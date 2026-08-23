import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

const execFileAsync = promisify(execFile);

// The published package ships scripts/lint-source.js and documents `npm run
// lint`, so the packed artifact has to be able to run it. That needs the budget
// manifest in the package, and it needs the budget checks to tolerate roots the
// package deliberately omits, such as test/.
test('packed package can run the documented source lint', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'contextforge-packed-lint-'));
  try {
    const { stdout } = await execFileAsync(
      'npm',
      ['pack', '--pack-destination', tempDir, '--silent'],
      { cwd: process.cwd() },
    );
    const tarball = stdout.trim().split('\n').pop();
    assert.ok(tarball.endsWith('.tgz'), `unexpected npm pack output: ${stdout}`);
    await execFileAsync('tar', ['xzf', tarball], { cwd: tempDir });

    const packageDir = path.join(tempDir, 'package');
    const budgetFile = path.join(packageDir, 'scripts', 'line-budgets.json');
    const budgets = JSON.parse(await fs.readFile(budgetFile, 'utf8'));
    assert.ok(Object.keys(budgets.budgets).length > 0, 'packed budget manifest is empty');
    await assert.rejects(fs.stat(path.join(packageDir, 'test')), 'package unexpectedly ships test/');

    // No repository file under test/ is large enough to carry a budget any
    // more, so the omitted-root tolerance is exercised by writing the entry the
    // package would leave unreachable instead of relying on the real manifest
    // to happen to contain one.
    budgets.budgets['test/omitted-root.test.js'] = 4096;
    await fs.writeFile(budgetFile, `${JSON.stringify(budgets, null, 2)}\n`);

    const lint = await execFileAsync('node', ['scripts/lint-source.js'], { cwd: packageDir });
    assert.match(lint.stdout, /Source lint passed/);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
