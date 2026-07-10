#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { searchMemories } from '../src/retrieval/search.js';
import { ContextForgeStore } from '../src/storage/sqlite.js';

function parseArgs(argv) {
  const options = {
    sizes: [100, 1000, 10000, 100000],
    iterations: 10,
    vectors: false,
    vectorMax: 10000,
  };
  for (let index = 2; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--vectors') {
      options.vectors = true;
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${token} requires a value.`);
    if (token === '--sizes') options.sizes = value.split(',').map(Number);
    else if (token === '--iterations') options.iterations = Number(value);
    else if (token === '--vector-max') options.vectorMax = Number(value);
    else throw new Error(`Unknown benchmark option: ${token}`);
    index += 1;
  }
  for (const [name, values] of [
    ['sizes', options.sizes],
    ['iterations', [options.iterations]],
    ['vectorMax', [options.vectorMax]],
  ]) {
    if (values.some((value) => !Number.isInteger(value) || value <= 0)) {
      throw new Error(`${name} must contain positive integers.`);
    }
  }
  return options;
}

function percentile(values, quantile) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)];
}

function summarize(samples, diagnostics) {
  return {
    p50Ms: Number(percentile(samples, 0.5).toFixed(3)),
    p95Ms: Number(percentile(samples, 0.95).toFixed(3)),
    scannedRows: diagnostics?.scannedRows ?? 0,
    candidateRows: diagnostics?.candidateRows ?? 0,
    returnedRows: diagnostics?.returnedRows ?? 0,
    sources: diagnostics?.sources || null,
  };
}

function seedStore(store, size, { vectors }) {
  const scopeType = 'repo';
  const scopeKey = `benchmark-${size}`;
  const timestamp = '2026-01-01T00:00:00.000Z';
  const insertMemory = store.db.prepare(`
    INSERT INTO memories (
      id, scope_type, scope_key, memory_key, category, content, tags_json,
      importance, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'note', ?, ?, ?, 'active', ?, ?)
  `);
  const insertFts = store.db.prepare(`
    INSERT INTO memory_fts (
      memory_id, scope_type, scope_key, memory_key, category, content, tags
    ) VALUES (?, ?, ?, ?, 'note', ?, ?)
  `);
  store.withTransaction(() => {
    for (let index = 0; index < size; index += 1) {
      const id = `memory-${size}-${index}`;
      const target = index === Math.floor(size / 2);
      const key = target ? `retrievaltarget-${size}` : `synthetic-memory-${String(index).padStart(6, '0')}`;
      const content = target
        ? 'Canonical retrieval target 한국어 검색 POST /v0/dbInfo SQLITE_BUSY semantic-vector-anchor.'
        : `Synthetic filler memory ${index} with bounded indexed lookup evidence.`;
      const tags = target ? ['benchmark', '장애복구'] : ['synthetic'];
      const importance = target ? 10 : index % 10;
      insertMemory.run(id, scopeType, scopeKey, key, content, JSON.stringify(tags), importance, timestamp, timestamp);
      insertFts.run(id, scopeType, scopeKey, key, content, tags.join(' '));
    }
  });

  if (vectors) {
    store.withTransaction(() => {
      for (let index = 0; index < size; index += 1) {
        const target = index === Math.floor(size / 2);
        store.upsertEmbedding({
          sourceType: 'memory',
          recordId: `memory-${size}-${index}`,
          scopeType,
          scopeKey,
          model: 'benchmark-3d',
          dimensions: 3,
          contentHash: `benchmark-${size}-${index}`,
          embedding: target ? [1, 0, 0] : [0, 1, index % 2],
        });
      }
    });
  }
  return { scopeType, scopeKey };
}

function measure(store, scope, options, iterations) {
  const samples = [];
  let diagnostics = null;
  let firstKey = null;
  for (let iteration = 0; iteration < iterations + 1; iteration += 1) {
    const startedAt = performance.now();
    const results = searchMemories(store, { ...scope, limit: 10, ...options });
    const elapsedMs = performance.now() - startedAt;
    if (iteration > 0) samples.push(elapsedMs);
    diagnostics = results[0]?.retrieval?.diagnostics || diagnostics;
    firstKey = results[0]?.memory?.key || results[0]?.checkpoint?.id || null;
  }
  return { firstKey, ...summarize(samples, diagnostics) };
}

function runSize(size, options) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `contextforge-retrieval-${size}-`));
  const store = new ContextForgeStore({ dataDir });
  const vectors = options.vectors && size <= options.vectorMax;
  try {
    const scope = seedStore(store, size, { vectors });
    const modes = {
      ftsPrefix: measure(store, scope, { query: 'canon retriev' }, options.iterations),
      koreanFts: measure(store, scope, { query: '한국어 검색' }, options.iterations),
      pathErrorFts: measure(store, scope, { query: '/v0/dbInfo SQLITE_BUSY' }, options.iterations),
      legacySubstring: measure(
        store,
        scope,
        { query: 'trievaltar', legacyFullScan: true },
        options.iterations,
      ),
    };
    if (vectors) {
      modes.vector = measure(store, scope, { query: 'unindexed-neighbor', queryEmbedding: [1, 0, 0] }, options.iterations);
      modes.hybrid = measure(store, scope, { query: 'retrieval target', queryEmbedding: [1, 0, 0] }, options.iterations);
    }
    return { size, vectors, modes };
  } finally {
    store.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

const options = parseArgs(process.argv);
const startedAt = new Date().toISOString();
const results = options.sizes.map((size) => runSize(size, options));
console.log(
  JSON.stringify(
    {
      kind: 'contextforge_retrieval_benchmark',
      startedAt,
      options,
      scannedRowsDefinition: 'Rows materialized from bounded index queries and optional legacy full scan.',
      results,
    },
    null,
    2,
  ),
);
