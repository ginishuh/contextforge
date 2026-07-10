import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createContextForge } from '../core.js';
import { evaluateRetrievalFixture } from './retrieval.js';

function normalized(value) {
  return String(value || '').toLowerCase();
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function metricValue(report, metricPath) {
  return metricPath.split('.').reduce((value, key) => value?.[key], report);
}

function thresholdChecks(report, baseline) {
  const checks = [];
  for (const [metric, minimum] of Object.entries(baseline.minimum || {})) {
    const actual = Number(metricValue(report, metric));
    checks.push({ metric, actual, minimum: Number(minimum), passed: Number.isFinite(actual) && actual >= minimum });
  }
  for (const [metric, maximum] of Object.entries(baseline.maximum || {})) {
    const actual = Number(metricValue(report, metric));
    checks.push({ metric, actual, maximum: Number(maximum), passed: Number.isFinite(actual) && actual <= maximum });
  }
  return checks;
}

function distillationDetail(item) {
  const outputText = normalized(JSON.stringify(item.output || {}));
  const evidenceById = new Map((item.rawEvidence || []).map((evidence) => [evidence.id, normalized(evidence.content)]));
  const categories = Object.fromEntries(
    Object.entries(item.expectedFacts || {}).map(([category, facts]) => {
      const matched = facts.filter((fact) => outputText.includes(normalized(fact)));
      return [
        category,
        {
          expected: facts.length,
          matched: matched.length,
          missing: facts.filter((fact) => !matched.includes(fact)),
        },
      ];
    }),
  );
  const claims = (item.output?.claims || []).map((claim) => {
    const sourceText = (claim.sources || []).map((sourceId) => evidenceById.get(sourceId) || '').join('\n');
    const missingSupport = (claim.requiredEvidenceTerms || []).filter(
      (term) => !sourceText.includes(normalized(term)),
    );
    return {
      text: claim.text,
      sources: claim.sources || [],
      supported: (claim.sources || []).length > 0 && missingSupport.length === 0,
      missingSupport,
    };
  });
  const forbiddenClaims = (item.forbiddenClaims || []).filter((claim) => outputText.includes(normalized(claim)));
  const requiredWarnings = item.requiredLiveStateWarnings || [];
  const warningText = normalized((item.output?.liveStateWarnings || []).join('\n'));
  const missingWarnings = requiredWarnings.filter((warning) => !warningText.includes(normalized(warning)));
  const requiredHooks = item.requiredRetrievalHooks || [];
  const hookText = normalized((item.output?.retrievalHooks || []).join('\n'));
  const missingHooks = requiredHooks.filter((hook) => !hookText.includes(normalized(hook)));
  const expectedFacts = Object.values(categories).reduce((sum, category) => sum + category.expected, 0);
  const matchedFacts = Object.values(categories).reduce((sum, category) => sum + category.matched, 0);
  const unsupportedClaims = claims.filter((claim) => !claim.supported);
  return {
    id: item.id,
    passed:
      matchedFacts === expectedFacts &&
      unsupportedClaims.length === 0 &&
      forbiddenClaims.length === 0 &&
      missingWarnings.length === 0 &&
      missingHooks.length === 0,
    categories,
    expectedFacts,
    matchedFacts,
    preservationRate: expectedFacts ? matchedFacts / expectedFacts : 1,
    claims,
    unsupportedClaims,
    forbiddenClaims,
    missingWarnings,
    missingHooks,
    inputTruncated: Boolean(item.inputTruncated),
  };
}

async function executeDistillationCase(item) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'contextforge-quality-distill-'));
  const logicalToStoredSource = new Map();
  const providerOutput = item.output || {};
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_STORAGE_MODE: 'local',
      CONTEXTFORGE_DISTILL_PROVIDER: 'quality_fixture',
      CONTEXTFORGE_EMBEDDINGS_PROVIDER: 'none',
      CONTEXTFORGE_AUTO_PROMOTE_AUDIT_ENABLED: 'false',
    },
    cwd: process.cwd(),
    distillProviders: {
      quality_fixture: async ({ rawEvents }) => ({
        summaryShort: providerOutput.summaryShort,
        summaryText: providerOutput.summaryText,
        decisions: providerOutput.decisions || [],
        todos: providerOutput.todos || [],
        openQuestions: providerOutput.openQuestions || [],
        memoryCandidates: [],
        sourceEventCount: rawEvents.length,
        provider: 'quality_fixture',
        metadata: {
          synthetic: true,
          qualityEval: {
            liveStateWarnings: providerOutput.liveStateWarnings || [],
            retrievalHooks: providerOutput.retrievalHooks || [],
            claims: (providerOutput.claims || []).map((claim) => ({
              ...claim,
              sources: (claim.sources || []).map((source) => logicalToStoredSource.get(source) || source),
            })),
          },
        },
      }),
    },
  });
  try {
    const scope = { scope: 'repo', scopeKey: `quality-distill-${item.id}` };
    const sessionId = `quality-distill:${item.id}`;
    const storedEvidence = [];
    for (const evidence of item.rawEvidence || []) {
      const stored = app.appendRaw({
        ...scope,
        sessionId,
        role: 'assistant',
        content: evidence.content,
        metadata: { synthetic: true, fixtureEvidenceId: evidence.id },
      });
      logicalToStoredSource.set(evidence.id, stored.id);
      storedEvidence.push({ id: stored.id, content: stored.content });
    }
    const checkpoint = await app.distillCheckpoint({ ...scope, sessionId });
    const quality = checkpoint.metadata?.providerMetadata?.qualityEval || {};
    return distillationDetail({
      ...item,
      rawEvidence: storedEvidence,
      output: {
        summaryShort: checkpoint.summaryShort,
        summaryText: checkpoint.summaryText,
        decisions: checkpoint.decisions,
        todos: checkpoint.todos,
        openQuestions: checkpoint.openQuestions,
        liveStateWarnings: quality.liveStateWarnings || [],
        retrievalHooks: quality.retrievalHooks || [],
        claims: quality.claims || [],
      },
    });
  } finally {
    app.close?.();
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function evaluateDistillationCases(cases = [], negativeCases = []) {
  const details = [];
  for (const item of cases) details.push(await executeDistillationCase(item));
  const sensitivityDetails = [];
  for (const item of negativeCases) {
    const detail = await executeDistillationCase(item);
    sensitivityDetails.push({ ...detail, detected: !detail.passed });
  }
  const claims = details.flatMap((detail) => detail.claims);
  const expectedFacts = details.reduce((sum, detail) => sum + detail.expectedFacts, 0);
  const matchedFacts = details.reduce((sum, detail) => sum + detail.matchedFacts, 0);
  return {
    cases: details.length,
    passed: details.filter((detail) => detail.passed).length,
    failed:
      details.filter((detail) => !detail.passed).length +
      sensitivityDetails.filter((detail) => !detail.detected).length,
    metrics: {
      preservationRate: expectedFacts ? matchedFacts / expectedFacts : 1,
      supportedClaimRate: claims.length ? claims.filter((claim) => claim.supported).length / claims.length : 1,
      hallucinationCount: details.reduce(
        (sum, detail) => sum + detail.unsupportedClaims.length + detail.forbiddenClaims.length,
        0,
      ),
      liveStateWarningAccuracy: average(details.map((detail) => (detail.missingWarnings.length ? 0 : 1))),
      retrievalHookPreservation: average(details.map((detail) => (detail.missingHooks.length ? 0 : 1))),
      sensitivityDetectionRate: average(sensitivityDetails.map((detail) => (detail.detected ? 1 : 0))),
    },
    details,
    sensitivity: {
      cases: sensitivityDetails.length,
      detected: sensitivityDetails.filter((detail) => detail.detected).length,
      missed: sensitivityDetails.filter((detail) => !detail.detected).length,
      details: sensitivityDetails,
    },
  };
}

function normalizedClassification(value) {
  return value == null ? null : String(value).trim().toLowerCase().replace(/[-\s]+/g, '_');
}

async function executeCandidateCase(item) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'contextforge-quality-candidate-'));
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_STORAGE_MODE: 'local',
      CONTEXTFORGE_DISTILL_PROVIDER: 'quality_fixture',
      CONTEXTFORGE_EMBEDDINGS_PROVIDER: 'none',
      CONTEXTFORGE_AUTO_PROMOTE_AUDIT_ENABLED: 'false',
    },
    cwd: process.cwd(),
    distillProviders: {
      quality_fixture: async ({ rawEvents }) => ({
        summaryShort: `Synthetic candidate case ${item.id}.`,
        summaryText: `Synthetic candidate quality evaluation for ${item.id}.`,
        decisions: [],
        todos: [],
        openQuestions: [],
        memoryCandidates: [{ ...item.candidate, sourceEventIds: rawEvents.map((event) => event.id) }],
        sourceEventCount: rawEvents.length,
        provider: 'quality_fixture',
        metadata: { synthetic: true },
      }),
    },
  });
  try {
    const scope = { scope: 'repo', scopeKey: `quality-candidate-${item.id}` };
    const sessionId = `quality-candidate:${item.id}`;
    for (const memory of item.existingMemories || []) app.remember({ ...scope, ...memory });
    const evidenceCount = Math.max(1, Number(item.evidenceCount || 1));
    for (let index = 0; index < evidenceCount; index += 1) {
      app.appendRaw({
        ...scope,
        sessionId,
        role: 'assistant',
        content: `${item.evidence || item.candidate?.content} [synthetic evidence ${index + 1}]`,
        metadata: { synthetic: true },
      });
    }
    await app.distillCheckpoint({ ...scope, sessionId });
    const indexed = app.listMemoryCandidates({ ...scope, sessionId, status: 'pending' });
    const candidate = indexed.find((entry) => entry.candidate?.key === item.candidate?.key);
    const suggestions = await app.suggestMemoryPromotions({
      ...scope,
      sessionId,
      trigger: 'manual_closeout',
      createUpdateCandidates: true,
      scanLimit: 10,
      limit: 3,
    });
    const proposal = suggestions.proposals.find((entry) => entry.candidateId === candidate?.id);
    const update = suggestions.updateCandidates.find((entry) => entry.source?.candidateId === candidate?.id);
    const skipped = suggestions.skipped.find((entry) => entry.candidateId === candidate?.id);
    const actualClassification = normalizedClassification(
      proposal?.promotionAssessment?.classification ||
        skipped?.promotionAssessment?.classification ||
        update?.promotionAssessment?.classification ||
        (proposal ? 'new' : null),
    );
    const actualAction = proposal
      ? 'promote'
      : update
        ? 'update'
        : actualClassification === 'duplicate'
          ? 'merge'
          : 'reject';
    const actualRecurring = new Set(candidate?.candidate?.sourceEventIds || []).size >= 2;
    return {
      id: item.id,
      type: item.type,
      candidateId: candidate?.id || null,
      expectedAction: item.expectedAction,
      actualAction,
      expectedClassification: normalizedClassification(item.expectedClassification),
      actualClassification,
      expectedRecurring: item.expectedRecurring,
      actualRecurring,
      evidenceCount,
      warningCodes: (skipped?.warnings || []).map((warning) => warning.code),
    };
  } finally {
    app.close?.();
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function evaluateTrustOrderingCases(cases = []) {
  if (!cases.length) return [];
  const dataDir = await mkdtemp(path.join(tmpdir(), 'contextforge-quality-trust-'));
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_STORAGE_MODE: 'local',
      CONTEXTFORGE_DISTILL_PROVIDER: 'quality_trust_fixture',
      CONTEXTFORGE_EMBEDDINGS_PROVIDER: 'none',
      CONTEXTFORGE_AUTO_PROMOTE_AUDIT_ENABLED: 'false',
    },
    cwd: process.cwd(),
    distillProviders: {
      quality_trust_fixture: async () => ({
        summaryShort: 'Synthetic stale mutable-state handoff.',
        summaryText: 'The synthetic deployment state was observed previously and requires live verification.',
        decisions: [],
        todos: ['Verify the deployment against live sources.'],
        openQuestions: [],
        structured: {
          schemaVersion: 'contextforge.structured_checkpoint.v1',
          work: {
            intent: 'Evaluate stale checkpoint safety.',
            status: 'in_progress',
            outcome: 'Mutable state remains unverified.',
          },
          liveState: {
            deploymentStatus: 'healthy-at-observation-time',
            observedAt: '2020-01-01T00:00:00.000Z',
            verificationRequired: true,
            staleReasons: ['deployment status changes after observation'],
            verifyHints: ['check the live readiness endpoint'],
          },
          changes: [],
          verification: [],
          risks: [],
          nextActions: [],
        },
        memoryCandidates: [
          {
            key: 'synthetic-trust-candidate',
            content: 'Unreviewed synthetic trust material.',
            category: 'runbook',
            confidence: 0.9,
            stability: 0.9,
            promotionRecommendation: 'promote',
          },
        ],
        sourceEventCount: 1,
        provider: 'quality_trust_fixture',
        metadata: { synthetic: true },
      }),
    },
  });
  try {
    const scope = { scope: 'repo', scopeKey: 'quality-trust-order' };
    app.remember({
      ...scope,
      key: 'synthetic-durable-trust-rule',
      content: 'Synthetic trust evaluation requires live verification for mutable deployment state.',
      category: 'runbook',
    });
    app.appendRaw({
      ...scope,
      sessionId: 'quality-trust-session',
      role: 'assistant',
      content: 'Synthetic trust evaluation handoff evidence.',
      metadata: { synthetic: true },
    });
    await app.distillCheckpoint({ ...scope, sessionId: 'quality-trust-session' });
    const bootstrap = await app.bootstrapContext({
      ...scope,
      query: 'synthetic trust evaluation live verification mutable deployment state',
      consultReason: 'resume',
      limit: 5,
    });
    const baseOrder = bootstrap.handoff?.trustOrder || [];
    return cases.map((item) => {
      if (item.mode === 'stale_checkpoint_safety') {
        const handoff = bootstrap.handoff?.latestHandoff || {};
        const durable = bootstrap.results?.find((result) => result.key === 'synthetic-durable-trust-rule') || {};
        const warningCodes = (handoff.structuredWarnings || []).map((warning) => warning.code);
        const violations = [];
        if (handoff.trust !== item.expectedCheckpointTrust) violations.push('checkpoint_trust');
        if (handoff.verificationRequired !== true) violations.push('checkpoint_verification_required');
        if (!warningCodes.includes(item.expectedWarningCode)) violations.push('stale_warning');
        if (durable.trust !== item.expectedDurableTrust) violations.push('durable_trust');
        return {
          id: item.id,
          actual: {
            checkpointTrust: handoff.trust || null,
            checkpointVerificationRequired: handoff.verificationRequired === true,
            warningCodes,
            durableTrust: durable.trust || null,
          },
          violations,
          passed: violations.length === 0,
        };
      }
      const sources = item.sources || [];
      const missingTrustTypes = [...new Set(sources.map((source) => source.type))].filter(
        (type) => !baseOrder.includes(type),
      );
      const rank = (source) => {
        const index = baseOrder.indexOf(source.type);
        return index === -1 ? Number.POSITIVE_INFINITY : index;
      };
      const actualOrder = [...sources].sort((left, right) => rank(left) - rank(right)).map((source) => source.id);
      const violations = (item.expectedBefore || [])
        .filter(([higher, lower]) => {
          const higherIndex = actualOrder.indexOf(higher);
          const lowerIndex = actualOrder.indexOf(lower);
          return higherIndex === -1 || lowerIndex === -1 || higherIndex >= lowerIndex;
        })
        .map(([higher, lower]) => ({ higher, lower }));
      return {
        id: item.id,
        baseOrder,
        actualOrder,
        missingTrustTypes,
        violations,
        passed: missingTrustTypes.length === 0 && violations.length === 0,
      };
    });
  } finally {
    app.close?.();
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function evaluateCandidateCases(cases = [], trustOrderingCases = []) {
  const executed = [];
  for (const item of cases) executed.push(await executeCandidateCase(item));
  const details = executed.map((item) => ({
    ...item,
    actionCorrect: item.actualAction === item.expectedAction,
    classificationCorrect:
      item.expectedClassification == null || item.actualClassification === item.expectedClassification,
    preferenceEvidenceCorrect:
      item.type !== 'preference' || Boolean(item.actualRecurring) === Boolean(item.expectedRecurring),
  }));
  const predictedPromotions = details.filter((item) => item.actualAction === 'promote');
  const expectedPromotions = details.filter((item) => item.expectedAction === 'promote');
  const expectedRejections = details.filter((item) => item.expectedAction === 'reject');
  const classificationCases = details.filter((item) => item.expectedClassification != null);
  const trustDetails = await evaluateTrustOrderingCases(trustOrderingCases);
  return {
    cases: details.length,
    passed: details.filter(
      (item) => item.actionCorrect && item.classificationCorrect && item.preferenceEvidenceCorrect,
    ).length,
    failed: details.filter(
      (item) => !item.actionCorrect || !item.classificationCorrect || !item.preferenceEvidenceCorrect,
    ).length,
    metrics: {
      durableCandidatePrecision: predictedPromotions.length
        ? predictedPromotions.filter((item) => item.expectedAction === 'promote').length / predictedPromotions.length
        : 1,
      promotionAcceptanceRate: expectedPromotions.length
        ? expectedPromotions.filter((item) => item.actualAction === 'promote').length / expectedPromotions.length
        : 1,
      rejectionAccuracy: expectedRejections.length
        ? expectedRejections.filter((item) => item.actualAction === 'reject').length / expectedRejections.length
        : 1,
      classificationAccuracy: classificationCases.length
        ? classificationCases.filter((item) => item.classificationCorrect).length / classificationCases.length
        : 1,
      preferenceEvidenceAccuracy: average(
        details.filter((item) => item.type === 'preference').map((item) => (item.preferenceEvidenceCorrect ? 1 : 0)),
      ),
      trustOrderingAccuracy: average(trustDetails.map((item) => (item.passed ? 1 : 0))),
    },
    details,
    trustOrdering: trustDetails,
  };
}

function aggregateRetrieval(reports) {
  const details = reports.flatMap((report) => report.details);
  const judgedDetails = details.filter((detail) => detail.metrics.rankingJudged);
  return {
    fixtures: reports.length,
    queries: details.length,
    passed: details.filter((detail) => detail.passed).length,
    failed: details.filter((detail) => !detail.passed).length,
    metrics: {
      judgedQueries: judgedDetails.length,
      unjudgedQueries: details.length - judgedDetails.length,
      recallAtK: judgedDetails.length ? average(judgedDetails.map((detail) => detail.metrics.recallAtK)) : null,
      mrr: judgedDetails.length ? average(judgedDetails.map((detail) => detail.metrics.reciprocalRank)) : null,
      ndcgAtK: judgedDetails.length ? average(judgedDetails.map((detail) => detail.metrics.ndcgAtK)) : null,
      scopeLeakageCount: details.reduce((sum, detail) => sum + detail.leakedScopes.length, 0),
      forbiddenKeyCount: details.reduce((sum, detail) => sum + detail.leakedKeys.length, 0),
      exactStringRate: average(
        details.map((detail) => {
          const total = detail.matchedExactStrings.length + detail.missingExactStrings.length;
          return total ? detail.matchedExactStrings.length / total : 1;
        }),
      ),
      averageLatencyMs: average(details.map((detail) => detail.durationMs)),
      maxReturned: Math.max(0, ...details.map((detail) => detail.metrics.returned)),
      byLanguage: Object.fromEntries(
        [...new Set(details.map((detail) => detail.language))].map((language) => {
          const matching = details.filter((detail) => detail.language === language);
          const judged = matching.filter((detail) => detail.metrics.rankingJudged);
          return [
            language,
            {
              queries: matching.length,
              judgedQueries: judged.length,
              recallAtK: judged.length ? average(judged.map((detail) => detail.metrics.recallAtK)) : null,
              mrr: judged.length ? average(judged.map((detail) => detail.metrics.reciprocalRank)) : null,
              ndcgAtK: judged.length ? average(judged.map((detail) => detail.metrics.ndcgAtK)) : null,
            },
          ];
        }),
      ),
    },
    reports,
  };
}

async function readJson(file, label) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    throw new Error(`Invalid ${label} ${file}: ${error.message}`);
  }
}

export async function runQualityEval(options = {}) {
  if (!options.fixture) throw new Error('evalQuality requires --fixture <path>.');
  if (!options.baseline) throw new Error('evalQuality requires --baseline <path>.');
  const fixturePath = path.resolve(options.fixture);
  const baselinePath = path.resolve(options.baseline);
  const fixture = await readJson(fixturePath, 'quality eval fixture');
  const baseline = await readJson(baselinePath, 'quality eval baseline');
  const retrievalReports = [];
  for (const relativeFixture of fixture.retrievalFixtures || []) {
    const retrievalFixturePath = path.resolve(path.dirname(fixturePath), relativeFixture);
    const retrievalFixture = await readJson(retrievalFixturePath, 'retrieval eval fixture');
    const dataDir = await mkdtemp(path.join(tmpdir(), 'contextforge-quality-eval-'));
    try {
      retrievalReports.push(await evaluateRetrievalFixture(retrievalFixture, { dataDir }));
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  }
  const report = {
    kind: 'memory_quality_eval',
    fixture: fixture.name || path.basename(fixturePath),
    baseline: baseline.name || path.basename(baselinePath),
    offline: true,
    retrieval: aggregateRetrieval(retrievalReports),
    distillation: await evaluateDistillationCases(
      fixture.distillationCases || [],
      fixture.distillationNegativeCases || [],
    ),
    candidate: await evaluateCandidateCases(fixture.candidateCases || [], fixture.trustOrderingCases || []),
  };
  const checks = thresholdChecks(report, baseline.thresholds || {});
  report.thresholds = { passed: checks.filter((check) => check.passed).length, failed: checks.filter((check) => !check.passed).length, checks };
  report.passed =
    report.retrieval.failed === 0 &&
    report.distillation.failed === 0 &&
    report.candidate.failed === 0 &&
    report.thresholds.failed === 0;
  return report;
}
