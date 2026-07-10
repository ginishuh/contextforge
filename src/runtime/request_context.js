import { AsyncLocalStorage } from 'node:async_hooks';

const requestContext = new AsyncLocalStorage();

export function runWithRequestContext(context, callback) {
  return requestContext.run(Object.freeze({ ...context }), callback);
}

export function currentRequestContext() {
  return requestContext.getStore() || null;
}
