#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// The line budgets are a ratchet, not a ceiling. A file may never grow past its
// budget, and once decomposition buys real slack the budget must be tightened so
// the reclaimed lines cannot be silently spent again.
//
// RATCHET_SLACK_LINES is the slack we tolerate before demanding a tightening.
// It is deliberately larger than routine edits (a few lines of churn in either
// direction is normal and should not fail lint) but far smaller than a real
// decomposition step, so any extraction that actually moves code out is caught.
const RATCHET_SLACK_LINES = 50;

// A file this large is an architecture decision, so it has to be registered in
// the budget file. This stops a new giant module from appearing unbudgeted.
const UNREGISTERED_FILE_LIMIT = 1500;

const defaultRoots = ['src', 'scripts', 'test'];
const defaultBudgetFile = 'scripts/line-budgets.json';

// Budget keys are POSIX-separated so the same budget file works on every OS.
// Windows readdir walks produce backslashes, which would miss every lookup.
function toPosix(filePath) {
  return filePath.split(path.sep).join('/');
}

// Roots reach the orphan check as plain strings, so `./src`, `src/`, and an
// absolute path all have to collapse to the same key the file walk produces.
// Without this, `--root ./src` leaves every budget entry looking out-of-scope
// and the orphan check silently passes.
function canonicalRoot(root) {
  const relative = toPosix(path.relative(process.cwd(), path.resolve(root)));
  const trimmed = relative.replace(/\/+$/, '');
  return trimmed === '' ? '.' : trimmed;
}

function parseArguments(argv) {
  const roots = [];
  let budgetFile = defaultBudgetFile;
  let updateBudgets = false;
  let baseCheck = true;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--update-budgets') {
      updateBudgets = true;
    } else if (argument === '--no-base-check') {
      baseCheck = false;
    } else if (argument === '--root') {
      index += 1;
      if (!argv[index]) throw new Error('--root requires a directory');
      roots.push(canonicalRoot(argv[index]));
    } else if (argument === '--budgets') {
      index += 1;
      if (!argv[index]) throw new Error('--budgets requires a file path');
      budgetFile = argv[index];
    } else {
      throw new Error(`unknown argument ${argument}`);
    }
  }
  return { roots: roots.length ? roots : defaultRoots, budgetFile, updateBudgets, baseCheck };
}

// Budgets must be real integers. A budget written as a string still compares
// against a line count through JavaScript's implicit conversion, so the ordinary
// checks keep passing, but the base comparison below only trusts numbers and
// would skip the entry. Changing the JSON type would then raise a budget without
// tripping anything, so the type is rejected at load time instead.
function readBudgets(budgetFile) {
  if (!fs.existsSync(budgetFile)) return {};
  const parsed = JSON.parse(fs.readFileSync(budgetFile, 'utf8'));
  const budgets = parsed && typeof parsed === 'object' ? parsed.budgets : null;
  if (!budgets || typeof budgets !== 'object') {
    throw new Error(`${budgetFile}: expected an object with a "budgets" map`);
  }
  for (const [file, budget] of Object.entries(budgets)) {
    if (typeof budget !== 'number' || !Number.isInteger(budget) || budget < 0) {
      throw new Error(
        `${budgetFile}: budget for ${file} must be a non-negative integer, got ${JSON.stringify(budget)}`,
      );
    }
  }
  return budgets;
}

function writeBudgets(budgetFile, budgets, note) {
  const sorted = {};
  for (const key of Object.keys(budgets).sort()) sorted[key] = budgets[key];
  const payload = { note, budgets: sorted };
  fs.writeFileSync(budgetFile, `${JSON.stringify(payload, null, 2)}\n`);
}

function javascriptFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return javascriptFiles(file);
    return entry.isFile() && entry.name.endsWith('.js') ? [toPosix(file)] : [];
  });
}

// Count lines the way `wc -l` does so budgets match what a reader sees, and a
// single trailing newline never shifts the number by one.
function countLines(source) {
  if (source === '') return 0;
  const lines = source.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines.length;
}

function gitOutput(args) {
  const result = spawnSync('git', args, { encoding: 'utf8' });
  if (result.error || result.status !== 0) return null;
  return result.stdout;
}

// Prefer the merge base with the integration branch so a budget raised anywhere
// in the branch is caught, not just one raised in the working tree. CI checkouts
// name their base explicitly because the remote-tracking ref may not be fetched;
// a checkout without either can still compare against its own HEAD.
// The HEAD fallback only holds when no base ref exists at all: it compares the
// working tree against the last commit, which still catches an uncommitted
// raise. Once a base ref *is* present but has no merge base with HEAD — a
// shallow clone is the usual cause — falling back to HEAD would compare the
// branch against itself and wave every committed raise through. That case is
// reported instead, so an unverifiable ratchet is never a silent pass.
function baseBudgetRef() {
  const candidates = [process.env.CONTEXTFORGE_LINT_BASE_REF, 'origin/main'].filter(Boolean);
  let unresolved = null;
  for (const candidate of candidates) {
    if (gitOutput(['rev-parse', '--verify', '--quiet', candidate]) === null) continue;
    const mergeBase = gitOutput(['merge-base', candidate, 'HEAD']);
    if (mergeBase !== null && mergeBase.trim()) return { ref: mergeBase.trim() };
    if (unresolved === null) unresolved = candidate;
  }
  if (unresolved !== null) return { ref: null, unresolved };
  return { ref: gitOutput(['rev-parse', '--verify', '--quiet', 'HEAD']) !== null ? 'HEAD' : null };
}

function unresolvedBaseError(unresolved, budgetFile) {
  return (
    `${budgetFile}: no merge base between ${unresolved} and HEAD,`
    + ' so the line budget ratchet cannot be verified against the baseline.'
    + ' Fetch the full history (fetch-depth: 0), set CONTEXTFORGE_LINT_BASE_REF'
    + ' to a ref that shares history, or pass --no-base-check to skip the comparison.'
  );
}

// Returns the committed budgets, or null when no baseline is obtainable. Every
// failure path here is a silent skip on purpose: the published npm package ships
// without a .git directory, and lint must still run there.
function readBaseBudgets(budgetFile) {
  if (gitOutput(['rev-parse', '--git-dir']) === null) return { budgets: null };
  const { ref, unresolved } = baseBudgetRef();
  if (unresolved) return { budgets: null, unresolved };
  if (ref === null) return { budgets: null };
  const relative = toPosix(path.relative(process.cwd(), path.resolve(budgetFile)));
  // `<rev>:./<path>` resolves relative to the cwd; a path outside the repo
  // cannot be addressed that way, so there is nothing to compare.
  if (!relative || relative.startsWith('..')) return { budgets: null };
  const shown = gitOutput(['show', `${ref}:./${relative}`]);
  if (shown === null) return { budgets: null };
  try {
    const parsed = JSON.parse(shown);
    const budgets = parsed && typeof parsed === 'object' ? parsed.budgets : null;
    return { budgets: budgets && typeof budgets === 'object' ? budgets : null };
  } catch {
    return { budgets: null };
  }
}

// Compares a candidate budget map against the committed baseline. Both the
// ordinary lint and --update-budgets run this against the manifest they are
// about to accept, so neither path can leave a budget looser than the baseline.
function baseBudgetViolations(baseBudgets, candidate, measured, budgetFile) {
  const violations = [];
  for (const [file, rawBaseBudget] of Object.entries(baseBudgets)) {
    const current = candidate[file];
    // The base manifest is already committed and cannot be corrected from
    // here, so a loosely typed historical value is coerced rather than
    // rejected. The current manifest is validated strictly at load time.
    const baseBudget = Number(rawBaseBudget);
    if (!Number.isFinite(baseBudget)) continue;
    if (typeof current === 'number') {
      if (current > baseBudget) {
        violations.push(
          `${budgetFile}: budget for ${file} was raised from ${baseBudget} to ${current};`
            + ' budgets may only go down',
        );
      }
      continue;
    }
    // Dropping an entry lifts that file's budget to infinity, and a file now
    // under UNREGISTERED_FILE_LIMIT would not be caught by the unbudgeted
    // check either. Removing the entry for a file that is genuinely gone is
    // the legitimate case, so the file still being present is what separates
    // the two. Presence is read from disk rather than from `measured`, because
    // a narrowed --root never measures the file and would otherwise let a
    // partial update quietly shrink the manifest.
    if (!measured.has(file) && !fs.existsSync(file)) continue;
    const floor = measured.has(file) ? Math.min(baseBudget, measured.get(file)) : baseBudget;
    violations.push(
      `${budgetFile}: budget for ${file} was removed while the file still exists;`
        + ` restore the entry at ${floor} or lower`,
    );
  }
  return violations;
}

// Reading arbitrary JavaScript with regular expressions kept producing both
// misses and — worse — false failures on valid code: a block comment between
// specifiers, a regex literal holding a backtick, an attribute clause ended by
// ASI. Each fix grew the patterns and opened another hole.
//
// So the scan no longer tries to find imports anywhere in a file. It reads only
// the leading run of imports at the top, stopping at the first line that is not
// blank, a line comment, or an import statement. A template literal, a regex,
// or a commented-out import cannot appear in that run, which removes the whole
// class of context-tracking bugs rather than patching them one at a time.
//
// The cost is that an import placed after other code is not checked. That is a
// miss, never a false failure, and this repository puts imports at the top.

// Strips comments from one line while carrying block-comment state across
// lines. String literals are preserved, since the `from '...'` clause has to
// survive for the end test.
function stripCommentsStateful(line, state) {
  let code = '';
  for (let index = 0; index < line.length; index += 1) {
    if (state.blockComment) {
      if (line.slice(index, index + 2) === '*/') {
        state.blockComment = false;
        index += 1;
      }
      continue;
    }
    const character = line[index];
    if (character === "'" || character === '"' || character === '`') {
      code += character;
      index += 1;
      while (index < line.length && line[index] !== character) {
        if (line[index] === '\\') {
          code += line[index];
          index += 1;
        }
        code += line[index];
        index += 1;
      }
      if (index < line.length) code += line[index];
      continue;
    }
    const pair = line.slice(index, index + 2);
    if (pair === '//') break;
    if (pair === '/*') {
      state.blockComment = true;
      index += 1;
      code += ' ';
      continue;
    }
    code += character;
  }
  return code;
}

const IMPORT_FROM_CLAUSE = /\bfrom\s+['"][^'"]+['"]/;
const IMPORT_SIDE_EFFECT = /^\s*import\s+['"][^'"]+['"]/;

// Returns the line a statement ends on, or -1. A statement closes at a
// semicolon outside braces, or — when the source relies on ASI — at the end of
// the line where its `from` clause sits and every brace is balanced, which is
// what keeps a multi-line attribute clause open.
function statementEnd(lines, start) {
  const state = { blockComment: false };
  let depth = 0;
  let tail = false;
  for (let index = start; index < lines.length; index += 1) {
    const code = stripCommentsStateful(lines[index], state);
    for (let position = 0; position < code.length; position += 1) {
      const character = code[position];
      if (character === "'" || character === '"' || character === '`') {
        position += 1;
        while (position < code.length && code[position] !== character) {
          if (code[position] === '\\') position += 1;
          position += 1;
        }
        continue;
      }
      if (character === '{') depth += 1;
      else if (character === '}') depth -= 1;
      else if (character === ';' && depth <= 0) {
        // The column matters: code may follow the semicolon on this line, and
        // blanking the whole line would hide a usage and fail valid code.
        return { line: index, column: position + 1, blockComment: state.blockComment };
      }
    }
    if (IMPORT_FROM_CLAUSE.test(code) || IMPORT_SIDE_EFFECT.test(code)) tail = true;
    if (tail && depth <= 0) {
      return { line: index, column: lines[index].length, blockComment: state.blockComment };
    }
  }
  return null;
}

// The leading run of import statements. Anything else ends the run.
function importStatements(lines) {
  const statements = [];
  let index = lines[0] && lines[0].startsWith('#!') ? 1 : 0;
  while (index < lines.length) {
    const trimmed = lines[index].trim();
    if (trimmed === '' || trimmed.startsWith('//')) {
      index += 1;
      continue;
    }
    if (!/^\s*import\s/.test(lines[index])) break;
    const end = statementEnd(lines, index);
    if (end === null) break;
    statements.push({ start: index, end: end.line, endColumn: end.column });
    // A statement that ends with a block comment still open leaves everything
    // after it as comment text. Reading an `import` line out of that text would
    // fail the lint over a name nobody imported, so the run stops here.
    if (end.blockComment) break;
    index = end.line + 1;
  }
  return statements;
}

// Identifiers are not ASCII-only in JavaScript, and `$` is legal too. Matching
// `\\w` alone would skip a `café` or `이름` binding without a word of warning.
const IDENTIFIER = '[\\p{ID_Start}$_][\\p{ID_Continue}$]*';

// The local names a statement binds. For `x as y` the binding is `y`, which is
// the name the rest of the file has to use.
function importBindings(text) {
  const commentState = { blockComment: false };
  const withoutComments = text
    .split('\n')
    .map((line) => stripCommentsStateful(line, commentState))
    .join('\n');
  // Specifiers live before the `from` clause. Anything after it is the module
  // path and possibly an attribute clause, whose braces would otherwise be
  // read as a specifier list.
  const fromClause = withoutComments.match(/\bfrom\s+['"]/);
  const head = fromClause ? withoutComments.slice(0, fromClause.index) : withoutComments;
  const names = [];
  const braced = head.match(/\{([\s\S]*?)\}/);
  if (braced) {
    for (const part of braced[1].split(',')) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const match = trimmed.match(new RegExp(`(?:${IDENTIFIER})\\s+as\\s+(${IDENTIFIER})$`, 'u'))
        || trimmed.match(new RegExp(`^(${IDENTIFIER})$`, 'u'));
      if (match) names.push(match[1]);
    }
  }
  const namespace = head.match(new RegExp(`\\*\\s+as\\s+(${IDENTIFIER})`, 'u'));
  if (namespace) names.push(namespace[1]);
  // `head` already stops before the `from` clause, so a default binding is
  // followed by a comma or nothing at all.
  const defaultBinding = head
    .replace(/^\s*import\s+/, '')
    .match(new RegExp(`^(${IDENTIFIER})\\s*(?:,|$)`, 'u'));
  if (defaultBinding) names.push(defaultBinding[1]);
  return names;
}

// An import nobody calls is dead weight that also misleads: it suggests the
// file still owns a responsibility that moved elsewhere. This has shown up
// three times during the core decomposition, always as a leftover of code that
// was extracted, so it is checked rather than caught by review.
//
// Usage is a word-boundary match against the file with its import statements
// removed. A name mentioned only in a comment or string therefore counts as
// used — deliberately, since the cost of a false failure here is much higher
// than the cost of missing one dead import.
function unusedImportErrors(file, lines) {
  const statements = importStatements(lines);
  // Blank out exactly the span each statement occupies, so anything sharing its
  // last line stays in the body and still counts as a usage.
  const remaining = [...lines];
  for (const statement of statements) {
    for (let index = statement.start; index < statement.end; index += 1) remaining[index] = '';
    const lastLine = remaining[statement.end];
    remaining[statement.end] = lastLine.slice(statement.endColumn);
  }
  const body = remaining.join('\n');
  const errors = [];
  for (const statement of statements) {
    const text = lines.slice(statement.start, statement.end + 1).join('\n');
    for (const name of importBindings(text)) {
      // `\b` does not hold at a `$` boundary and `$` is a regex metacharacter,
      // so the boundary is spelled out and the name escaped.
      const escaped = name.replace(/\$/g, '\\$');
      if (!new RegExp(`(?<![\\p{ID_Continue}$])${escaped}(?![\\p{ID_Continue}$])`, 'u').test(body)) {
        errors.push(`${file}:${statement.start + 1}: unused import ${name}`);
      }
    }
  }
  return errors;
}

const options = parseArguments(process.argv.slice(2));
const defaultNote = [
  'Ratchet budgets in lines. Budgets may only go down.',
  "Run 'node scripts/lint-source.js --update-budgets' after shrinking a file.",
].join(' ');
const existingNote = fs.existsSync(options.budgetFile)
  ? JSON.parse(fs.readFileSync(options.budgetFile, 'utf8')).note
  : null;
const budgets = readBudgets(options.budgetFile);
const files = options.roots.flatMap(javascriptFiles).sort();
// A narrower scan than the default cannot see every budgeted file, so entries
// outside it must be carried over rather than treated as deleted.
const fullScope = [...options.roots].sort().join(',') === [...defaultRoots].sort().join(',');

// Roots are already canonical here, so this is a plain prefix test. A root of
// the working directory itself owns every measured file.
function underRoot(file, root) {
  if (root === '.') return true;
  return file === root || file.startsWith(`${root}/`);
}

// A budget entry can only be judged as an orphan when the scan could actually
// have seen it. Two cases make it unseeable, and both preserve the entry rather
// than deleting it:
//   - its root directory is absent entirely (the published npm package ships no
//     test/ directory, so every test budget would look orphaned);
//   - a narrowed --root put it outside the scanned scope.
// The test is deliberately the root directory, not the file: a file missing from
// a root that *is* present is a genuine orphan and must keep failing.
function budgetUnreachable(file) {
  const owningRoot = options.roots.find((root) => underRoot(file, root));
  if (owningRoot === undefined) return !fullScope;
  return !fs.existsSync(owningRoot);
}

const measured = new Map();
// Syntax and formatting problems are the file's own fault and must block even
// `--update-budgets`. Budget problems are exactly what an update is meant to
// resolve, so they are collected separately.
const sourceErrors = [];
const budgetErrors = [];

for (const file of files) {
  const source = fs.readFileSync(file, 'utf8');
  const lines = source.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    if (/\s+$/.test(lines[index])) sourceErrors.push(`${file}:${index + 1}: trailing whitespace`);
    if (lines[index].includes('\t')) sourceErrors.push(`${file}:${index + 1}: tab character`);
  }
  const syntax = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (syntax.status !== 0) sourceErrors.push(`${file}: syntax check failed\n${syntax.stderr.trim()}`);
  // Only meaningful once the file parses; a syntax error makes the line scan
  // guesswork.
  if (syntax.status === 0) sourceErrors.push(...unusedImportErrors(file, lines));

  const actual = countLines(source);
  measured.set(file, actual);
  const budget = budgets[file];
  if (budget === undefined) {
    if (actual > UNREGISTERED_FILE_LIMIT) {
      budgetErrors.push(
        `${file}: ${actual} lines is unbudgeted; add "${file}": ${actual} to ${options.budgetFile}`,
      );
    }
    continue;
  }
  if (actual > budget) {
    budgetErrors.push(`${file}: ${actual} lines exceeds the architecture budget ${budget}`);
  } else if (budget - actual >= RATCHET_SLACK_LINES) {
    budgetErrors.push(
      `${file}: ${actual} lines is ${budget - actual} under the budget ${budget};`
        + ` tighten the budget to ${actual} in ${options.budgetFile}`,
    );
  }
}

for (const file of Object.keys(budgets)) {
  if (!measured.has(file) && !budgetUnreachable(file)) {
    budgetErrors.push(
      `${options.budgetFile}: ${file} is budgeted but was not found; remove the entry`,
    );
  }
}

if (options.updateBudgets) {
  if (sourceErrors.length) {
    console.error(sourceErrors.join('\n'));
    console.error('Refusing to update budgets while the source lint fails.');
    process.exit(1);
  }
  const next = {};
  const updateErrors = [];
  for (const [file, budget] of Object.entries(budgets)) {
    if (!measured.has(file)) {
      // An unreachable entry is carried over untouched. A genuine orphan is the
      // same failure the ordinary lint reports, and an update must not launder
      // it away: the entry is kept so the rejected run leaves the file intact.
      next[file] = budget;
      if (!budgetUnreachable(file)) {
        updateErrors.push(
          `${options.budgetFile}: ${file} is budgeted but was not found;`
            + ' remove the entry yourself, --update-budgets will not drop it for you',
        );
      }
      continue;
    }
    const actual = measured.get(file);
    if (actual > budget) {
      updateErrors.push(
        `${file}: ${actual} lines exceeds the recorded budget ${budget};`
          + ' --update-budgets only tightens budgets, it can never raise one',
      );
      continue;
    }
    next[file] = actual;
  }
  for (const [file, actual] of measured) {
    const isNewEntry = budgets[file] === undefined;
    if (isNewEntry && actual > UNREGISTERED_FILE_LIMIT) next[file] = actual;
  }
  // The manifest about to be written is held to the same baseline as the one
  // the ordinary lint reads. Without this, an entry hand-raised above the
  // baseline could be rewritten to a still-too-high line count and exit 0,
  // succeeding here while `npm run lint` fails.
  if (options.baseCheck) {
    const base = readBaseBudgets(options.budgetFile);
    if (base.unresolved) {
      updateErrors.push(unresolvedBaseError(base.unresolved, options.budgetFile));
    } else if (base.budgets) {
      updateErrors.push(
        ...baseBudgetViolations(base.budgets, next, measured, options.budgetFile),
      );
    }
  }
  if (updateErrors.length) {
    console.error(updateErrors.join('\n'));
    process.exit(1);
  }
  writeBudgets(options.budgetFile, next, existingNote || defaultNote);
  console.log(`Updated ${options.budgetFile} for ${Object.keys(next).length} files.`);
  process.exit(0);
}

if (options.baseCheck) {
  const base = readBaseBudgets(options.budgetFile);
  if (base.unresolved) {
    budgetErrors.push(unresolvedBaseError(base.unresolved, options.budgetFile));
  } else if (base.budgets) {
    budgetErrors.push(...baseBudgetViolations(base.budgets, budgets, measured, options.budgetFile));
  }
}

const errors = [...sourceErrors, ...budgetErrors];
if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}
console.log(`Source lint passed for ${files.length} JavaScript files.`);
