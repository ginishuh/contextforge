import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { SCHEMA_VERSION } from './sqlite.js';

function requireFile(value, name) {
  if (!value) throw new Error(`${name} is required.`);
  return path.resolve(String(value));
}

function sha256File(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

export function verifySqliteBackup({ file, requireMetadata = false } = {}) {
  const backupPath = requireFile(file, 'file');
  const metadataPath = `${backupPath}.metadata.json`;
  const database = new Database(backupPath, { readonly: true, fileMustExist: true });
  try {
    const quickCheckRows = database.pragma('quick_check');
    const quickCheck = quickCheckRows.map((row) => Object.values(row)[0]);
    const foreignKeyViolations = database.pragma('foreign_key_check');
    const hasSchemaMeta = database
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_meta'")
      .get();
    const schemaVersion = hasSchemaMeta
      ? Number(database.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get()?.value)
      : null;
    const hash = sha256File(backupPath);
    let metadata = null;
    if (fs.existsSync(metadataPath)) {
      metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
    } else if (requireMetadata) {
      throw new Error(`Backup metadata is missing: ${metadataPath}`);
    }
    const metadataHashMatches = metadata?.sha256 ? metadata.sha256 === hash : null;
    const ok =
      quickCheck.length === 1 &&
      quickCheck[0] === 'ok' &&
      foreignKeyViolations.length === 0 &&
      Number.isInteger(schemaVersion) &&
      schemaVersion <= SCHEMA_VERSION &&
      metadataHashMatches !== false;
    return {
      kind: 'contextforge_backup_verification',
      ok,
      file: backupPath,
      sizeBytes: fs.statSync(backupPath).size,
      sha256: hash,
      schemaVersion,
      supportedSchemaVersion: SCHEMA_VERSION,
      quickCheck,
      foreignKeyViolations,
      metadataPath: fs.existsSync(metadataPath) ? metadataPath : null,
      metadataHashMatches,
      metadata,
    };
  } finally {
    database.close();
  }
}

export async function backupSqliteDatabase({ dataDir, file, force = false, backupRunner = null } = {}) {
  const sourcePath = path.join(path.resolve(dataDir), 'contextforge.db');
  const backupPath = requireFile(file, 'file');
  const metadataPath = `${backupPath}.metadata.json`;
  if (backupPath === sourcePath) throw new Error('Backup destination must differ from the live database.');
  if (fs.existsSync(backupPath) && !force) throw new Error(`Backup destination already exists: ${backupPath}`);
  fs.mkdirSync(path.dirname(backupPath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${backupPath}.tmp-${process.pid}-${randomUUID()}`;
  const temporaryMetadataPath = `${temporaryPath}.metadata.json`;
  const source = new Database(sourcePath, { readonly: true, fileMustExist: true });
  try {
    await (backupRunner ? backupRunner(source, temporaryPath) : source.backup(temporaryPath));
  } catch (error) {
    fs.rmSync(temporaryPath, { force: true });
    throw error;
  } finally {
    source.close();
  }
  fs.chmodSync(temporaryPath, 0o600);
  const verification = verifySqliteBackup({ file: temporaryPath });
  if (!verification.ok) {
    fs.rmSync(temporaryPath, { force: true });
    throw new Error(`Backup verification failed before install: ${backupPath}`);
  }
  const metadata = {
    kind: 'contextforge_backup_metadata',
    createdAt: new Date().toISOString(),
    schemaVersion: verification.schemaVersion,
    sizeBytes: verification.sizeBytes,
    sha256: verification.sha256,
  };
  fs.writeFileSync(temporaryMetadataPath, `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 });
  const stagedVerification = verifySqliteBackup({ file: temporaryPath, requireMetadata: true });
  if (!stagedVerification.ok) {
    fs.rmSync(temporaryPath, { force: true });
    fs.rmSync(temporaryMetadataPath, { force: true });
    throw new Error(`Backup metadata verification failed before install: ${backupPath}`);
  }

  const replacementId = `${process.pid}-${randomUUID()}`;
  const previousPath = `${backupPath}.previous-${replacementId}`;
  const previousMetadataPath = `${metadataPath}.previous-${replacementId}`;
  const hadPrevious = fs.existsSync(backupPath);
  const hadPreviousMetadata = fs.existsSync(metadataPath);
  let movedPrevious = false;
  let movedPreviousMetadata = false;
  let installedBackup = false;
  let installedMetadata = false;
  try {
    if (hadPrevious) {
      fs.renameSync(backupPath, previousPath);
      movedPrevious = true;
    }
    if (hadPreviousMetadata) {
      fs.renameSync(metadataPath, previousMetadataPath);
      movedPreviousMetadata = true;
    }
    fs.renameSync(temporaryPath, backupPath);
    installedBackup = true;
    fs.renameSync(temporaryMetadataPath, metadataPath);
    installedMetadata = true;
  } catch (error) {
    if (installedBackup) fs.rmSync(backupPath, { force: true });
    if (installedMetadata) fs.rmSync(metadataPath, { force: true });
    if (movedPrevious && fs.existsSync(previousPath)) fs.renameSync(previousPath, backupPath);
    if (movedPreviousMetadata && fs.existsSync(previousMetadataPath)) {
      fs.renameSync(previousMetadataPath, metadataPath);
    }
    throw error;
  } finally {
    fs.rmSync(temporaryPath, { force: true });
    fs.rmSync(temporaryMetadataPath, { force: true });
  }
  fs.rmSync(previousPath, { force: true });
  fs.rmSync(previousMetadataPath, { force: true });
  return {
    file: backupPath,
    metadataPath,
    ...metadata,
    kind: 'contextforge_backup',
    verification: verifySqliteBackup({ file: backupPath, requireMetadata: true }),
  };
}

export async function restoreSqliteDatabase({ dataDir, file, dryRun = true, confirmOffline = false } = {}) {
  const resolvedDataDir = path.resolve(dataDir);
  const sourcePath = requireFile(file, 'file');
  const targetPath = path.join(resolvedDataDir, 'contextforge.db');
  const sourceVerification = verifySqliteBackup({ file: sourcePath, requireMetadata: true });
  if (!sourceVerification.ok) throw new Error(`Restore source verification failed: ${sourcePath}`);
  const plan = {
    kind: 'contextforge_restore',
    dryRun: dryRun !== false,
    sourceFile: sourcePath,
    targetFile: targetPath,
    sourceVerification,
    requiresOfflineConfirmation: true,
  };
  if (dryRun !== false) return plan;
  if (!confirmOffline) {
    throw new Error('restoreDatabase requires confirmOffline=true after stopping the ContextForge server and workers.');
  }
  fs.mkdirSync(resolvedDataDir, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replaceAll(/[:.]/g, '-');
  const preRestorePath = `${targetPath}.pre-restore-${stamp}.bak`;
  if (fs.existsSync(targetPath)) {
    await backupSqliteDatabase({ dataDir: resolvedDataDir, file: preRestorePath });
  }
  const temporaryPath = `${targetPath}.restore-${process.pid}-${randomUUID()}.tmp`;
  fs.copyFileSync(sourcePath, temporaryPath, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(temporaryPath, 0o600);
  const temporaryVerification = verifySqliteBackup({ file: temporaryPath });
  if (!temporaryVerification.ok) {
    fs.rmSync(temporaryPath, { force: true });
    throw new Error('Temporary restored database failed verification.');
  }
  for (const suffix of ['-wal', '-shm']) fs.rmSync(`${targetPath}${suffix}`, { force: true });
  fs.renameSync(temporaryPath, targetPath);
  const restoredVerification = verifySqliteBackup({ file: targetPath });
  if (!restoredVerification.ok) {
    const error = new Error(
      `Restored database failed final verification. Recover from pre-restore backup: ${preRestorePath}`,
    );
    error.code = 'CONTEXTFORGE_RESTORE_VERIFICATION_FAILED';
    error.preRestoreBackup = fs.existsSync(preRestorePath) ? preRestorePath : null;
    throw error;
  }
  return {
    ...plan,
    dryRun: false,
    restored: true,
    preRestoreBackup: fs.existsSync(preRestorePath) ? preRestorePath : null,
    verification: restoredVerification,
  };
}
