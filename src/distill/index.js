import { distillWithMockProvider } from './providers/mock.js';

export function createDistillProvider(name, overrides = {}) {
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

  throw new Error(`Unsupported distill provider "${name}". Available providers: mock.`);
}
