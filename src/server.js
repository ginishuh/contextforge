#!/usr/bin/env node
import http from 'node:http';
import { createContextForge } from './core.js';
import { REMOTE_METHODS } from './remote/client.js';

const METHOD_SET = new Set(REMOTE_METHODS);
const MAX_BODY_BYTES = 1024 * 1024;

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, {
    'content-type': 'application/json',
  });
  response.end(`${JSON.stringify(body, null, 2)}\n`);
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let body = '';
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Request body is too large.'));
        request.destroy();
        return;
      }
      body += chunk.toString();
    });
    request.on('error', reject);
    request.on('end', () => {
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

function isAuthorized(request, token) {
  if (!token) return true;
  return request.headers.authorization === `Bearer ${token}`;
}

function serverStorageEnv(env) {
  const storageMode = env.CONTEXTFORGE_SERVER_STORAGE_MODE || env.CONTEXTFORGE_STORAGE_MODE;
  return {
    ...env,
    CONTEXTFORGE_STORAGE_MODE: storageMode === 'remote' || !storageMode ? 'project-local' : storageMode,
  };
}

export function createContextForgeServer({ app, env = process.env } = {}) {
  const serverApp = app || createContextForge({ env: serverStorageEnv(env) });
  const authToken = env.CONTEXTFORGE_REMOTE_TOKEN || null;

  return http.createServer(async (request, response) => {
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
      const options = await readJsonBody(request);
      const result = await serverApp[method](options);
      sendJson(response, 200, { result });
    } catch (error) {
      sendJson(response, 500, {
        error: {
          message: error.message,
          name: error.name,
        },
      });
    }
  });
}

export function startContextForgeServer({ host = '127.0.0.1', port = 8765, env = process.env, app } = {}) {
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
              if (error) closeReject(error);
              else closeResolve();
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

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file:').href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
