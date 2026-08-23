import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

export function ciDetectRunTests(files) {
  const result = spawnSync('bash', ['scripts/ci-detect-run-tests.sh'], {
    cwd: process.cwd(),
    input: `${files.join('\n')}\n`,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

export function fakeSpawnThatClosesOnKill(expectedSignal = 'SIGKILL') {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.exitCode = null;
  child.signals = [];
  child.closed = false;
  child.kill = (signal) => {
    child.signals.push(signal);
    if (signal === expectedSignal) {
      child.closed = true;
      queueMicrotask(() => child.emit('close', null, signal));
    }
    return true;
  };
  return { child, spawnImpl: () => child };
}

export function testAdminPasswordHash(password) {
  const salt = Buffer.from('contextforge-test-admin-salt');
  const iterations = 100000;
  const hash = crypto.pbkdf2Sync(password, salt, iterations, 32, 'sha256');
  return `${iterations}:${salt.toString('hex')}:${hash.toString('hex')}`;
}

export function collectSchemaKeywordPaths(value, keywords, pathParts = []) {
  const matches = [];
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      matches.push(...collectSchemaKeywordPaths(item, keywords, [...pathParts, String(index)]));
    }
    return matches;
  }
  if (!value || typeof value !== 'object') {
    return matches;
  }
  for (const [key, nested] of Object.entries(value)) {
    const nextPath = [...pathParts, key];
    if (keywords.has(key)) {
      matches.push(nextPath.join('.'));
    }
    matches.push(...collectSchemaKeywordPaths(nested, keywords, nextPath));
  }
  return matches;
}

export function collectStrictObjectSchemaViolations(value, pathParts = []) {
  const violations = [];
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      violations.push(...collectStrictObjectSchemaViolations(item, [...pathParts, String(index)]));
    }
    return violations;
  }
  if (!value || typeof value !== 'object') {
    return violations;
  }
  const type = value.type;
  const includesObject = type === 'object' || (Array.isArray(type) && type.includes('object'));
  if (includesObject) {
    const pathText = pathParts.join('.') || '<root>';
    if (value.additionalProperties !== false) {
      violations.push(`${pathText}:missing_additionalProperties_false`);
    }
    const properties = value.properties && typeof value.properties === 'object' ? Object.keys(value.properties) : [];
    const required = Array.isArray(value.required) ? value.required : [];
    for (const property of properties) {
      if (!required.includes(property)) {
        violations.push(`${pathText}:missing_required:${property}`);
      }
    }
    for (const property of required) {
      if (!properties.includes(property)) {
        violations.push(`${pathText}:unknown_required:${property}`);
      }
    }
  }
  for (const [key, nested] of Object.entries(value)) {
    violations.push(...collectStrictObjectSchemaViolations(nested, [...pathParts, key]));
  }
  return violations;
}
