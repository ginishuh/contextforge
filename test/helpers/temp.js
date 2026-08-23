import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export async function makeTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'contextforge-test-'));
}

export async function makeNonGitTempDir() {
  return makeTempDir();
}

export async function waitForCondition(predicate, message, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(message);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
