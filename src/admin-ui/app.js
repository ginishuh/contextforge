import {
  candidateActionAvailability,
  candidateBulkEligibility,
  candidateRecommendedAction,
  eligibleCandidateIndexes,
} from './candidate_actions.js';

const state = {
  runtime: null,
  db: null,
  scopeKeys: [],
  memories: [],
  candidates: [],
  memoryUpdates: [],
  candidateCursor: null,
  candidateSummary: null,
  candidateAsOf: null,
  runs: [],
  readiness: null,
  metrics: null,
};

const $ = (selector) => document.querySelector(selector);
const tokenInput = $('#token');

function setLoginState(loggedIn, username = '') {
  $('#loginForm').hidden = loggedIn;
  $('#loginStatus').hidden = !loggedIn;
  $('#loginMessage').textContent = loggedIn ? `${username || '관리자'} 로그인됨` : '';
}

async function refreshDashboardRuns() {
  await loadRecentRuns();
}

async function restoreLoginSession() {
  const response = await fetch('/ui/session', { method: 'GET' }).catch(() => null);
  if (!response?.ok) return false;
  const body = await response.json().catch(() => ({}));
  setLoginState(true, body.username || '관리자');
  return true;
}

$('#loginForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const username = form.username.value.trim();
  const response = await fetch('/ui/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username,
      password: form.password.value,
    }),
  });
  form.password.value = '';
  if (!response.ok) {
    $('#connection').textContent = '로그인 실패';
    return;
  }
  setLoginState(true, username);
  await refreshRuntime();
  await refreshDashboardRuns();
});

$('#logoutButton').addEventListener('click', async () => {
  await fetch('/ui/logout', { method: 'POST' }).catch(() => {});
  setLoginState(false);
  $('#connection').textContent = '로그아웃됨';
});

function headers() {
  const token = tokenInput.value.trim();
  return {
    'content-type': 'application/json',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

async function call(method, body = {}) {
  const response = await fetch(`/v0/${method}`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  if (!response.ok) {
    const error = new Error(payload?.error?.message || `${method} failed`);
    error.code = payload?.error?.code;
    error.warnings = payload?.error?.warnings;
    throw error;
  }
  return payload.result;
}

function dl(target, entries) {
  target.innerHTML = entries
    .map(([key, value]) => `<dt>${escapeHtml(key)}</dt><dd>${escapeHtml(value == null ? '' : String(value))}</dd>`)
    .join('');
}

const DISTILL_POLICY_LABELS = {
  minEvents: '최소 이벤트 수',
  minIntervalMs: '최소 시간 간격(ms)',
  charMinIntervalMs: '문자 기준 최소 간격(ms)',
  charThreshold: '문자 수 기준',
  maxEvents: '최대 이벤트 수',
  maxChars: '최대 입력 문자 수',
};

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function table(rows, columns) {
  if (!rows.length) return '<p class="muted">표시할 항목이 없습니다.</p>';
  return `<table><thead><tr>${columns.map((col) => `<th>${escapeHtml(col.label)}</th>`).join('')}</tr></thead><tbody>${rows
    .map((row) => `<tr>${columns.map((col) => `<td>${escapeHtml(col.value(row) ?? '')}</td>`).join('')}</tr>`)
    .join('')}</tbody></table>`;
}

function countLabel(label, value) {
  const count = Array.isArray(value) ? value.length : 0;
  return `${label} ${count}`;
}

function checkpointStructured(checkpoint) {
  return checkpoint?.structured || checkpoint?.metadata?.structured || null;
}

function showDetail(title, content) {
  $('#detail').innerHTML = `<h2>${escapeHtml(title)}</h2><pre>${escapeHtml(JSON.stringify(content, null, 2))}</pre>`;
  $('#detailDialog').showModal();
}

function showDistillDetail(bundle) {
  const checkpoint = bundle.checkpoint;
  const structured = checkpointStructured(checkpoint);
  const work = structured?.work || {};
  const liveState = structured?.liveState || {};
  $('#detail').innerHTML = `<h2>구조화 디스틸</h2>
    <dl>
      <dt>Run</dt><dd>${escapeHtml(bundle.run.id)}</dd>
      <dt>Checkpoint</dt><dd>${escapeHtml(checkpoint?.id || bundle.run.outputMetadata?.checkpointId || '')}</dd>
      <dt>세션</dt><dd>${escapeHtml(bundle.run.sessionId || '')}</dd>
      <dt>프로바이더</dt><dd>${escapeHtml(bundle.run.provider || '')}</dd>
      <dt>상태</dt><dd>${escapeHtml(bundle.run.status || '')}</dd>
      <dt>작업 의도</dt><dd>${escapeHtml(work.intent || '')}</dd>
      <dt>작업 상태</dt><dd>${escapeHtml(work.status || '')}</dd>
      <dt>결과</dt><dd>${escapeHtml(work.outcome || '')}</dd>
      <dt>브랜치</dt><dd>${escapeHtml(liveState.branch || '')}</dd>
      <dt>PR</dt><dd>${escapeHtml(liveState.prNumber || liveState.prUrl || '')}</dd>
      <dt>재검증 필요</dt><dd>${escapeHtml(liveState.verificationRequired == null ? '' : String(liveState.verificationRequired))}</dd>
    </dl>
    <h3>요약</h3>
    <p>${escapeHtml(checkpoint?.summaryText || checkpoint?.summaryShort || '')}</p>
    <h3>structured</h3>
    <pre>${escapeHtml(JSON.stringify(structured, null, 2))}</pre>`;
  $('#detailDialog').showModal();
}

async function refreshRuntime() {
  const [runtime, db, scopeKeys, readiness, metrics] = await Promise.all([
    call('getRuntimeSettings'),
    call('dbInfo'),
    call('listScopeKeys', { limit: 500 }),
    call('readiness'),
    call('operationalMetrics').catch(() => null),
  ]);
  state.runtime = runtime;
  state.db = db;
  state.scopeKeys = scopeKeys;
  state.readiness = readiness;
  state.metrics = metrics;
  $('#connection').textContent = `${db.connection.summary} · ${db.storageMode} · schema ${db.schemaVersion}`;
  const effective = runtime.effective;
  const runtimeRows = [
    ['프로바이더', effective.distillProvider],
    ['모델', effective.distillProvider === 'codex_exec' ? effective.codexExec.model || '(기본값)' : effective.openAiCompatible.model],
  ];
  if (effective.distillProvider === 'codex_exec') {
    runtimeRows.push(
      ['런타임 백엔드', 'Codex exec'],
      ['Codex 명령', effective.codexExec.command || 'codex'],
      ['OpenAI 호환 API', '비활성; API 키 필요 없음'],
    );
  } else if (effective.distillProvider === 'openai_compatible') {
    runtimeRows.push(
      ['런타임 백엔드', 'OpenAI 호환 API'],
      ['Base URL', effective.openAiCompatible.baseUrl],
      ['API 키', effective.openAiCompatible.secretPresent ? '있음' : '없음'],
    );
  } else {
    runtimeRows.push(['런타임 백엔드', 'mock']);
  }
  if (runtime.warnings?.length) {
    runtimeRows.push([
      '보안 경고',
      runtime.warnings.map((warning) => warning.message || warning.code).join('\n'),
    ]);
  }
  runtimeRows.push(['메모리 수', db.tables.memories], ['후보 수', db.tables.memoryCandidates]);
  dl($('#runtimeSummary'), runtimeRows);
  dl(
    $('#policySummary'),
    Object.entries(effective.distillPolicy).map(([key, value]) => [DISTILL_POLICY_LABELS[key] || key, value]),
  );
  const worker = readiness.checks.operationWorker;
  const requiredWorkers = Object.entries(worker.operations || {})
    .filter(([, operationWorker]) => operationWorker.required)
    .map(([operation, operationWorker]) => {
      const age = operationWorker.lastActivityAgeMs == null ? '관측 없음' : `${operationWorker.lastActivityAgeMs}ms 전`;
      return `${operation}: lease ${operationWorker.activeLeases}, ${age}, ${operationWorker.ok ? '정상' : 'stale'}`;
    });
  dl($('#readinessSummary'), [
    ['상태', readiness.ready ? '준비됨' : '점검 필요'],
    ['대기 작업', readiness.checks.operationQueue.queued],
    ['활성 worker lease', worker.activeLeases],
    ['마지막 worker 활동', worker.lastActivityAt || '기록 없음'],
    ['작업 종류별 worker', requiredWorkers.length > 0 ? requiredWorkers.join('\n') : '대기 작업 없음'],
    ['worker 판정', worker.ok ? '정상' : `${worker.reason || '비정상'}: ${(worker.staleOperations || []).join(', ')}`],
  ]);
  const quality = metrics?.memoryLifecycle;
  dl($('#qualitySummary'), quality ? [
    ['후보 → durable 전환율', quality.candidates.conversionRate == null ? '표본 없음' : `${(quality.candidates.conversionRate * 100).toFixed(2)}%`],
    ['7일 내 정정/비활성화', quality.promotionQuality.correctedOrDeactivatedWithin7dRate == null ? '표본 없음' : `${(quality.promotionQuality.correctedOrDeactivatedWithin7dRate * 100).toFixed(2)}%`],
    ['활성 중복률', quality.promotionQuality.duplicateActiveMemoryRate == null ? '표본 없음' : `${(quality.promotionQuality.duplicateActiveMemoryRate * 100).toFixed(2)}%`],
    ['transient 오승격률', quality.promotionQuality.transientPromotionRate == null ? '표본 없음' : `${(quality.promotionQuality.transientPromotionRate * 100).toFixed(2)}%`],
    ['retrieval 사용 memory', `${quality.retrievalUsage.retrievedActiveMemoryCount}/${quality.retrievalUsage.activeMemoryCount}`],
  ] : [['상태', 'operator 권한이 있어야 품질 지표를 볼 수 있습니다.']]);
  fillSettingsForm();
  fillScopeKeySelects();
}

function fillSettingsForm() {
  const form = $('#settingsForm');
  const { effective } = state.runtime;
  form.distillProvider.value = effective.distillProvider;
  form.preset.value = effective.openAiCompatible.preset || 'deepseek';
  form.baseUrl.value = effective.openAiCompatible.baseUrl || '';
  form.model.value = effective.openAiCompatible.model || '';
  form.responseFormat.value = effective.openAiCompatible.responseFormat || 'json_object';
  form.openAiTimeoutMs.value = effective.openAiCompatible.timeoutMs || 120000;
  form.openAiMaxInputChars.value = effective.openAiCompatible.maxInputChars || 12000;
  form.openAiMaxTokens.value = effective.openAiCompatible.maxTokens || '';
  form.codexCommand.value = effective.codexExec.command || 'codex';
  form.codexModel.value = effective.codexExec.model || '';
  form.codexReasoningEffort.value = effective.codexExec.reasoningEffort || '';
  form.codexSandbox.value = effective.codexExec.sandbox || 'read-only';
  form.codexCwd.value = effective.codexExec.cwd || '';
  form.codexTimeoutMs.value = effective.codexExec.timeoutMs || 120000;
  form.codexMaxInputChars.value = effective.codexExec.maxInputChars || 12000;
  form.auditEnabled.checked = effective.autoPromoteAudit.enabled !== false;
  form.auditProvider.value = effective.autoPromoteAudit.provider || 'codex_exec';
  form.auditCommand.value = effective.autoPromoteAudit.command || 'codex';
  form.auditCodexBin.value = effective.autoPromoteAudit.codexBin || effective.autoPromoteAudit.command || 'codex';
  form.auditPythonCommand.value = effective.autoPromoteAudit.pythonCommand || 'python3';
  form.auditPythonPath.value = effective.autoPromoteAudit.pythonPath || '';
  form.auditModel.value = effective.autoPromoteAudit.model || 'gpt-5.5';
  form.auditReasoningEffort.value = effective.autoPromoteAudit.reasoningEffort || 'low';
  form.auditTimeoutMs.value = effective.autoPromoteAudit.timeoutMs || 120000;
  for (const [key, value] of Object.entries(effective.distillPolicy)) {
    if (form[key]) form[key].value = value;
  }
  updateProviderSections();
}

function updateProviderSections() {
  const provider = $('#settingsForm').distillProvider.value;
  document.querySelectorAll('[data-provider-section]').forEach((section) => {
    section.hidden = section.dataset.providerSection !== provider;
  });
  $('#deepseekPreset').hidden = provider !== 'openai_compatible';
}

function applyOpenAiPreset(presetKey) {
  const preset = state.runtime?.effective?.presets?.openai_compatible?.[presetKey];
  if (!preset || presetKey === 'custom') return;
  const form = $('#settingsForm');
  form.baseUrl.value = preset.baseUrl || '';
  form.model.value = preset.model || '';
  form.responseFormat.value = preset.responseFormat || 'json_object';
  form.openAiTimeoutMs.value = 120000;
  form.openAiMaxInputChars.value = 12000;
  form.openAiMaxTokens.value = '';
}

function scopeKeyLabel(item) {
  const counts = [
    item.memories ? `메모리 ${item.memories}` : '',
    item.candidates ? `후보 ${item.candidates}` : '',
    item.distillRuns ? `실행 ${item.distillRuns}` : '',
  ].filter(Boolean);
  return `${item.scopeKey}${counts.length ? ` (${counts.join(', ')})` : ''}`;
}

function fillScopeKeySelect(select, scope, preferred = '') {
  const matches = state.scopeKeys.filter((item) => item.scopeType === scope);
  const fallback = preferred || state.db?.defaultScopeKey || '';
  select.innerHTML = matches
    .map((item) => `<option value="${escapeHtml(item.scopeKey)}">${escapeHtml(scopeKeyLabel(item))}</option>`)
    .join('');
  if (!matches.length && fallback) {
    select.innerHTML = `<option value="${escapeHtml(fallback)}">${escapeHtml(fallback)}</option>`;
  }
  if (preferred && [...select.options].some((option) => option.value === preferred)) {
    select.value = preferred;
  } else if (matches.length) {
    select.value = matches[0].scopeKey;
  }
}

function fillScopeKeySelects() {
  fillScopeKeySelect($('#memoryScopeKey'), $('#memoryScope').value, $('#memoryScopeKey').value);
  fillScopeKeySelect($('#runScopeKey'), $('#runScope').value, $('#runScopeKey').value);
}

function formNumber(form, key) {
  const value = Number(form[key].value);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

$('#settingsForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const values = {
    distillProvider: form.distillProvider.value,
    distillPolicy: {
      minEvents: formNumber(form, 'minEvents'),
      minIntervalMs: formNumber(form, 'minIntervalMs'),
      charMinIntervalMs: formNumber(form, 'charMinIntervalMs'),
      charThreshold: formNumber(form, 'charThreshold'),
      maxEvents: formNumber(form, 'maxEvents'),
      maxChars: formNumber(form, 'maxChars'),
    },
    autoPromoteAudit: {
      enabled: form.auditEnabled.checked,
      provider: form.auditProvider.value,
      command: form.auditCommand.value,
      codexBin: form.auditCodexBin.value || form.auditCommand.value,
      pythonCommand: form.auditPythonCommand.value || 'python3',
      pythonPath: form.auditPythonPath.value || null,
      model: form.auditModel.value || 'gpt-5.5',
      reasoningEffort: form.auditReasoningEffort.value || 'low',
      timeoutMs: formNumber(form, 'auditTimeoutMs') || 120000,
    },
  };
  if (form.distillProvider.value === 'openai_compatible') {
    values.openAiCompatible = {
      preset: form.preset.value,
      baseUrl: form.baseUrl.value,
      model: form.model.value,
      responseFormat: form.responseFormat.value,
      timeoutMs: formNumber(form, 'openAiTimeoutMs') || 120000,
      maxInputChars: formNumber(form, 'openAiMaxInputChars') || 12000,
      maxTokens: formNumber(form, 'openAiMaxTokens') || null,
    };
  }
  if (form.distillProvider.value === 'codex_exec') {
    values.codexExec = {
      command: form.codexCommand.value,
      model: form.codexModel.value || null,
      reasoningEffort: form.codexReasoningEffort.value || null,
      sandbox: form.codexSandbox.value || 'read-only',
      timeoutMs: formNumber(form, 'codexTimeoutMs') || 120000,
      maxInputChars: formNumber(form, 'codexMaxInputChars') || 12000,
    };
    if (form.codexCwd.value.trim()) {
      values.codexExec.cwd = form.codexCwd.value.trim();
    }
  }
  const secrets = {};
  const clearSecrets = [];
  if (form.distillProvider.value === 'openai_compatible' && form.apiKey.value.trim()) {
    secrets.openAiCompatibleApiKey = form.apiKey.value.trim();
  }
  if (form.clearApiKey.checked) {
    clearSecrets.push('openAiCompatibleApiKey');
  }
  try {
    const result = await call('updateRuntimeSettings', { values, secrets, clearSecrets });
    form.clearApiKey.checked = false;
    $('#settingsMessage').textContent = JSON.stringify(result.effective, null, 2);
    await refreshRuntime();
  } catch (error) {
    $('#settingsMessage').textContent = `${error.code ? `[${error.code}] ` : ''}${error.message}`;
  } finally {
    form.apiKey.value = '';
  }
});

$('#deepseekPreset').addEventListener('click', () => {
  const form = $('#settingsForm');
  form.distillProvider.value = 'openai_compatible';
  form.preset.value = 'deepseek';
  applyOpenAiPreset('deepseek');
  updateProviderSections();
});

$('#checkProvider').addEventListener('click', async () => {
  const result = await call('checkDistillProvider', { live: true });
  $('#settingsMessage').textContent = JSON.stringify(result, null, 2);
});

$('#settingsForm').distillProvider.addEventListener('change', updateProviderSections);
$('#settingsForm').preset.addEventListener('change', (event) => applyOpenAiPreset(event.target.value));
$('#memoryScope').addEventListener('change', () => fillScopeKeySelect($('#memoryScopeKey'), $('#memoryScope').value));
$('#runScope').addEventListener('change', () => fillScopeKeySelect($('#runScopeKey'), $('#runScope').value));

async function loadRuns(target = '#runsTable', options = {}) {
  const scope = options.scope || $('#runScope')?.value || 'repo';
  const scopeKey = options.scopeKey || $('#runScopeKey')?.value || state.db?.connection?.scopeKey || '';
  if (!scopeKey) return;
  const sessionId = options.sessionId ?? $('#runSession')?.value;
  const runs = await call('listDistillRuns', { scope, scopeKey, ...(sessionId ? { sessionId } : {}), limit: 25, order: 'desc' });
  const checkpointIds = new Set(runs.map((run) => run.outputMetadata?.checkpointId).filter(Boolean));
  let checkpointById = new Map();
  if (checkpointIds.size) {
    const checkpoints = await call('listCheckpoints', { scope, scopeKey, ...(sessionId ? { sessionId } : {}), level: 0 });
    checkpointById = new Map(checkpoints.filter((checkpoint) => checkpointIds.has(checkpoint.id)).map((checkpoint) => [checkpoint.id, checkpoint]));
  }
  state.runs = runs.map((run) => ({
    run,
    checkpoint: checkpointById.get(run.outputMetadata?.checkpointId) || null,
  }));
  $(target).innerHTML = state.runs.map(runItem).join('') || '<p class="muted">디스틸 실행 기록이 없습니다.</p>';
  document.querySelectorAll('[data-run-detail]').forEach((button) => {
    button.addEventListener('click', () => showDetail('디스틸 실행', state.runs[Number(button.dataset.runDetail)]));
  });
  document.querySelectorAll('[data-run-structured]').forEach((button) => {
    button.addEventListener('click', () => showDistillDetail(state.runs[Number(button.dataset.runStructured)]));
  });
  document.querySelectorAll('[data-run-audit]').forEach((button) => {
    button.addEventListener('click', async () => {
      const bundle = state.runs[Number(button.dataset.runAudit)];
      const checkpointId = bundle.checkpoint?.id || bundle.run.outputMetadata?.checkpointId || '';
      if (!checkpointId) return;
      $('#memoryScope').value = bundle.run.scopeType;
      await fillScopeKeySelect($('#memoryScopeKey'), bundle.run.scopeType);
      $('#memoryScopeKey').value = bundle.run.scopeKey;
      $('#candidateSession').value = bundle.run.sessionId || '';
      $('#candidateCheckpoint').value = checkpointId;
      document.querySelectorAll('.tabs button, .tab').forEach((item) => item.classList.remove('active'));
      document.querySelector('[data-tab="memory"]').classList.add('active');
      $('#memory').classList.add('active');
      await loadAuditedCandidates();
    });
  });
}

function runItem(bundle, index) {
  const { run, checkpoint } = bundle;
  const structured = checkpointStructured(checkpoint);
  const work = structured?.work || {};
  const liveState = structured?.liveState || {};
  const checkpointId = checkpoint?.id || run.outputMetadata?.checkpointId || '';
  const summary = checkpoint?.summaryShort || run.errorMessage || '체크포인트 본문이 없습니다.';
  const structuredState = structured ? 'structured 있음' : 'structured 없음';
  const counts = structured
    ? [
        countLabel('변경', structured.changes),
        countLabel('검증', structured.verification),
        countLabel('위험', structured.risks),
        countLabel('다음 액션', structured.nextActions),
      ].join(' · ')
    : '구조화 payload 없음';
  return `<article class="item">
    <header><span class="item-title"><strong>${escapeHtml(run.createdAt || '')}</strong></span><span class="muted">${escapeHtml(run.status)} · ${escapeHtml(run.provider)} · ${escapeHtml(structuredState)}</span></header>
    <p>${escapeHtml(summary.slice(0, 260))}</p>
    <p class="muted">${escapeHtml(work.status || work.outcome || '')}${work.status || work.outcome ? ' · ' : ''}${escapeHtml(liveState.branch || liveState.prUrl || '')}</p>
    <p class="muted">${escapeHtml(counts)}</p>
    <div class="actions">
      <button data-run-detail="${index}">실행 상세</button>
      <button data-run-structured="${index}" ${structured ? '' : 'disabled'}>구조화 보기</button>
      <button data-run-audit="${index}" ${checkpointId ? '' : 'disabled'}>감사 후보 보기</button>
      <span class="muted">${escapeHtml(checkpointId)}</span>
    </div>
  </article>`;
}

async function loadRecentRuns() {
  const activeProvider = state.runtime?.effective?.distillProvider || '';
  const runs = await call('listRecentDistillRuns', { limit: 25 });
  $('#recentRunsHint').textContent = activeProvider
    ? `전체 스코프의 최신 디스틸 실행입니다. 현재 활성 프로바이더: ${activeProvider}`
    : '전체 스코프의 최신 디스틸 실행입니다.';
  $('#recentRuns').innerHTML = table(runs, [
    { label: '생성 시각', value: (row) => row.createdAt },
    { label: '스코프', value: (row) => `${row.scopeType}:${row.scopeKey}` },
    { label: '프로바이더', value: (row) => row.provider },
    { label: '상태', value: (row) => row.status },
    { label: '세션', value: (row) => row.sessionId },
    { label: '이벤트', value: (row) => row.sourceEventCount },
    { label: '오류', value: (row) => row.errorMessage || '' },
  ]);
}

$('#loadRuns').addEventListener('click', (event) => {
  event.preventDefault();
  loadRuns();
});

$('#loadMemories').addEventListener('click', async (event) => {
  event.preventDefault();
  const scope = $('#memoryScope').value;
  const scopeKey = $('#memoryScopeKey').value;
  const query = $('#memoryQuery').value;
  const status = $('#memoryStatus').value;
  const memories = await call('listMemories', { scope, scopeKey, query, status, limit: 100 });
  state.memories = memories;
  $('#memories').innerHTML = memories.map(memoryItem).join('') || '<p class="muted">메모리가 없습니다.</p>';
  document.querySelectorAll('[data-memory]').forEach((button) => {
    button.addEventListener('click', () => showDetail('메모리', memories[Number(button.dataset.memory)]));
  });
  document.querySelectorAll('[data-deactivate]').forEach((button) => {
    button.addEventListener('click', async () => {
      const memory = memories[Number(button.dataset.deactivate)];
      const reason = prompt(`${memory.key} 메모리를 비활성화하는 이유를 입력하세요.`);
      if (!reason) return;
      await call('deactivateMemory', { scope, scopeKey, key: memory.key, reason });
      $('#loadMemories').click();
    });
  });
  document.querySelectorAll('[data-correct]').forEach((button) => {
    button.addEventListener('click', async () => {
      const memory = memories[Number(button.dataset.correct)];
      const content = prompt(`${memory.key} 메모리의 수정 내용을 입력하세요.`, memory.content);
      if (!content || content === memory.content) return;
      const reason = prompt('수정 이유를 입력하세요.') || 'admin-ui correction';
      await call('correctMemory', {
        scope,
        scopeKey,
        key: memory.key,
        content,
        category: memory.category,
        tags: memory.tags,
        importance: memory.importance,
        reason,
      });
      $('#loadMemories').click();
    });
  });
});

function memoryItem(memory, index) {
  return `<article class="item">
    <header><span class="item-title"><input type="checkbox" data-memory-select="${index}" aria-label="메모리 선택" /><strong>${escapeHtml(memory.key)}</strong></span><span class="muted">${escapeHtml(memory.category)} · ${escapeHtml(memory.importance)}</span></header>
    <p>${escapeHtml(memory.content.slice(0, 280))}</p>
    <div class="actions">
      <button data-memory="${index}">상세</button>
      <button data-correct="${index}">수정</button>
      <button class="danger" data-deactivate="${index}">비활성화</button>
    </div>
  </article>`;
}

function auditedActionLabel(value) {
  const labels = {
    promote: '감사 승인',
    review: '사람 검토',
    ask_user: '사용자 확인',
    dry_run_only: '드라이런',
    do_not_promote: '새 메모리 생성 금지',
    review_update_candidate: '메모리 업데이트 검토',
    route_before_promote: '승격 전 라우팅 필요',
  };
  return labels[String(value || '').toLowerCase()] || '감사 결과';
}

function auditDecisionLabel(audit) {
  if (!audit) return '감사 미실행';
  const labels = {
    approve: 'approve',
    needs_review: 'needs_review',
    reject: 'reject',
  };
  return labels[String(audit.decision || '').toLowerCase()] || String(audit.decision || 'unknown');
}

async function loadAuditedCandidates({ cursor = null } = {}) {
  const scope = $('#memoryScope').value;
  const scopeKey = $('#memoryScopeKey').value;
  const sessionId = $('#candidateSession').value.trim();
  const checkpointId = $('#candidateCheckpoint').value.trim();
  const result = await call('memoryCandidateBacklog', {
    scope,
    scopeKey,
    ...(checkpointId ? { checkpointId } : sessionId ? { sessionId } : {}),
    status: $('#candidateStatus').value,
    ...($('#candidateAuditState').value ? { auditState: $('#candidateAuditState').value } : {}),
    ...($('#candidateAuditDecision').value ? { auditDecision: $('#candidateAuditDecision').value } : {}),
    limit: 50,
    page: true,
    ...(cursor ? { cursor } : {}),
  });
  state.candidates = (result.page?.items || []).map((item) => {
    const candidate = {
      ...item.candidate,
      candidateId: item.id,
      disposition: item.status,
      auditState: item.auditState,
      auditDecision: item.auditDecision,
      auditContentHash: item.auditContentHash,
      latestAuditAttemptId: item.latestAuditAttemptId,
      audit: item.reviewMetadata?.audit || null,
      promotionRouting: item.reviewMetadata?.promotionRouting || null,
      auditReason: item.reviewReason,
      reviewedAt: item.reviewedAt,
      snoozedUntil: item.snoozedUntil,
      snoozeReason: item.snoozeReason,
      snoozedBy: item.snoozedBy,
      wakeUpStatus: item.wakeUpStatus,
      evidence: {
        checkpointId: item.checkpointId,
        sessionId: item.sessionId,
        sourceAgent: item.source?.sourceAgent || null,
        sourceProvenance: item.source?.sourceProvenance || null,
      },
      source: item.source,
    };
    return { ...candidate, recommendedAction: candidateRecommendedAction(candidate) };
  });
  state.candidateCursor = result.page?.page?.nextCursor || null;
  if (result.summary) {
    state.candidateSummary = result.summary;
    state.candidateAsOf = result.asOf;
  }
  const summary = state.candidateSummary;
  if (summary) {
    $('#candidateSummary').textContent = [
      `기준 ${state.candidateAsOf || ''}`,
      `필터 결과 ${summary.filteredCandidateCount || 0}`,
      `pending ${summary.pendingCandidateCount || 0}`,
      `미감사 ${summary.byAuditState?.unaudited || 0}`,
      `감사 대기/실행 ${Number(summary.byAuditState?.queued || 0) + Number(summary.byAuditState?.running || 0)}`,
      `승인 후 대기 ${summary.approvedAwaitingPromotionCount || 0}`,
      `사람 검토 ${summary.pendingNeedsReviewCount || 0}`,
      `거절 권고 ${summary.pendingRejectRecommendedCount || 0}`,
      `snoozed ${summary.byStatus?.snoozed || 0}`,
      `oldest ${summary.oldestPendingAt || '-'}`,
    ].join(' · ');
  }
  $('#nextCandidatePage').hidden = !state.candidateCursor;
  $('#candidates').innerHTML = state.candidates.map(candidateItem).join('') || '<p class="muted">현재 필터에 해당하는 후보가 없습니다.</p>';
  document.querySelectorAll('[data-candidate-select]').forEach((input) => {
    input.addEventListener('change', updateCandidateBulkButtons);
  });
  updateCandidateBulkButtons();
  document.querySelectorAll('[data-candidate]').forEach((button) => {
    button.addEventListener('click', () => showDetail('감사 후보', state.candidates[Number(button.dataset.candidate)]));
  });
  document.querySelectorAll('[data-promote]').forEach((button) => {
    button.addEventListener('click', async () => {
      const candidate = state.candidates[Number(button.dataset.promote)];
      const key = prompt('메모리 키', candidate.key);
      if (!key) return;
      const content = prompt('메모리 내용', candidate.content);
      if (!content) return;
      const edited = key !== candidate.key || content !== candidate.content;
      const reasonPrompt = edited ? '감사된 원문도 수정됩니다. 수정 및 승격 이유를 함께 기록하세요.' : '';
      const promotionReason = reasonPrompt ? prompt(reasonPrompt) : null;
      if (reasonPrompt && !promotionReason) return;
      const promotionRequest = {
        scope,
        scopeKey,
        candidateId: candidate.candidateId,
        expectedAuditAttemptId: candidate.latestAuditAttemptId,
        key,
        content,
        category: candidate.category || 'note',
        tags: candidate.tags || [],
        importance: candidate.importance ?? 0,
        ...(edited ? { allowAuditRevisionOverride: true } : {}),
        ...(promotionReason ? { reason: promotionReason } : {}),
      };
      try {
        await call('promoteMemoryCandidate', promotionRequest);
      } catch (error) {
        if (!Array.isArray(error.warnings) || error.warnings.length === 0) throw error;
        const warningText = error.warnings
          .map((warning) => warning.message || warning.code || String(warning))
          .join('\n- ');
        if (!confirm(`승격 전에 다음 경고를 확인하세요.\n\n- ${warningText}\n\n그래도 계속할까요?`)) return;
        const warningReason = promotionReason || prompt('경고를 감수하고 승격하는 이유를 입력하세요.');
        if (!warningReason) return;
        await call('promoteMemoryCandidate', {
          ...promotionRequest,
          allowWarnings: true,
          reason: warningReason,
        });
      }
      await loadAuditedCandidates();
    });
  });
  document.querySelectorAll('[data-reject]').forEach((button) => {
    button.addEventListener('click', async () => {
      const candidate = state.candidates[Number(button.dataset.reject)];
      const reason = prompt('후보 거절 이유를 입력하세요.');
      if (!reason) return;
      await call('rejectMemoryCandidate', { scope, scopeKey, candidateId: candidate.candidateId, reason });
      await loadAuditedCandidates();
    });
  });
  document.querySelectorAll('[data-snooze]').forEach((button) => {
    button.addEventListener('click', async () => {
      const candidate = state.candidates[Number(button.dataset.snooze)];
      const defaultUntil = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      const snoozedUntil = prompt('재검토 시각을 ISO date-time으로 입력하세요.', defaultUntil);
      if (!snoozedUntil) return;
      const reason = prompt('후보를 잠시 미루는 이유를 입력하세요.');
      if (!reason) return;
      await call('snoozeMemoryCandidate', {
        scope, scopeKey, candidateId: candidate.candidateId, snoozedUntil, reason, actor: 'admin-ui',
      });
      await loadAuditedCandidates();
    });
  });
  document.querySelectorAll('[data-wake]').forEach((button) => {
    button.addEventListener('click', async () => {
      const candidate = state.candidates[Number(button.dataset.wake)];
      const reason = prompt('후보를 다시 pending으로 여는 이유를 입력하세요.', 'Manual review resumed.');
      if (!reason) return;
      await call('wakeMemoryCandidate', {
        scope, scopeKey, candidateId: candidate.candidateId, reason, actor: 'admin-ui',
      });
      await loadAuditedCandidates();
    });
  });
  document.querySelectorAll('[data-reopen-stale]').forEach((button) => {
    button.addEventListener('click', async () => {
      const candidate = state.candidates[Number(button.dataset.reopenStale)];
      const reason = prompt('stale 후보를 다시 pending으로 여는 이유를 입력하세요.', 'Manual review resumed.');
      if (!reason) return;
      await call('reopenStaleMemoryCandidate', {
        scope, scopeKey, candidateId: candidate.candidateId, reason, actor: 'admin-ui',
      });
      await loadAuditedCandidates();
    });
  });
}

$('#loadCandidates').addEventListener('click', async (event) => {
  event.preventDefault();
  await loadAuditedCandidates();
});

function candidateItem(candidate, index) {
  const action = auditedActionLabel(candidate.recommendedAction);
  const decision = auditDecisionLabel(candidate.audit);
  const sourceAgent = candidate.evidence?.sourceAgent || candidate.evidence?.sourceProvenance?.sourceAgent || '';
  const sourceText = sourceAgent ? ` · ${sourceAgent}` : '';
  const risks = Array.isArray(candidate.audit?.riskCodes) && candidate.audit.riskCodes.length
    ? ` · 위험 ${candidate.audit.riskCodes.join(', ')}`
    : '';
  const provider = candidate.audit?.metadata?.provider || '미실행';
  const model = candidate.audit?.metadata?.model || '';
  const mutable = candidateBulkEligibility(candidate).select;
  const actionAvailability = candidateActionAvailability(candidate);
  const snoozeText = candidate.disposition === 'snoozed' ? ` · 재검토 ${candidate.snoozedUntil || '미지정'}` : '';
  const routingText = candidate.promotionRouting
    ? ` · 라우팅 ${candidate.promotionRouting.classification}${candidate.promotionRouting.targetMemoryKey ? ` → ${candidate.promotionRouting.targetMemoryKey}` : ''}`
    : '';
  const actionButton = (name, label, availability, className = '') => availability.visible
    ? `<button${className ? ` class="${className}"` : ''} data-${name}="${index}" ${availability.enabled ? '' : `disabled title="${escapeHtml(availability.reason)}"`}>${label}</button>`
    : '';
  const blockedReasons = Object.entries(actionAvailability)
    .filter(([, availability]) => availability.visible && !availability.enabled && availability.reason)
    .map(([name, availability]) => `${name === 'promote' ? '승격' : '미루기'} 불가: ${availability.reason}`);
  return `<article class="item">
    <header><span class="item-title"><input type="checkbox" data-candidate-select="${index}" aria-label="후보 선택" ${mutable ? '' : 'disabled'} /><strong>${escapeHtml(candidate.key)}</strong></span><span class="muted">${escapeHtml(candidate.disposition)} · ${escapeHtml(candidate.auditState)} · ${escapeHtml(action)} · ${escapeHtml(decision)}</span></header>
    <p>${escapeHtml(candidate.content.slice(0, 220))}</p>
    <p class="muted">${escapeHtml(provider)}${model ? `/${escapeHtml(model)}` : ''}${escapeHtml(sourceText)} · ${escapeHtml(candidate.category || 'note')} · ${escapeHtml(candidate.auditReason || candidate.whyDurable || '')}${escapeHtml(risks)}${escapeHtml(snoozeText)}${escapeHtml(routingText)}</p>
    <div class="actions">
      <button data-candidate="${index}">상세</button>
      ${actionButton('promote', '승격', actionAvailability.promote)}
      ${actionButton('snooze', '미루기', actionAvailability.snooze)}
      ${actionButton('wake', '다시 열기', actionAvailability.wake)}
      ${actionButton('reopen-stale', 'stale 해제', actionAvailability.reopenStale)}
      ${actionButton('reject', '거절', actionAvailability.reject, 'danger')}
      ${blockedReasons.length ? `<span class="action-guidance">${escapeHtml(blockedReasons.join(' · '))}</span>` : ''}
    </div>
  </article>`;
}

function checkedIndexes(selector) {
  return [...document.querySelectorAll(`${selector}:checked:not(:disabled)`)]
    .map((input) => Number(input.dataset.memorySelect ?? input.dataset.candidateSelect));
}

function setChecked(selector, checked) {
  document.querySelectorAll(selector).forEach((input) => {
    input.checked = checked && !input.disabled;
  });
}

function selectedCandidateIndexesFor(action) {
  return eligibleCandidateIndexes(state.candidates, checkedIndexes('[data-candidate-select]'), action);
}

function updateCandidateBulkButtons() {
  const selectedIndexes = checkedIndexes('[data-candidate-select]');
  $('#selectAllCandidates').disabled = !state.candidates.some((candidate) => candidateBulkEligibility(candidate).select);
  $('#planCandidateAudit').disabled = $('#candidateStatus').value !== 'pending';
  $('#auditSelectedCandidates').disabled = eligibleCandidateIndexes(state.candidates, selectedIndexes, 'audit').length === 0;
  $('#routeSelectedCandidates').disabled = eligibleCandidateIndexes(state.candidates, selectedIndexes, 'route').length === 0;
  $('#rejectSelectedCandidates').disabled = eligibleCandidateIndexes(state.candidates, selectedIndexes, 'reject').length === 0;
}

$('#selectAllMemories').addEventListener('click', (event) => {
  event.preventDefault();
  setChecked('[data-memory-select]', true);
});

$('#clearMemorySelection').addEventListener('click', (event) => {
  event.preventDefault();
  setChecked('[data-memory-select]', false);
});

$('#deactivateSelectedMemories').addEventListener('click', async (event) => {
  event.preventDefault();
  const indexes = checkedIndexes('[data-memory-select]');
  if (!indexes.length) return;
  const reason = prompt(`선택한 메모리 ${indexes.length}개를 비활성화하는 이유를 입력하세요.`);
  if (!reason) return;
  const scope = $('#memoryScope').value;
  const scopeKey = $('#memoryScopeKey').value;
  for (const index of indexes) {
    const memory = state.memories[index];
    if (memory) {
      await call('deactivateMemory', { scope, scopeKey, key: memory.key, reason });
    }
  }
  $('#loadMemories').click();
});

$('#selectAllCandidates').addEventListener('click', (event) => {
  event.preventDefault();
  setChecked('[data-candidate-select]', true);
  updateCandidateBulkButtons();
});

$('#clearCandidateSelection').addEventListener('click', (event) => {
  event.preventDefault();
  setChecked('[data-candidate-select]', false);
  updateCandidateBulkButtons();
});

$('#nextCandidatePage').addEventListener('click', async (event) => {
  event.preventDefault();
  if (state.candidateCursor) await loadAuditedCandidates({ cursor: state.candidateCursor });
});

$('#planCandidateAudit').addEventListener('click', async (event) => {
  event.preventDefault();
  const indexes = selectedCandidateIndexesFor('audit');
  const candidateIds = indexes.map((index) => state.candidates[index]?.candidateId).filter(Boolean);
  const result = await call('planMemoryCandidateBacklogAudit', {
    scope: $('#memoryScope').value,
    scopeKey: $('#memoryScopeKey').value,
    ...(candidateIds.length ? { candidateIds, limit: candidateIds.length } : { limit: 100 }),
    ...($('#candidateAuditState').value ? { auditState: $('#candidateAuditState').value } : {}),
    maxProviderCalls: 10,
  });
  const planned = result.costEstimate?.plannedBatch || {};
  const inventory = result.inventory || {};
  $('#candidateAuditPlan').textContent = [
    `기준 ${result.asOf}`,
    `스캔 ${inventory.scannedCount || 0}`,
    `provider 대상 ${inventory.providerEligibleCount || 0}`,
    `이번 batch 호출 ${planned.providerCalls || 0}`,
    `예상 입력 ${planned.estimatedInputTokens || 0} tokens`,
    `예상 출력 ${planned.estimatedOutputTokens || 0} tokens`,
    `deterministic triage ${inventory.byClassification?.deterministic_triage || 0}`,
    `exact duplicate ${Number(inventory.byClassification?.exact_candidate_duplicate || 0) + Number(inventory.byClassification?.exact_durable_duplicate || 0)}`,
    `stale 제안 ${inventory.staleSuggestedCount || 0}`,
    planned.estimatedUsd == null ? '비용 단가 미입력' : `예상 비용 $${planned.estimatedUsd}`,
    '이 dry-run은 candidate 상태를 바꾸거나 provider를 호출하지 않습니다.',
  ].join('\n');
});

$('#auditSelectedCandidates').addEventListener('click', async (event) => {
  event.preventDefault();
  const indexes = selectedCandidateIndexesFor('audit');
  if (!indexes.length) return;
  if (indexes.length > 10) {
    alert('감사 작업은 한 번에 최대 10개 후보만 제출할 수 있습니다.');
    return;
  }
  const candidateIds = indexes.map((index) => state.candidates[index]?.candidateId).filter(Boolean);
  if (!confirm(`선택한 후보 ${candidateIds.length}개를 durable 감사 작업으로 제출할까요?`)) return;
  const result = await call('submitAuditJob', {
    scope: $('#memoryScope').value,
    scopeKey: $('#memoryScopeKey').value,
    candidateIds,
    trigger: 'manual_closeout',
    limit: candidateIds.length,
  });
  const submittedCount = result.selection?.submittedCandidateIds?.length ?? result.job?.payload?.candidateIds?.length ?? 0;
  const skippedCount = result.selection?.skippedCandidates?.length ?? Math.max(0, candidateIds.length - submittedCount);
  const skippedReasons = [...new Set((result.selection?.skippedCandidates || []).map((item) => item.reason))].join(', ');
  alert(`감사 작업 ${result.jobId} · ${result.status} · 제출 ${submittedCount}개${skippedCount ? ` · 제외 ${skippedCount}개${skippedReasons ? ` (${skippedReasons})` : ''}` : ''}`);
  await loadAuditedCandidates();
});

$('#routeSelectedCandidates').addEventListener('click', async (event) => {
  event.preventDefault();
  const indexes = selectedCandidateIndexesFor('route');
  const candidateIds = indexes.map((index) => state.candidates[index]?.candidateId).filter(Boolean);
  if (!candidateIds.length) return;
  if (!confirm(`감사 승인 후보 ${candidateIds.length}개의 durable write 경로를 분류할까요? 이 작업은 새 영구 메모리를 만들지 않습니다.`)) return;
  const result = await call('routeAuditedMemoryCandidates', {
    scope: $('#memoryScope').value, scopeKey: $('#memoryScopeKey').value, candidateIds, dryRun: false,
  });
  $('#candidateAuditPlan').textContent = `라우팅 ${result.resultCount}개 · ${JSON.stringify(result.counts)}\n중복은 새 메모리를 만들지 않으며, 보강/대체/충돌은 아래 업데이트 검토 큐로 이동했습니다.`;
  await loadAuditedCandidates();
  await loadMemoryUpdates();
});

function memoryUpdateItem(candidate, index) {
  return `<article class="item">
    <header><strong>${escapeHtml(candidate.proposedKey || candidate.targetMemoryKey || candidate.id)}</strong><span class="muted">${escapeHtml(candidate.action)} · ${escapeHtml(candidate.status)}</span></header>
    <p>${escapeHtml((candidate.proposedContent || candidate.correction || '').slice(0, 260))}</p>
    <p class="muted">대상 ${escapeHtml(candidate.targetMemoryKey || '-')} · 원 후보 ${escapeHtml(candidate.sourceCandidateId || '-')} · ${escapeHtml(candidate.reason || '')}</p>
    <div class="actions"><button data-update-detail="${index}">상세</button><button data-update-apply="${index}">적용</button><button class="danger" data-update-reject="${index}">거절</button><button data-update-skip="${index}">stale로 종료</button></div>
  </article>`;
}

async function loadMemoryUpdates() {
  const scope = $('#memoryScope').value;
  const scopeKey = $('#memoryScopeKey').value;
  const result = await call('listMemoryUpdateCandidates', { scope, scopeKey, status: 'pending', limit: 50, page: true });
  state.memoryUpdates = result.page?.items || [];
  $('#memoryUpdates').innerHTML = state.memoryUpdates.map(memoryUpdateItem).join('') || '<p class="muted">대기 중인 업데이트 후보가 없습니다.</p>';
  document.querySelectorAll('[data-update-detail]').forEach((button) => button.addEventListener('click', () => showDetail('메모리 업데이트 후보', state.memoryUpdates[Number(button.dataset.updateDetail)])));
  document.querySelectorAll('[data-update-apply]').forEach((button) => button.addEventListener('click', async () => {
    const candidate = state.memoryUpdates[Number(button.dataset.updateApply)];
    const reason = prompt('기존 영구 메모리에 이 업데이트를 적용하는 이유를 입력하세요.', candidate.reason || 'Reviewed memory update.');
    if (!reason) return;
    await call('applyMemoryUpdateCandidate', { scope, scopeKey, candidateId: candidate.id, reason });
    await loadMemoryUpdates(); await loadAuditedCandidates(); $('#loadMemories').click();
  }));
  document.querySelectorAll('[data-update-reject]').forEach((button) => button.addEventListener('click', async () => {
    const candidate = state.memoryUpdates[Number(button.dataset.updateReject)];
    const reason = prompt('업데이트 후보를 거절하는 이유를 입력하세요.'); if (!reason) return;
    await call('rejectMemoryUpdateCandidate', { scope, scopeKey, candidateId: candidate.id, reason });
    await loadMemoryUpdates(); await loadAuditedCandidates();
  }));
  document.querySelectorAll('[data-update-skip]').forEach((button) => button.addEventListener('click', async () => {
    const candidate = state.memoryUpdates[Number(button.dataset.updateSkip)];
    const reason = prompt('업데이트를 적용하지 않고 원 후보를 stale로 종료하는 이유를 입력하세요.'); if (!reason) return;
    await call('skipMemoryUpdateCandidate', { scope, scopeKey, candidateId: candidate.id, reason });
    await loadMemoryUpdates(); await loadAuditedCandidates();
  }));
}

$('#loadMemoryUpdates').addEventListener('click', async (event) => { event.preventDefault(); await loadMemoryUpdates(); });

$('#rejectSelectedCandidates').addEventListener('click', async (event) => {
  event.preventDefault();
  const indexes = selectedCandidateIndexesFor('reject');
  if (!indexes.length) return;
  const reason = prompt(`선택한 후보 ${indexes.length}개를 거절하는 이유를 입력하세요.`);
  if (!reason) return;
  const scope = $('#memoryScope').value;
  const scopeKey = $('#memoryScopeKey').value;
  for (const index of indexes) {
    const candidate = state.candidates[index];
    if (candidate) {
      await call('rejectMemoryCandidate', { scope, scopeKey, candidateId: candidate.candidateId, reason });
    }
  }
  $('#loadCandidates').click();
});

document.querySelectorAll('.tabs button').forEach((button) => {
  button.addEventListener('click', () => {
    document.querySelectorAll('.tabs button, .tab').forEach((item) => item.classList.remove('active'));
    button.classList.add('active');
    $(`#${button.dataset.tab}`).classList.add('active');
  });
});

restoreLoginSession()
  .catch(() => false)
  .then(() => refreshRuntime())
  .then(() => refreshDashboardRuns().catch(() => {}))
  .catch((error) => {
    $('#connection').textContent = error.message;
  });
