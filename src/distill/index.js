import { distillWithMockProvider } from './providers/mock.js';
import { createCodexExecProvider } from './providers/codex_exec.js';

export function createDistillProvider(name, overrides = {}, options = {}) {
  if (overrides[name]) {
    return {
      name,
      distill: overrides[name],
    };
  }

  if (name === 'mock') {
    return {
      name,
      distill: distillWithMockProvider,
    };
  }

  if (name === 'codex_exec') {
    return {
      name,
      distill: createCodexExecProvider(options.codexExec),
    };
  }

  throw new Error(`Unsupported distill provider "${name}". Available providers: mock, codex_exec.`);
}
