import { buildCodexExecPrompt, CHECKPOINT_OUTPUT_SCHEMA, CODEX_EXEC_OUTPUT_SCHEMA_VERSION } from './codex_exec.js';
import { validateDistillOutput } from '../validate.js';
import { assertExternalProviderAllowed } from '../../testing/external_provider.js';

export const OPENAI_COMPATIBLE_PROMPT_VERSION = 'openai_compatible.prompt.v3';

const DEFAULT_TIMEOUT_MS = 120000;
const DEFAULT_BASE_URL = 'https://api.deepseek.com';
const DEFAULT_MODEL = 'deepseek-v4-flash';
const STRICT_SCHEMA_UNSUPPORTED_KEYS = new Set(['$id', 'minLength', 'minimum', 'maximum']);

function strictSafeSchema(value) {
  if (Array.isArray(value)) {
    return value.map((item) => strictSafeSchema(item));
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  const sanitized = {};
  for (const [key, nested] of Object.entries(value)) {
    if (STRICT_SCHEMA_UNSUPPORTED_KEYS.has(key)) {
      continue;
    }
    sanitized[key] = strictSafeSchema(nested);
  }
  return sanitized;
}

export const OPENAI_COMPATIBLE_CHECKPOINT_OUTPUT_SCHEMA = strictSafeSchema(CHECKPOINT_OUTPUT_SCHEMA);

function normalizeBaseUrl(baseUrl) {
  const url = new URL(baseUrl || DEFAULT_BASE_URL);
  url.pathname = url.pathname.replace(/\/$/, '');
  return url.toString().replace(/\/$/, '');
}

function chatCompletionsUrl(baseUrl) {
  const normalized = normalizeBaseUrl(baseUrl);
  return `${normalized}/chat/completions`;
}

function hostFromBaseUrl(baseUrl) {
  try {
    return new URL(normalizeBaseUrl(baseUrl)).host;
  } catch {
    return null;
  }
}

function stripJsonFence(text) {
  const trimmed = String(text || '').trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1].trim() : trimmed;
}

function parseJsonText(text) {
  const stripped = stripJsonFence(text);
  try {
    return { output: JSON.parse(stripped), jsonRecovery: null };
  } catch {
    const start = stripped.indexOf('{');
    const end = stripped.lastIndexOf('}');
    if (start !== -1 && end > start) {
      return { output: JSON.parse(stripped.slice(start, end + 1)), jsonRecovery: 'brace-fallback' };
    }
    throw new Error('openai_compatible provider did not return valid JSON.');
  }
}

function completionText(responseBody) {
  const text = responseBody?.choices?.[0]?.message?.content;
  if (typeof text !== 'string' || !text.trim()) {
    throw new Error('openai_compatible response did not include choices[0].message.content.');
  }
  return text;
}

function responseFormat(format) {
  if (format === 'json_schema') {
    return {
      type: 'json_schema',
      json_schema: {
        name: 'contextforge_checkpoint',
        strict: true,
        schema: OPENAI_COMPATIBLE_CHECKPOINT_OUTPUT_SCHEMA,
      },
    };
  }
  if (format === 'text') {
    return undefined;
  }
  return { type: 'json_object' };
}

function withOpenAiCompatibleIdentity(prompt) {
  return prompt.replace(
    'You are the ContextForge codex_exec distillation provider.',
    'You are the ContextForge openai_compatible distillation provider.',
  );
}

function requestBody({ prompt, model, preset, responseFormatMode, maxTokens }) {
  const body = {
    model,
    messages: [
      {
        role: 'system',
        content:
          'Return only valid JSON for the ContextForge checkpoint schema. Do not include Markdown or commentary.',
      },
      {
        role: 'user',
        content: prompt,
      },
    ],
    stream: false,
  };
  const format = responseFormat(responseFormatMode);
  if (format) body.response_format = format;
  if (maxTokens) body.max_tokens = maxTokens;
  if (preset === 'deepseek' && model === 'deepseek-v4-flash') {
    body.thinking = { type: 'disabled' };
  }
  return body;
}

async function postJson({ fetchImpl, url, apiKey, body, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    const parsed = text ? JSON.parse(text) : {};
    if (!response.ok) {
      throw new Error(parsed?.error?.message || `openai_compatible request failed with HTTP ${response.status}.`);
    }
    return parsed;
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error(`openai_compatible timed out after ${timeoutMs}ms.`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export function createOpenAiCompatibleProvider(options = {}) {
  const fetchInjected = typeof options.fetchImpl === 'function';
  assertExternalProviderAllowed('openai_compatible', { injected: fetchInjected });
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const preset = options.preset || 'deepseek';
  const baseUrl = normalizeBaseUrl(options.baseUrl || DEFAULT_BASE_URL);
  const apiKey = options.apiKey || null;
  const model = options.model || DEFAULT_MODEL;
  const responseFormatMode = options.responseFormat || 'json_object';
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  const maxInputChars = options.maxInputChars || 12000;
  const maxTokens = options.maxTokens || null;

  const providerMetadata = {
    provider: 'openai_compatible',
    preset,
    baseUrlHost: hostFromBaseUrl(baseUrl),
    model,
    responseFormat: responseFormatMode,
    promptVersion: OPENAI_COMPATIBLE_PROMPT_VERSION,
    outputSchemaVersion: CODEX_EXEC_OUTPUT_SCHEMA_VERSION,
  };

  async function distillWithOpenAiCompatibleProvider(input) {
    assertExternalProviderAllowed('openai_compatible', { injected: fetchInjected });
    if (typeof fetchImpl !== 'function') {
      throw new Error('openai_compatible provider requires fetch.');
    }
    if (!apiKey) {
      throw new Error('openai_compatible provider requires an API key.');
    }

    const startedAt = Date.now();
    const builtPrompt = buildCodexExecPrompt(input, { maxInputChars });
    const prompt = withOpenAiCompatibleIdentity(builtPrompt.prompt);
    const url = chatCompletionsUrl(baseUrl);
    const body = requestBody({ prompt, model, preset, responseFormatMode, maxTokens });
    let retryCount = 0;
    let validationFailure = null;
    let responseBody = await postJson({ fetchImpl, url, apiKey, body, timeoutMs });
    let parsed = parseJsonText(completionText(responseBody));

    try {
      validateDistillOutput(parsed.output);
    } catch (error) {
      validationFailure = error.message;
      retryCount = 1;
      const repairBody = {
        ...body,
        messages: [
          ...body.messages,
          {
            role: 'assistant',
            content: JSON.stringify(parsed.output),
          },
          {
            role: 'user',
            content: `The previous JSON failed validation: ${error.message}. Return one corrected JSON object only.`,
          },
        ],
      };
      responseBody = await postJson({ fetchImpl, url, apiKey, body: repairBody, timeoutMs });
      parsed = parseJsonText(completionText(responseBody));
      validateDistillOutput(parsed.output);
    }

    return {
      ...parsed.output,
      provider: parsed.output.provider || 'openai_compatible',
      sourceEventCount: parsed.output.sourceEventCount ?? (input.rawEvents || []).length,
      metadata: {
        ...(parsed.output.metadata || {}),
        openAiCompatible: {
          ...providerMetadata,
          timeoutMs,
          elapsedMs: Date.now() - startedAt,
          retryCount,
          ...(validationFailure ? { validationFailure } : {}),
          ...(parsed.jsonRecovery ? { jsonRecovery: parsed.jsonRecovery } : {}),
          usage: responseBody.usage || null,
          rawEventCount: builtPrompt.metadata.rawEventCount,
          inputTruncated: builtPrompt.metadata.inputTruncated,
          maxInputChars,
        },
      },
    };
  }

  distillWithOpenAiCompatibleProvider.metadata = providerMetadata;
  return distillWithOpenAiCompatibleProvider;
}

export async function checkOpenAiCompatibleProvider(options = {}) {
  const provider = createOpenAiCompatibleProvider(options);
  return {
    ok: true,
    provider: 'openai_compatible',
    preset: options.preset || 'deepseek',
    baseUrlHost: hostFromBaseUrl(options.baseUrl || DEFAULT_BASE_URL),
    model: options.model || DEFAULT_MODEL,
    responseFormat: options.responseFormat || 'json_object',
    live: Boolean(options.live),
    message: options.live
      ? 'openai_compatible live checks run through distillCheckpoint with raw evidence.'
      : 'openai_compatible config is syntactically valid.',
    metadata: provider.metadata,
  };
}
