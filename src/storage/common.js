// Row (de)serialization leaves shared by the SQLite store and the candidate
// lifecycle statements. Both modules had identical private copies. Nothing here
// may import another ContextForge module.

export function nowIso() {
  return new Date().toISOString();
}

// Column writer: `undefined`/`null` become the caller's fallback before
// stringifying, so a column never receives the literal string "undefined".
export function json(value, fallback) {
  return JSON.stringify(value ?? fallback);
}

// Column reader: an absent or unparseable column yields the fallback rather
// than throwing, so one bad row cannot take down a read path.
export function parseJson(value, fallback) {
  if (value == null || value === '') {
    return fallback;
  }
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}
