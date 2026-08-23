import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import { ContextForgeStore, SCHEMA_VERSION } from '../src/storage/sqlite.js';
import {
  DEFAULT_KEEP,
  listMigrationBackups,
  migrationBackupInventory,
  pruneMigrationBackups,
} from '../src/storage/migration_backups.js';

async function makeDataDir(names = []) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'contextforge-backups-'));
  for (const name of names) await fs.writeFile(path.join(directory, name), 'x'.repeat(100));
  return directory;
}

const backupName = (version, month) =>
  `contextforge.db.pre-migration-v${version}-2026-${month}-01T00-00-00-000Z.bak`;

test('backups are ordered newest first by their timestamp', async () => {
  const directory = await makeDataDir([backupName(18, '02'), backupName(21, '05'), backupName(19, '03')]);
  try {
    assert.deepEqual(
      listMigrationBackups(directory).map((backup) => backup.schemaVersion),
      [21, 19, 18],
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('pruning keeps the newest and removes the rest', async () => {
  const names = [17, 18, 19, 20, 21].map((version, index) => backupName(version, `0${index + 1}`));
  const directory = await makeDataDir(names);
  try {
    const result = pruneMigrationBackups(directory, 3);
    assert.equal(result.removed.length, 2);
    assert.equal(result.retained, 3);
    assert.deepEqual(
      listMigrationBackups(directory).map((backup) => backup.schemaVersion),
      [21, 20, 19],
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('nothing outside the migration backup naming is ever removed', async () => {
  // An operator keeping their own copy in the data directory must not lose it,
  // and neither must the live database.
  const directory = await makeDataDir([
    backupName(19, '03'),
    backupName(20, '04'),
    'contextforge.db',
    'contextforge.db-wal',
    'my-own-backup.bak',
    'contextforge.db.bak',
  ]);
  try {
    pruneMigrationBackups(directory, 1);
    const remaining = (await fs.readdir(directory)).sort();
    assert.deepEqual(remaining, [
      'contextforge.db',
      'contextforge.db-wal',
      'contextforge.db.bak',
      backupName(20, '04'),
      'my-own-backup.bak',
    ].sort());
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('a keep of zero still leaves the newest backup in place', async () => {
  // The backup just taken is the one a failed migration needs, so retention can
  // never reach nothing however the setting is misread.
  const directory = await makeDataDir([backupName(19, '03'), backupName(20, '04')]);
  try {
    const result = pruneMigrationBackups(directory, 0);
    assert.equal(result.removed.length, 1);
    assert.deepEqual(listMigrationBackups(directory).map((b) => b.schemaVersion), [20]);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('the protected backup survives even when it sorts oldest', async () => {
  // Ordering comes from the filename timestamp, so a clock that moved backwards
  // between migrations sorts the newest backup last. Without protection the
  // rollback this migration depends on would be the first thing deleted.
  const directory = await makeDataDir([backupName(18, '06'), backupName(19, '07'), backupName(20, '08')]);
  try {
    const fresh = path.join(directory, backupName(21, '01'));
    await fs.writeFile(fresh, 'x'.repeat(100));

    const result = pruneMigrationBackups(directory, 3, fresh);
    assert.ok(await fs.stat(fresh), 'the protected backup must still exist');
    assert.equal(result.retained, 3);
    assert.deepEqual(
      listMigrationBackups(directory).map((backup) => backup.schemaVersion).sort(),
      [19, 20, 21],
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('protecting a backup does not raise the retained count', async () => {
  const directory = await makeDataDir([backupName(18, '02'), backupName(19, '03')]);
  try {
    const protectedFile = path.join(directory, backupName(19, '03'));
    const result = pruneMigrationBackups(directory, 1, protectedFile);
    assert.equal(result.retained, 1);
    assert.deepEqual(listMigrationBackups(directory).map((b) => b.schemaVersion), [19]);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('a non-integer keep falls back to the default rather than to one', async () => {
  const names = [16, 17, 18, 19, 20].map((version, index) => backupName(version, `0${index + 1}`));
  const directory = await makeDataDir(names);
  try {
    const result = pruneMigrationBackups(directory, undefined);
    assert.equal(result.retained, DEFAULT_KEEP);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('pruning is a no-op when the count is already within the limit', async () => {
  const directory = await makeDataDir([backupName(20, '04')]);
  try {
    const result = pruneMigrationBackups(directory, 3);
    assert.deepEqual(result.removed, []);
    assert.equal(result.retained, 1);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('the inventory reports what the backups occupy', async () => {
  const directory = await makeDataDir([backupName(19, '03'), backupName(20, '04')]);
  try {
    assert.deepEqual(migrationBackupInventory(directory, 3), { count: 2, bytes: 200, keep: 3 });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('a missing data directory reads as no backups rather than throwing', async () => {
  const directory = path.join(os.tmpdir(), 'contextforge-backups-absent-directory');
  assert.deepEqual(listMigrationBackups(directory), []);
  assert.deepEqual(migrationBackupInventory(directory, 3), { count: 0, bytes: 0, keep: 3 });
  assert.deepEqual(pruneMigrationBackups(directory, 3), { removed: [], retained: 0 });
});

test('a real migration prunes older backups and reports what it removed', async () => {
  // The unit tests above exercise the retention logic directly; this one drives
  // it the way it actually runs, through a store opening on an older schema.
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'contextforge-backups-'));
  try {
    const initial = new ContextForgeStore({ dataDir: directory });
    initial.close();

    // Stand in for backups left by earlier migrations.
    for (const name of [backupName(15, '01'), backupName(16, '02'), backupName(17, '03')]) {
      await fs.writeFile(path.join(directory, name), 'x'.repeat(100));
    }

    const db = new Database(path.join(directory, 'contextforge.db'));
    try {
      db.prepare("UPDATE schema_meta SET value = ? WHERE key = 'schema_version'").run(String(SCHEMA_VERSION - 1));
    } finally {
      db.close();
    }

    const migrated = new ContextForgeStore({ dataDir: directory, migrationBackupKeep: 2 });
    try {
      // The backup this migration took must be one of the survivors.
      assert.equal(migrated.migrationBackup.fromSchemaVersion, SCHEMA_VERSION - 1);
      assert.ok(await fs.stat(migrated.migrationBackup.file));

      assert.equal(migrated.migrationBackup.pruned.retained, 2);
      assert.equal(migrated.migrationBackup.pruned.removed.length, 2);
      assert.deepEqual(listMigrationBackups(directory).length, 2);

      // dbInfo makes the remaining footprint visible.
      const info = migrated.dbInfo();
      assert.equal(info.migrationBackups.count, 2);
      assert.equal(info.migrationBackups.keep, 2);
      assert.ok(info.migrationBackups.bytes > 0);
    } finally {
      migrated.close();
    }
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
