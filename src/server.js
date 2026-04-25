#!/usr/bin/env node
import crypto from 'node:crypto';
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { createContextForge } from './core.js';
import { REMOTE_METHODS } from './remote/client.js';

const METHOD_SET = new Set(REMOTE_METHODS);
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

class RequestBodyTooLargeError extends Error {
  constructor() {
    super('Request body is too large.');
    this.name = 'RequestBodyTooLargeError';
    this.statusCode = 413;
  }
}

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, {
    'content-type': 'application/json',
  });
  response.end(`${JSON.stringify(body, null, 2)}\n`);
}

function parseMaxBodyBytes(env) {
  const value = env.CONTEXTFORGE_REMOTE_MAX_BODY_BYTES;
  if (value == null || value === '') {
    return DEFAULT_MAX_BODY_BYTES;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error('CONTEXTFORGE_REMOTE_MAX_BODY_BYTES must be a positive integer.');
  }
  return parsed;
}

function readJsonBody(request, { maxBodyBytes = DEFAULT_MAX_BODY_BYTES } = {}) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let body = '';
    let tooLarge = false;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBodyBytes) {
        if (tooLarge) return;
        tooLarge = true;
        reject(new RequestBodyTooLargeError());
        return;
      }
      body += chunk.toString();
    });
    request.on('error', reject);
    request.on('end', () => {
      if (tooLarge) {
        return;
      }
      if (!body.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error('Request body must be valid JSON.'));
      }
    });
  });
}

function isLoopbackHost(host) {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
}

function timingSafeStringEqual(actual, expected) {
  const actualBuffer = Buffer.from(String(actual || ''));
  const expectedBuffer = Buffer.from(String(expected || ''));
  const maxLength = Math.max(actualBuffer.length, expectedBuffer.length, 1);
  const paddedActual = Buffer.alloc(maxLength);
  const paddedExpected = Buffer.alloc(maxLength);
  actualBuffer.copy(paddedActual);
  expectedBuffer.copy(paddedExpected);
  return crypto.timingSafeEqual(paddedActual, paddedExpected) && actualBuffer.length === expectedBuffer.length;
}

function isAuthorized(request, token) {
  if (!token) return true;
  return timingSafeStringEqual(request.headers.authorization, `Bearer ${token}`);
}

function serverStorageEnv(env) {
  const storageMode = env.CONTEXTFORGE_SERVER_STORAGE_MODE || env.CONTEXTFORGE_STORAGE_MODE;
  return {
    ...env,
    CONTEXTFORGE_STORAGE_MODE: storageMode === 'remote' || !storageMode ? 'project-local' : storageMode,
  };
}

export function createContextForgeServer({ app, env = process.env } = {}) {
  const serverApp = app || createContextForge({ env: serverStorageEnv(env), reuseStore: true });
  const authToken = env.CONTEXTFORGE_REMOTE_TOKEN || null;
  const maxBodyBytes = parseMaxBodyBytes(env);

  const server = http.createServer(async (request, response) => {
    const requestUrl = new URL(request.url, 'http://localhost');

    if (request.method === 'GET' && requestUrl.pathname === '/healthz') {
      sendJson(response, 200, { ok: true });
      return;
    }

    if (request.method !== 'POST' || !requestUrl.pathname.startsWith('/v0/')) {
      sendJson(response, 404, { error: { message: 'Not found.' } });
      return;
    }

    if (!isAuthorized(request, authToken)) {
      sendJson(response, 401, { error: { message: 'Unauthorized.' } });
      return;
    }

    const method = requestUrl.pathname.slice('/v0/'.length);
    if (!METHOD_SET.has(method) || typeof serverApp[method] !== 'function') {
      sendJson(response, 404, { error: { message: `Unknown method: ${method}` } });
      return;
    }

    try {
      const options = await readJsonBody(request, { maxBodyBytes });
      const result = await serverApp[method](options);
      sendJson(response, 200, { result });
    } catch (error) {
      sendJson(response, error.statusCode || 500, {
        error: {
          message: error.message,
          name: error.name,
        },
      });
    }
  });
  server.closeContextForge = () => {
    if (typeof serverApp.close === 'function') {
      serverApp.close();
    }
  };
  return server;
}

export function startContextForgeServer({ host = '127.0.0.1', port = 8765, env = process.env, app } = {}) {
  if (!env.CONTEXTFORGE_REMOTE_TOKEN && !isLoopbackHost(host)) {
    throw new Error('CONTEXTFORGE_REMOTE_TOKEN is required when binding ContextForge remote server to a non-loopback host.');
  }
  if (!env.CONTEXTFORGE_REMOTE_TOKEN) {
    console.error('Warning: CONTEXTFORGE_REMOTE_TOKEN is not set; remote API is unauthenticated on loopback only.');
  }
  const server = createContextForgeServer({ app, env });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const address = server.address();
      resolve({
        server,
        host,
        port: address.port,
        url: `http://${host}:${address.port}`,
        close: () =>
          new Promise((closeResolve, closeReject) => {
            server.close((error) => {
              try {
                if (server.closeContextForge) {
                  server.closeContextForge();
                }
              } finally {
                if (error) closeReject(error);
                else closeResolve();
              }
            });
          }),
      });
    });
  });
}

async function main() {
  const port = Number(process.env.CONTEXTFORGE_REMOTE_PORT || 8765);
  const host = process.env.CONTEXTFORGE_REMOTE_HOST || '127.0.0.1';
  const instance = await startContextForgeServer({ host, port });
  console.log(JSON.stringify({ listening: instance.url }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
