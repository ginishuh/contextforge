// ESLint runs in CI only. The repository keeps devDependencies at zero, so the
// workflow runs a pinned `npx --yes eslint@10.9.0 .` instead of adding it to
// package.json; npx leaves package.json and package-lock.json untouched. The
// globals below are listed by hand for the same reason: depending on the
// `globals` package would mean a second install.
//
// Rule selection is deliberately narrow. `no-undef`, `no-unused-vars` and
// `no-shadow` are the checks the hand-rolled `scripts/lint-source.js` cannot
// do. `require-await` is intentionally left off: the codebase keeps `async` on
// functions whose signature is part of an awaited API surface even when the
// current body has nothing to await.

const nodeGlobals = {
  AbortController: 'readonly',
  AbortSignal: 'readonly',
  Blob: 'readonly',
  Buffer: 'readonly',
  Event: 'readonly',
  EventTarget: 'readonly',
  File: 'readonly',
  FormData: 'readonly',
  Headers: 'readonly',
  Intl: 'readonly',
  MessageChannel: 'readonly',
  ReadableStream: 'readonly',
  Request: 'readonly',
  Response: 'readonly',
  TextDecoder: 'readonly',
  TextEncoder: 'readonly',
  TransformStream: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  WritableStream: 'readonly',
  atob: 'readonly',
  btoa: 'readonly',
  clearImmediate: 'readonly',
  clearInterval: 'readonly',
  clearTimeout: 'readonly',
  console: 'readonly',
  crypto: 'readonly',
  fetch: 'readonly',
  global: 'readonly',
  globalThis: 'readonly',
  navigator: 'readonly',
  performance: 'readonly',
  process: 'readonly',
  queueMicrotask: 'readonly',
  setImmediate: 'readonly',
  setInterval: 'readonly',
  setTimeout: 'readonly',
  structuredClone: 'readonly',
};

const browserGlobals = {
  AbortController: 'readonly',
  Blob: 'readonly',
  CustomEvent: 'readonly',
  DOMParser: 'readonly',
  Element: 'readonly',
  Event: 'readonly',
  EventSource: 'readonly',
  EventTarget: 'readonly',
  File: 'readonly',
  FileReader: 'readonly',
  FormData: 'readonly',
  HTMLElement: 'readonly',
  Headers: 'readonly',
  Image: 'readonly',
  IntersectionObserver: 'readonly',
  MutationObserver: 'readonly',
  Node: 'readonly',
  Request: 'readonly',
  ResizeObserver: 'readonly',
  Response: 'readonly',
  TextDecoder: 'readonly',
  TextEncoder: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  WebSocket: 'readonly',
  XMLHttpRequest: 'readonly',
  alert: 'readonly',
  atob: 'readonly',
  btoa: 'readonly',
  cancelAnimationFrame: 'readonly',
  clearInterval: 'readonly',
  clearTimeout: 'readonly',
  confirm: 'readonly',
  console: 'readonly',
  crypto: 'readonly',
  document: 'readonly',
  fetch: 'readonly',
  getComputedStyle: 'readonly',
  history: 'readonly',
  localStorage: 'readonly',
  location: 'readonly',
  matchMedia: 'readonly',
  navigator: 'readonly',
  performance: 'readonly',
  prompt: 'readonly',
  requestAnimationFrame: 'readonly',
  sessionStorage: 'readonly',
  setInterval: 'readonly',
  setTimeout: 'readonly',
  structuredClone: 'readonly',
  window: 'readonly',
};

const rules = {
  'no-undef': 'error',
  'no-unused-vars': [
    'error',
    {
      args: 'after-used',
      argsIgnorePattern: '^_',
      varsIgnorePattern: '^_',
      caughtErrorsIgnorePattern: '^_',
      ignoreRestSiblings: true,
    },
  ],
  // `createContextForge(options = {})` deliberately shadows the outer `options`
  // in dozens of inner helpers; that closure shape is the module's design.
  'no-shadow': ['error', { allow: ['options'] }],
};

export default [
  {
    ignores: ['node_modules/**', 'artifacts/**', 'docs/**', 'evals/**', 'examples/**'],
  },
  {
    files: ['src/**/*.js', 'scripts/**/*.js', 'test/**/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: nodeGlobals,
    },
    rules,
  },
  {
    files: ['src/admin-ui/**/*.js'],
    languageOptions: {
      globals: browserGlobals,
    },
  },
];
