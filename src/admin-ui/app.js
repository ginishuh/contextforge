const state = {
  runtime: null,
  db: null,
  scopeKeys: [],
  memories: [],
  candidates: [],
};

const $ = (selector) => document.querySelector(selector);
const tokenInput = $('#token');
tokenInput.value = localStorage.getItem('contextforgeToken') || '';
tokenInput.addEventListener('input', () => localStorage.setItem('contextforgeToken', tokenInput.value));

$('#loginForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const response = await fetch('/ui/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username: form.username.value,
      password: form.password.value,
    }),
  });
  if (!response.ok) {
    $('#connection').textContent = '로그인 실패';
    return;
  }
  form.password.value = '';
  await refreshRuntime();
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
    throw new Error(payload?.error?.message || `${method} failed`);
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

function showDetail(title, content) {
  $('#detail').innerHTML = `<h2>${escapeHtml(title)}</h2><pre>${escapeHtml(JSON.stringify(content, null, 2))}</pre>`;
  $('#detailDialog').showModal();
}

async function refreshRuntime() {
  const [runtime, db, scopeKeys] = await Promise.all([
    call('getRuntimeSettings'),
    call('dbInfo'),
    call('listScopeKeys', { limit: 500 }),
  ]);
  state.runtime = runtime;
  state.db = db;
  state.scopeKeys = scopeKeys;
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
  runtimeRows.push(['메모리 수', db.tables.memories], ['후보 수', db.tables.memoryCandidates]);
  dl($('#runtimeSummary'), runtimeRows);
  dl(
    $('#policySummary'),
    Object.entries(effective.distillPolicy).map(([key, value]) => [DISTILL_POLICY_LABELS[key] || key, value]),
  );
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
  form.codexCommand.value = effective.codexExec.command || 'codex';
  form.codexModel.value = effective.codexExec.model || '';
  form.codexReasoningEffort.value = effective.codexExec.reasoningEffort || '';
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
  };
  if (form.distillProvider.value === 'openai_compatible') {
    values.openAiCompatible = {
      preset: form.preset.value,
      baseUrl: form.baseUrl.value,
      model: form.model.value,
      responseFormat: form.responseFormat.value,
    };
  }
  if (form.distillProvider.value === 'codex_exec') {
    values.codexExec = {
      command: form.codexCommand.value,
      model: form.codexModel.value || null,
      reasoningEffort: form.codexReasoningEffort.value || null,
    };
  }
  const secrets = {};
  if (form.distillProvider.value === 'openai_compatible' && form.apiKey.value.trim()) {
    secrets.openAiCompatibleApiKey = form.apiKey.value.trim();
  }
  const result = await call('updateRuntimeSettings', { values, secrets });
  form.apiKey.value = '';
  $('#settingsMessage').textContent = JSON.stringify(result.effective, null, 2);
  await refreshRuntime();
});

$('#deepseekPreset').addEventListener('click', () => {
  const form = $('#settingsForm');
  form.distillProvider.value = 'openai_compatible';
  form.preset.value = 'deepseek';
  form.baseUrl.value = 'https://api.deepseek.com';
  form.model.value = 'deepseek-v4-flash';
  form.responseFormat.value = 'json_object';
  updateProviderSections();
});

$('#checkProvider').addEventListener('click', async () => {
  const result = await call('checkDistillProvider', { live: true });
  $('#settingsMessage').textContent = JSON.stringify(result, null, 2);
});

$('#settingsForm').distillProvider.addEventListener('change', updateProviderSections);
$('#memoryScope').addEventListener('change', () => fillScopeKeySelect($('#memoryScopeKey'), $('#memoryScope').value));
$('#runScope').addEventListener('change', () => fillScopeKeySelect($('#runScopeKey'), $('#runScope').value));

async function loadRuns(target = '#runsTable', options = {}) {
  const scope = options.scope || $('#runScope')?.value || 'repo';
  const scopeKey = options.scopeKey || $('#runScopeKey')?.value || state.db?.connection?.scopeKey || '';
  if (!scopeKey) return;
  const sessionId = options.sessionId ?? $('#runSession')?.value;
  const runs = await call('listDistillRuns', { scope, scopeKey, ...(sessionId ? { sessionId } : {}), limit: 100 });
  $(target).innerHTML = table(runs.slice(-25).reverse(), [
    { label: '생성 시각', value: (row) => row.createdAt },
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
    <header><span class="item-title"><input type="checkbox" data-memory-select="${index}" aria-label="메모리 선택" /><strong>${escapeHtml(memory.key)}</strong></span><span class="muted">${escapeHtml(memory.category)} · ${memory.importance}</span></header>
    <p>${escapeHtml(memory.content.slice(0, 280))}</p>
    <div class="actions">
      <button data-memory="${index}">상세</button>
      <button data-correct="${index}">수정</button>
      <button class="danger" data-deactivate="${index}">비활성화</button>
    </div>
  </article>`;
}

$('#loadCandidates').addEventListener('click', async (event) => {
  event.preventDefault();
  const scope = $('#memoryScope').value;
  const scopeKey = $('#memoryScopeKey').value;
  const candidates = await call('listMemoryCandidates', { scope, scopeKey, limit: 100 });
  state.candidates = candidates;
  $('#candidates').innerHTML = candidates.map(candidateItem).join('') || '<p class="muted">후보가 없습니다.</p>';
  document.querySelectorAll('[data-candidate]').forEach((button) => {
    button.addEventListener('click', () => showDetail('후보', candidates[Number(button.dataset.candidate)]));
  });
  document.querySelectorAll('[data-promote]').forEach((button) => {
    button.addEventListener('click', async () => {
      const candidate = candidates[Number(button.dataset.promote)];
      const key = prompt('메모리 키', candidate.candidate.key);
      if (!key) return;
      const content = prompt('메모리 내용', candidate.candidate.content);
      if (!content) return;
      await call('promoteMemoryCandidate', {
        scope,
        scopeKey,
        candidateId: candidate.id,
        key,
        content,
        category: candidate.candidate.category || 'note',
        tags: candidate.candidate.tags || [],
        importance: candidate.candidate.importance || 0,
        allowWarnings: true,
      });
      $('#loadCandidates').click();
    });
  });
  document.querySelectorAll('[data-reject]').forEach((button) => {
    button.addEventListener('click', async () => {
      const candidate = candidates[Number(button.dataset.reject)];
      const reason = prompt('후보 거절 이유를 입력하세요.');
      if (!reason) return;
      await call('rejectMemoryCandidate', { scope, scopeKey, candidateId: candidate.id, reason });
      $('#loadCandidates').click();
    });
  });
});

function candidateItem(candidate, index) {
  return `<article class="item">
    <header><span class="item-title"><input type="checkbox" data-candidate-select="${index}" aria-label="후보 선택" /><strong>${escapeHtml(candidate.candidate.key)}</strong></span><span class="muted">${escapeHtml(candidate.status)}</span></header>
    <p>${escapeHtml(candidate.candidate.content.slice(0, 220))}</p>
    <div class="actions">
      <button data-candidate="${index}">상세</button>
      <button data-promote="${index}">승격</button>
      <button class="danger" data-reject="${index}">거절</button>
    </div>
  </article>`;
}

function checkedIndexes(selector) {
  return [...document.querySelectorAll(`${selector}:checked`)].map((input) => Number(input.dataset.memorySelect ?? input.dataset.candidateSelect));
}

function setChecked(selector, checked) {
  document.querySelectorAll(selector).forEach((input) => {
    input.checked = checked;
  });
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
});

$('#clearCandidateSelection').addEventListener('click', (event) => {
  event.preventDefault();
  setChecked('[data-candidate-select]', false);
});

$('#rejectSelectedCandidates').addEventListener('click', async (event) => {
  event.preventDefault();
  const indexes = checkedIndexes('[data-candidate-select]');
  if (!indexes.length) return;
  const reason = prompt(`선택한 후보 ${indexes.length}개를 거절하는 이유를 입력하세요.`);
  if (!reason) return;
  const scope = $('#memoryScope').value;
  const scopeKey = $('#memoryScopeKey').value;
  for (const index of indexes) {
    const candidate = state.candidates[index];
    if (candidate) {
      await call('rejectMemoryCandidate', { scope, scopeKey, candidateId: candidate.id, reason });
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

refreshRuntime()
  .then(() => loadRuns('#recentRuns', { scope: 'repo', scopeKey: state.db?.defaultScopeKey || '' }).catch(() => {}))
  .catch((error) => {
    $('#connection').textContent = error.message;
  });
