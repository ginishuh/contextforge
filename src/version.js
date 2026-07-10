import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const packageManifest = require('../package.json');

export const CONTEXTFORGE_VERSION = packageManifest.version;
