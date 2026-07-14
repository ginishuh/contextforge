#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const reportFile = path.resolve(process.env.CONTEXTFORGE_RELEASE_REPORT || 'artifacts/release/package-report.json');
const budgets = Object.freeze({ packedBytes: 400_000, unpackedBytes: 1_750_000, entryCount: 90 });
const publishedScripts = Object.freeze([
  'scripts/benchmark-retrieval.js',
  'scripts/check-release.js',
  'scripts/install-agent-router-service.sh',
  'scripts/install-claude-code-router-service.sh',
  'scripts/install-codex-router-service.sh',
  'scripts/install-codex-watch-service.sh',
  'scripts/junit-report.js',
  'scripts/lint-source.js',
  'scripts/run-quality-eval.js',
  'scripts/run-tests.js',
]);

async function readJson(file) {
  return JSON.parse(await fs.readFile(path.join(root, file), 'utf8'));
}

async function walkMarkdown(directory) {
  const entries = await fs.readdir(path.join(root, directory), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relative = path.posix.join(directory, entry.name);
    if (relative.startsWith('docs/issues/')) continue;
    if (entry.isDirectory()) files.push(...(await walkMarkdown(relative)));
    else if (entry.isFile() && entry.name.endsWith('.md')) files.push(relative);
  }
  return files;
}

function localTarget(rawTarget) {
  const target = String(rawTarget || '').trim().replace(/^<|>$/g, '');
  if (!target || target.startsWith('#') || /^(?:https?:|mailto:|data:)/i.test(target)) return null;
  const withoutFragment = target.split('#', 1)[0].split('?', 1)[0];
  if (!withoutFragment) return null;
  try {
    return decodeURIComponent(withoutFragment);
  } catch {
    return withoutFragment;
  }
}

function markdownTargets(content) {
  const targets = [];
  for (const match of content.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+['"][^)]*)?\)/g)) targets.push(match[1]);
  for (const match of content.matchAll(/(?:href|src)=['"]([^'"]+)['"]/g)) targets.push(match[1]);
  return targets;
}

function commandReferences(content) {
  const files = [];
  const scripts = [];
  for (const match of content.matchAll(/\bnode\s+((?:src|scripts)\/[A-Za-z0-9_./-]+\.(?:js|mjs))\b/g)) files.push(match[1]);
  for (const match of content.matchAll(/\b(?:bash\s+)?(scripts\/[A-Za-z0-9_./-]+\.sh)\b/g)) files.push(match[1]);
  for (const match of content.matchAll(/\bcp\s+((?:examples|docs)\/[A-Za-z0-9_./-]+)\s+/g)) files.push(match[1]);
  for (const match of content.matchAll(/\bnpm\s+run\s+([A-Za-z0-9_.:-]+)/g)) scripts.push(match[1]);
  return { files, scripts };
}

async function inspectMarkdown(packageManifest) {
  const files = ['README.md', 'README.ko.md', 'CHANGELOG.md', ...(await walkMarkdown('docs'))];
  const brokenLinks = [];
  const missingCommandFiles = [];
  const missingPackageScripts = [];
  let localLinks = 0;
  let commandFileReferences = 0;
  let packageScriptReferences = 0;
  const localTargets = [];
  const commandTargets = [];
  for (const file of files) {
    const content = await fs.readFile(path.join(root, file), 'utf8');
    for (const rawTarget of markdownTargets(content)) {
      const target = localTarget(rawTarget);
      if (!target) continue;
      localLinks += 1;
      const resolved = target.startsWith('/')
        ? path.join(root, target.slice(1))
        : path.resolve(root, path.dirname(file), target);
      localTargets.push({
        file,
        target,
        resolved: path.relative(root, resolved).split(path.sep).join('/'),
      });
      try {
        await fs.access(resolved);
      } catch {
        brokenLinks.push({ file, target });
      }
    }
    const commands = commandReferences(content);
    for (const target of commands.files) {
      commandFileReferences += 1;
      commandTargets.push({ file, target });
      try {
        await fs.access(path.join(root, target));
      } catch {
        missingCommandFiles.push({ file, target });
      }
    }
    for (const script of commands.scripts) {
      packageScriptReferences += 1;
      if (!packageManifest.scripts?.[script]) missingPackageScripts.push({ file, script });
    }
  }
  return {
    files: files.length,
    localLinks,
    commandFileReferences,
    packageScriptReferences,
    brokenLinks,
    missingCommandFiles,
    missingPackageScripts,
    localTargets,
    commandTargets,
  };
}

async function inspectVersions(packageManifest, packageLock) {
  const english = await fs.readFile(path.join(root, 'README.md'), 'utf8');
  const korean = await fs.readFile(path.join(root, 'README.ko.md'), 'utf8');
  const englishReference = await fs.readFile(path.join(root, 'docs/reference.md'), 'utf8');
  const koreanReference = await fs.readFile(path.join(root, 'docs/reference.ko.md'), 'utf8');
  const versionSource = await fs.readFile(path.join(root, 'src/version.js'), 'utf8');
  const mcpSource = await fs.readFile(path.join(root, 'src/mcp.js'), 'utf8');
  const version = packageManifest.version;
  const checks = {
    packageLock: packageLock.version === version && packageLock.packages?.['']?.version === version,
    englishVersion: english.includes(`Current package version: \`${version}\``),
    englishRelease: english.includes(`## What's New In ${version}`),
    koreanVersion: korean.includes(`현재 package version: \`${version}\``),
    koreanRelease: korean.includes(`## ${version}에서 좋아진 점`),
    englishReferenceVersion:
      englishReference.includes(`Current package version: \`${version}\``) &&
      englishReference.includes(`## What's New In ${version}`),
    koreanReferenceVersion:
      koreanReference.includes(`현재 package version: \`${version}\``) &&
      koreanReference.includes(`## ${version}에서 좋아진 점`),
    canonicalSource: /packageManifest\.version/.test(versionSource),
    mcpCanonicalVersion: /CONTEXTFORGE_VERSION/.test(mcpSource),
  };
  return { version, checks, passed: Object.values(checks).every(Boolean) };
}

function inspectPackage() {
  const command = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const packed = spawnSync(command, ['pack', '--dry-run', '--json'], {
    cwd: root,
    encoding: 'utf8',
    env: process.env,
  });
  if (packed.error) throw packed.error;
  if (packed.status !== 0) throw new Error(`npm pack --dry-run failed: ${packed.stderr || packed.stdout}`);
  const result = JSON.parse(packed.stdout)[0];
  const paths = result.files.map((file) => file.path);
  const required = [
    'LICENSE',
    'README.md',
    'README.ko.md',
    'CHANGELOG.md',
    'package.json',
    'src/cli.js',
    'src/mcp.js',
    'src/server.js',
    'examples/server.env.example',
    'docs/runtime-modes.md',
    'docs/operations.md',
    'docs/skills/contextforge-memory/SKILL.md',
    ...publishedScripts,
  ];
  const forbiddenPatterns = [
    /^artifacts\//,
    /^docs\/assets\//,
    /^docs\/issues\//,
    /^test\//,
    /^\.github\//,
    /(?:^|\/)\.env(?:\.|$)/,
    /\.(?:db|db-wal|db-shm)$/,
  ];
  const missingRequired = required.filter((file) => !paths.includes(file));
  const forbidden = paths.filter((file) => forbiddenPatterns.some((pattern) => pattern.test(file)));
  const actualScripts = paths.filter((file) => file.startsWith('scripts/')).sort();
  const missingPublishedScripts = publishedScripts.filter((file) => !actualScripts.includes(file));
  const unexpectedPublishedScripts = actualScripts.filter((file) => !publishedScripts.includes(file));
  const budgetChecks = {
    packedBytes: result.size <= budgets.packedBytes,
    unpackedBytes: result.unpackedSize <= budgets.unpackedBytes,
    entryCount: result.entryCount <= budgets.entryCount,
  };
  return {
    name: result.name,
    version: result.version,
    packedBytes: result.size,
    unpackedBytes: result.unpackedSize,
    entryCount: result.entryCount,
    budgets,
    budgetChecks,
    missingRequired,
    forbidden,
    publishedScripts,
    missingPublishedScripts,
    unexpectedPublishedScripts,
    files: result.files,
    passed:
      missingRequired.length === 0 &&
      forbidden.length === 0 &&
      missingPublishedScripts.length === 0 &&
      unexpectedPublishedScripts.length === 0 &&
      Object.values(budgetChecks).every(Boolean),
  };
}

function packageContains(paths, target) {
  return paths.has(target) || [...paths].some((file) => file.startsWith(`${target}/`));
}

function inspectPublishedMarkdown(markdown, packageResult) {
  const paths = new Set(packageResult.files.map((file) => file.path));
  const publishedSources = new Set(
    [...new Set([...markdown.localTargets, ...markdown.commandTargets].map((item) => item.file))].filter((file) =>
      packageContains(paths, file),
    ),
  );
  const missingLocalTargets = markdown.localTargets.filter(
    ({ file, resolved }) => publishedSources.has(file) && !packageContains(paths, resolved),
  );
  const missingCommandTargets = markdown.commandTargets.filter(
    ({ file, target }) => publishedSources.has(file) && !packageContains(paths, target),
  );
  return {
    publishedMarkdownFiles: publishedSources.size,
    checkedLocalTargets: markdown.localTargets.filter(({ file }) => publishedSources.has(file)).length,
    checkedCommandTargets: markdown.commandTargets.filter(({ file }) => publishedSources.has(file)).length,
    missingLocalTargets,
    missingCommandTargets,
    passed: missingLocalTargets.length === 0 && missingCommandTargets.length === 0,
  };
}

let report;
try {
  const packageManifest = await readJson('package.json');
  const packageLock = await readJson('package-lock.json');
  const [markdown, versions] = await Promise.all([
    inspectMarkdown(packageManifest),
    inspectVersions(packageManifest, packageLock),
  ]);
  const packageResult = inspectPackage();
  const publishedMarkdown = inspectPublishedMarkdown(markdown, packageResult);
  const markdownPassed =
    markdown.brokenLinks.length === 0 &&
    markdown.missingCommandFiles.length === 0 &&
    markdown.missingPackageScripts.length === 0;
  report = {
    kind: 'release_hygiene_report',
    passed: markdownPassed && publishedMarkdown.passed && versions.passed && packageResult.passed,
    markdown: {
      ...markdown,
      localTargets: undefined,
      commandTargets: undefined,
      publishedPackage: publishedMarkdown,
      passed: markdownPassed && publishedMarkdown.passed,
    },
    versions,
    package: packageResult,
  };
} catch (error) {
  report = {
    kind: 'release_hygiene_report',
    passed: false,
    error: { name: error.name, message: error.message },
  };
}

await fs.mkdir(path.dirname(reportFile), { recursive: true });
await fs.writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(
  JSON.stringify(
    report.passed
      ? {
          kind: report.kind,
          passed: report.passed,
          markdown: {
            files: report.markdown.files,
            localLinks: report.markdown.localLinks,
            commandFileReferences: report.markdown.commandFileReferences,
            packageScriptReferences: report.markdown.packageScriptReferences,
          },
          versions: report.versions,
          package: {
            name: report.package.name,
            version: report.package.version,
            packedBytes: report.package.packedBytes,
            unpackedBytes: report.package.unpackedBytes,
            entryCount: report.package.entryCount,
            budgets: report.package.budgets,
          },
          reportFile,
        }
      : report,
    null,
    2,
  ),
);
if (!report.passed) process.exitCode = 1;
