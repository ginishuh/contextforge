import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createContextForge } from '../../src/core.js';

test(
  'codex_exec live provider smoke',
  { skip: process.env.CONTEXTFORGE_LIVE_TESTS !== 'true' },
  async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'contextforge-live-test-'));
    const app = createContextForge({
      env: {
        ...process.env,
        CONTEXTFORGE_DATA_DIR: dataDir,
        CONTEXTFORGE_AUTO_PROMOTE_AUDIT_ENABLED: 'false',
      },
      cwd: process.cwd(),
    });
    try {
      const result = await app.checkCodexExec({ live: true });
      assert.equal(result.ok, true, result.error?.message || 'codex_exec live smoke failed');
      assert.equal(result.commandAvailable, true);
      assert.equal(result.smoke?.ok, true);
    } finally {
      app.close();
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  },
);
