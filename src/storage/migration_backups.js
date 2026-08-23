import fs from 'node:fs';
import path from 'node:path';

// A schema migration copies the whole database before touching it, which is the
// right thing to do — but nothing ever removed those copies, so they accumulated
// one per migration forever. On a database of 400KB the backups had already
// grown to nearly twice the live data.
//
// Keeping them bounded is a retention problem, not a reason to stop taking
// them: the newest backup is the one a failed migration needs, and it is never
// pruned.

// Matches only the names the migration backup writes. An operator's own copy
// sitting in the same directory has a different name and is never touched.
const BACKUP_PATTERN = /^contextforge\.db\.pre-migration-v(\d+)-(.+)\.bak$/;

// Taken with VACUUM INTO so the copy is a consistent snapshot rather than a
// file read out from under an open connection. Returns null when there is
// nothing to migrate from, which is the normal case on a current database.
export function createMigrationBackup(db, dataDir, fromSchemaVersion, toSchemaVersion) {
  if (
    !Number.isInteger(fromSchemaVersion)
    || fromSchemaVersion <= 0
    || fromSchemaVersion >= toSchemaVersion
  ) {
    return null;
  }
  const timestamp = new Date().toISOString().replaceAll(/[:.]/g, '-');
  const file = path.join(dataDir, `contextforge.db.pre-migration-v${fromSchemaVersion}-${timestamp}.bak`);
  db.prepare('VACUUM INTO ?').run(file);
  fs.chmodSync(file, 0o600);
  return { file, fromSchemaVersion, toSchemaVersion };
}

export function listMigrationBackups(dataDir) {
  let entries;
  try {
    entries = fs.readdirSync(dataDir);
  } catch {
    return [];
  }
  return entries
    .map((name) => {
      const match = BACKUP_PATTERN.exec(name);
      if (!match) return null;
      return {
        name,
        file: path.join(dataDir, name),
        schemaVersion: Number(match[1]),
        timestamp: match[2],
      };
    })
    .filter(Boolean)
    // The timestamp is an ISO-8601 string with `:` and `.` replaced, so it
    // still sorts lexically in time order. Newest first.
    .sort((left, right) => right.timestamp.localeCompare(left.timestamp));
}

export function pruneMigrationBackups(dataDir, keep) {
  const backups = listMigrationBackups(dataDir);
  // Never go below one. A keep of zero would delete the backup just taken,
  // which is the one most likely to be needed.
  const retain = Math.max(1, Number.isInteger(keep) ? keep : 1);
  const removed = [];
  for (const backup of backups.slice(retain)) {
    try {
      fs.rmSync(backup.file);
      removed.push(backup.name);
    } catch {
      // A backup that cannot be removed is not worth failing a migration over.
      // It stays, and the next migration reconsiders it.
    }
  }
  return { removed, retained: Math.min(retain, backups.length) };
}

// Reported through dbInfo so the space these occupy is visible to an operator
// rather than something they discover when a disk fills.
export function migrationBackupInventory(dataDir, keep) {
  const backups = listMigrationBackups(dataDir);
  let bytes = 0;
  for (const backup of backups) {
    try {
      bytes += fs.statSync(backup.file).size;
    } catch {
      // Raced with a deletion; the total simply omits it.
    }
  }
  return { count: backups.length, bytes, keep };
}
