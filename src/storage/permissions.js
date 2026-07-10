import fs from 'node:fs';
import path from 'node:path';

export const PRIVATE_DATA_DIRECTORY_MODE = 0o700;
export const PRIVATE_DATA_FILE_MODE = 0o600;
export const SQLITE_PRIVATE_FILE_SUFFIXES = ['', '-journal', '-wal', '-shm'];

export function secureDataDirectoryPermissions(dataDir, { platform = process.platform } = {}) {
  fs.mkdirSync(dataDir, { recursive: true, mode: PRIVATE_DATA_DIRECTORY_MODE });
  const dbPath = path.join(dataDir, 'contextforge.db');
  if (!fs.existsSync(dbPath)) {
    const fd = fs.openSync(dbPath, 'wx', PRIVATE_DATA_FILE_MODE);
    fs.closeSync(fd);
  }
  if (platform === 'win32') {
    return { enforced: false, reason: 'windows_acl_inherited', dbPath };
  }
  fs.chmodSync(dataDir, PRIVATE_DATA_DIRECTORY_MODE);
  for (const suffix of SQLITE_PRIVATE_FILE_SUFFIXES) {
    const filePath = `${dbPath}${suffix}`;
    if (fs.existsSync(filePath)) fs.chmodSync(filePath, PRIVATE_DATA_FILE_MODE);
  }
  return { enforced: true, reason: 'posix_mode_enforced', dbPath };
}
