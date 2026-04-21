import { distillWithMockProvider } from './providers/mock.js';

export function createDistillProvider(name) {
  if (name === 'mock') {
    return {
      name,
      distill: distillWithMockProvider,
    };
  }

  throw new Error(`Unsupported distill provider "${name}". Available providers: mock.`);
}
