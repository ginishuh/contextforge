export function createEmbeddingProvider(config, providers = {}, { fetchImpl = globalThis.fetch } = {}) {
  const embeddingConfig = config.embeddings || {};
  if (providers[embeddingConfig.provider]) {
    return providers[embeddingConfig.provider];
  }
  if (embeddingConfig.provider === 'none') {
    return null;
  }
  if (embeddingConfig.provider === 'openai') {
    return createOpenAiEmbeddingProvider(embeddingConfig, { fetchImpl });
  }
  throw new Error(`Unknown embeddings provider: ${embeddingConfig.provider}`);
}

function timeoutSignal(timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    clear: () => clearTimeout(timer),
  };
}

function normalizeEmbedding(value, expectedDimensions) {
  if (!Array.isArray(value)) {
    throw new Error('Embedding provider returned a non-array embedding.');
  }
  const embedding = value.map((item) => Number(item));
  if (!embedding.every(Number.isFinite)) {
    throw new Error('Embedding provider returned non-numeric embedding values.');
  }
  if (expectedDimensions && embedding.length !== expectedDimensions) {
    throw new Error(`Embedding provider returned ${embedding.length} dimensions; expected ${expectedDimensions}.`);
  }
  return embedding;
}

function supportsDimensionsParameter(model) {
  return String(model || '').startsWith('text-embedding-3-');
}

export function createOpenAiEmbeddingProvider(config, { fetchImpl = globalThis.fetch } = {}) {
  if (!config.apiKey) {
    throw new Error('OpenAI embeddings require CONTEXTFORGE_OPENAI_API_KEY or OPENAI_API_KEY.');
  }
  if (typeof fetchImpl !== 'function') {
    throw new Error('OpenAI embeddings require a fetch implementation.');
  }

  return {
    name: 'openai',
    model: config.model,
    dimensions: config.dimensions,
    async embed(texts) {
      const input = Array.isArray(texts) ? texts : [texts];
      if (input.length === 0) {
        return [];
      }
      const timeout = timeoutSignal(config.timeoutMs);
      try {
        const body = {
          model: config.model,
          input,
          encoding_format: 'float',
        };
        if (supportsDimensionsParameter(config.model)) {
          body.dimensions = config.dimensions;
        }
        const response = await fetchImpl(`${config.baseUrl.replace(/\/$/, '')}/embeddings`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${config.apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(body),
          signal: timeout.signal,
        });
        if (!response.ok) {
          const body = await response.text().catch(() => '');
          throw new Error(`OpenAI embeddings request failed with HTTP ${response.status}: ${body.slice(0, 240)}`);
        }
        const payload = await response.json();
        const rows = Array.isArray(payload.data) ? payload.data : [];
        if (rows.length !== input.length) {
          throw new Error(`OpenAI embeddings returned ${rows.length} row(s); expected ${input.length}.`);
        }
        return rows
          .sort((a, b) => a.index - b.index)
          .map((row) => normalizeEmbedding(row.embedding, config.dimensions));
      } finally {
        timeout.clear();
      }
    },
  };
}
