#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MCP_TOOL_PROFILES,
  createContextForgeMcpServer,
  getContextForgeMcpSurfaceInfo,
} from '../src/mcp.js';

// The MCP initialization surface is a ratchet, not a ceiling. Every byte of
// instructions and tool schema is spent from the agent's context before it does
// any work, so the surface may never grow past what is recorded, and once a
// real reduction lands the record must be tightened so the reclaimed room
// cannot be spent again unnoticed.
//
// Every profile is tracked rather than only the default one. Before this file
// existed a single hard-coded cap guarded `agent-core`, and between the July
// baseline and August the unguarded profiles grew by roughly a fifth each —
// review 9,793 -> 11,701, operator 14,203 -> 16,842, all 15,478 -> 18,116 —
// with nothing to notice.

const budgetFile = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'mcp-surface-budgets.json',
);

// toolCount is pinned alongside the byte counts because a profile silently
// gaining a tool is the change most worth catching.
const BUDGET_FIELDS = ['toolCount', 'instructionsBytes', 'toolSchemaBytes', 'estimatedInitialTokens'];

const DEFAULT_SLACK_RATIO = 0.05;

export function readSurfaceBudgets(file = budgetFile) {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  const profiles = parsed && typeof parsed === 'object' ? parsed.profiles : null;
  if (!profiles || typeof profiles !== 'object') {
    throw new Error(`${file}: expected an object with a "profiles" map`);
  }
  for (const [profile, budget] of Object.entries(profiles)) {
    for (const field of BUDGET_FIELDS) {
      const value = budget?.[field];
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
        throw new Error(
          `${file}: ${profile}.${field} must be a non-negative integer, got ${JSON.stringify(value)}`,
        );
      }
    }
  }
  const slackRatio = typeof parsed.slackRatio === 'number' ? parsed.slackRatio : DEFAULT_SLACK_RATIO;
  return { profiles, slackRatio, note: parsed.note || '' };
}

export async function measureSurfaces() {
  const measurements = {};
  for (const profile of Object.keys(MCP_TOOL_PROFILES)) {
    const server = createContextForgeMcpServer({ profile });
    try {
      const surface = getContextForgeMcpSurfaceInfo(server);
      const measured = {};
      for (const field of BUDGET_FIELDS) measured[field] = surface[field];
      measurements[profile] = measured;
    } finally {
      await server.close().catch(() => {});
    }
  }
  return measurements;
}

export function surfaceBudgetViolations(budgets, measurements) {
  const violations = [];
  for (const [profile, budget] of Object.entries(budgets.profiles)) {
    const measured = measurements[profile];
    if (!measured) {
      violations.push(`${profile}: budgeted but not measured; remove the entry or restore the profile`);
      continue;
    }
    for (const field of BUDGET_FIELDS) {
      const actual = measured[field];
      const allowed = budget[field];
      if (actual > allowed) {
        violations.push(
          `${profile}.${field}: ${actual} exceeds the recorded budget ${allowed};`
            + " raise it with 'node scripts/check-mcp-surface.js --update' and say why in the commit",
        );
        continue;
      }
      // Only the headline token estimate demands tightening. Byte counts drift
      // with SDK releases, and asking for a manifest update on every drift
      // would turn the ratchet into churn.
      if (field !== 'estimatedInitialTokens') continue;
      const slack = Math.floor(allowed * budgets.slackRatio);
      if (allowed - actual > slack) {
        violations.push(
          `${profile}.${field}: ${actual} is ${allowed - actual} under the budget ${allowed};`
            + " tighten it with 'node scripts/check-mcp-surface.js --update'",
        );
      }
    }
  }
  for (const profile of Object.keys(measurements)) {
    if (!budgets.profiles[profile]) {
      violations.push(`${profile}: measured but has no budget entry; add one`);
    }
  }
  return violations;
}

export function writeSurfaceBudgets(measurements, budgets, file = budgetFile) {
  const profiles = {};
  for (const profile of Object.keys(measurements).sort()) profiles[profile] = measurements[profile];
  const payload = { note: budgets.note, slackRatio: budgets.slackRatio, profiles };
  fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file:').href) {
  const update = process.argv.includes('--update');
  const budgets = readSurfaceBudgets();
  const measurements = await measureSurfaces();
  if (update) {
    writeSurfaceBudgets(measurements, budgets);
    console.log(`Updated ${budgetFile} for ${Object.keys(measurements).length} profiles.`);
  } else {
    const violations = surfaceBudgetViolations(budgets, measurements);
    if (violations.length) {
      console.error(violations.join('\n'));
      process.exitCode = 1;
    } else {
      console.log(`MCP surface budgets hold for ${Object.keys(measurements).length} profiles.`);
    }
  }
}
