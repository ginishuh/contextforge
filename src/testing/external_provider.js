export class ExternalProviderDisabledInTestError extends Error {
  constructor(provider) {
    super(
      `External provider "${provider}" is disabled during normal tests. ` +
        'Inject a fake runner/fetch implementation, or use npm run test:live with CONTEXTFORGE_LIVE_TESTS=true.',
    );
    this.name = 'ExternalProviderDisabledInTestError';
    this.code = 'CONTEXTFORGE_EXTERNAL_PROVIDER_DISABLED_IN_TEST';
    this.provider = provider;
  }
}

export function externalProvidersAllowed(env = process.env) {
  return env.CONTEXTFORGE_TEST_MODE !== 'true' || env.CONTEXTFORGE_LIVE_TESTS === 'true';
}

export function assertExternalProviderAllowed(provider, { injected = false, env = process.env } = {}) {
  if (injected || externalProvidersAllowed(env)) return;
  throw new ExternalProviderDisabledInTestError(provider);
}
