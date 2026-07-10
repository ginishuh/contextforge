#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createContextForge } from './core.js';
import { createContextForgeMcpServer } from './mcp.js';
import { REMOTE_METHODS } from './remote/client.js';

const METHOD_SET = new Set(REMOTE_METHODS);
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
const UI_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'admin-ui');
const DEFAULT_ADMIN_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const DEFAULT_ADMIN_LOGIN_WINDOW_MS = 15 * 60 * 1000;
const DEFAULT_ADMIN_LOGIN_MAX_FAILURES = 5;
const DEFAULT_ADMIN_LOGIN_MAX_KEYS = 10000;
const ADMIN_COOKIE_NAME = 'contextforge_admin';
const UI_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

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

async function sendStaticUi(requestUrl, response) {
  const pathname = requestUrl.pathname;
  let relative;
  try {
    relative = pathname === '/ui/' ? 'index.html' : decodeURIComponent(pathname.slice('/ui/'.length));
  } catch {
    sendJson(response, 404, { error: { message: 'Not found.' } });
    return;
  }
  const safePath = path.normalize(relative);
  const filePath = path.join(UI_DIR, safePath);
  const fileRelative = path.relative(UI_DIR, filePath);
  if (fileRelative.startsWith('..') || path.isAbsolute(fileRelative)) {
    sendJson(response, 404, { error: { message: 'Not found.' } });
    return;
  }
  try {
    const content = await fs.readFile(filePath);
    response.writeHead(200, {
      'content-type': UI_TYPES[path.extname(filePath)] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    response.end(content);
  } catch (error) {
    if (error.code === 'ENOENT') {
      sendJson(response, 404, { error: { message: 'Not found.' } });
      return;
    }
    sendJson(response, 500, { error: { message: error.message } });
  }
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

function originMatchesHost(request) {
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === request.headers.host;
  } catch {
    return false;
  }
}

function parseAdminCookieSecureMode(value) {
  if (value == null || value === '') return 'auto';
  const normalized = String(value).trim().toLowerCase();
  if (['true', '1', 'yes'].includes(normalized)) return 'always';
  if (['false', '0', 'no'].includes(normalized)) return 'never';
  if (normalized === 'auto') return 'auto';
  throw new Error('CONTEXTFORGE_ADMIN_COOKIE_SECURE must be true, false, or auto.');
}

function normalizeIpAddress(value) {
  const address = String(value || '').trim().split('%')[0];
  return net.isIP(address) ? address : null;
}

function parseTrustedProxy(value) {
  const trustedProxy = new net.BlockList();
  if (value == null || String(value).trim() === '') return trustedProxy;
  const normalized = String(value).trim().toLowerCase();
  if (['false', '0', 'no', 'off'].includes(normalized)) return trustedProxy;
  const entries = ['true', '1', 'yes', 'on'].includes(normalized)
    ? ['0.0.0.0/0', '::/0']
    : normalized.split(',').map((entry) => entry.trim()).filter(Boolean);
  const expanded = entries.flatMap((entry) =>
    entry === 'loopback' ? ['127.0.0.0/8', '::1/128'] : [entry],
  );
  for (const entry of expanded) {
    const parts = entry.split('/');
    const address = normalizeIpAddress(parts[0]);
    if (!address || parts.length > 2) {
      throw new Error(`CONTEXTFORGE_TRUST_PROXY contains an invalid IP or CIDR: ${entry}`);
    }
    const family = net.isIP(address) === 4 ? 'ipv4' : 'ipv6';
    const maximumPrefix = family === 'ipv4' ? 32 : 128;
    const prefix = parts[1] == null ? maximumPrefix : Number(parts[1]);
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > maximumPrefix) {
      throw new Error(`CONTEXTFORGE_TRUST_PROXY contains an invalid CIDR prefix: ${entry}`);
    }
    trustedProxy.addSubnet(address, prefix, family);
  }
  return trustedProxy;
}

function proxyIsTrusted(address, trustedProxy) {
  const normalized = normalizeIpAddress(address);
  if (!normalized) return false;
  const family = net.isIP(normalized) === 4 ? 'ipv4' : 'ipv6';
  return trustedProxy.check(normalized, family);
}

function socketPeerAddress(request) {
  return normalizeIpAddress(request.socket.remoteAddress) || '';
}

function requestIsSecure(request, trustedProxy) {
  if (request.socket.encrypted) return true;
  if (!proxyIsTrusted(socketPeerAddress(request), trustedProxy)) return false;
  const forwardedProto = String(request.headers['x-forwarded-proto'] || '')
    .split(',')[0]
    .trim()
    .toLowerCase();
  if (forwardedProto) return forwardedProto === 'https';
  return false;
}

function adminCookieSecureForRequest(request, mode, trustedProxy) {
  if (mode === 'always') return true;
  if (mode === 'never') return false;
  return requestIsSecure(request, trustedProxy);
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function makeCookie(name, value, { maxAge = null, secure = true } = {}) {
  return [
    `${name}=${encodeURIComponent(value)}`,
    'HttpOnly',
    'SameSite=Strict',
    'Path=/',
    secure ? 'Secure' : null,
    maxAge == null ? null : `Max-Age=${maxAge}`,
  ]
    .filter(Boolean)
    .join('; ');
}

function parseAdminPasswordHash(env) {
  if (!env.CONTEXTFORGE_ADMIN_USER) {
    return null;
  }
  const pbkdf2 = env.CONTEXTFORGE_ADMIN_PASSWORD_PBKDF2;
  if (!pbkdf2) {
    throw new Error('CONTEXTFORGE_ADMIN_PASSWORD_PBKDF2 is required when CONTEXTFORGE_ADMIN_USER is set.');
  }
  const [iterationsText, saltHex, hashHex] = String(pbkdf2).split(':');
  const iterations = Number(iterationsText);
  if (!Number.isInteger(iterations) || iterations < 100000 || !saltHex || !hashHex) {
    throw new Error(
      'CONTEXTFORGE_ADMIN_PASSWORD_PBKDF2 must use format iterations:saltHex:hashHex with at least 100000 iterations.',
    );
  }
  return {
    iterations,
    salt: Buffer.from(saltHex, 'hex'),
    hash: Buffer.from(hashHex, 'hex'),
  };
}

function verifyAdminPassword(password, passwordHash) {
  if (!passwordHash) return false;
  const derived = crypto.pbkdf2Sync(
    String(password || ''),
    passwordHash.salt,
    passwordHash.iterations,
    passwordHash.hash.length,
    'sha256',
  );
  return crypto.timingSafeEqual(derived, passwordHash.hash);
}

function requestIp(request, trustedProxy) {
  let address = socketPeerAddress(request);
  if (!proxyIsTrusted(address, trustedProxy)) return address;
  const rawForwardedAddresses = String(request.headers['x-forwarded-for'] || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  const forwardedAddresses = rawForwardedAddresses.map((entry) => normalizeIpAddress(entry));
  if (forwardedAddresses.some((entry) => !entry)) return address;
  for (let index = forwardedAddresses.length - 1; index >= 0; index -= 1) {
    if (!proxyIsTrusted(address, trustedProxy)) break;
    address = forwardedAddresses[index];
  }
  return address;
}

function parseCookies(request) {
  const cookies = {};
  for (const item of String(request.headers.cookie || '')
    .split(';')
    .map((cookie) => cookie.trim())
    .filter(Boolean)) {
    try {
        const index = item.indexOf('=');
      const key = index === -1 ? item : item.slice(0, index);
      const value = index === -1 ? '' : decodeURIComponent(item.slice(index + 1));
      cookies[key] = value;
    } catch {
      // Ignore malformed cookies instead of turning auth checks into 500s.
    }
  }
  return cookies;
}

function getAdminSessionEntry(request, sessions) {
  const session = parseCookies(request)[ADMIN_COOKIE_NAME];
  const entry = session ? sessions.get(session) : null;
  if (!entry) return false;
  if (Date.now() > entry.expiresAt) {
    sessions.delete(session);
    return null;
  }
  return entry;
}

function isAdminSessionAuthorized(request, sessions) {
  const entry = getAdminSessionEntry(request, sessions);
  return Boolean(entry);
}

function isRequestAuthorized(request, token, sessions) {
  return isAuthorized(request, token) || (originMatchesHost(request) && isAdminSessionAuthorized(request, sessions));
}

function connectionServerRole(connection) {
  return connection?.serverRole || connection?.server?.processRole || connection?.processRole || connection?.mode || null;
}

function remoteAccessConnection(serverConnection, transport) {
  const serverRole = connectionServerRole(serverConnection);
  return {
    mode: 'remote-client',
    accessMode: 'remote-client',
    accessPath: transport,
    transport,
    viewpoint: 'this caller reaches ContextForge through a remote HTTP endpoint',
    storageMode: 'remote',
    storageAuthority: 'canonical',
    serverRole,
    server: serverConnection || null,
    note: 'This response crossed a ContextForge HTTP boundary. server.storageMode describes the server-owned store.',
    summary: `remote-client over ${transport}${serverRole ? ` to ${serverRole}` : ''}`,
  };
}

function wrapRemoteAccessResult(result, transport) {
  if (!result || typeof result !== 'object') {
    return result;
  }
  let wrapped = result;
  if (result.connection) {
    wrapped = {
      ...wrapped,
      connection: remoteAccessConnection(result.connection, transport),
    };
  }
  if (wrapped.storage?.connection) {
    wrapped = {
      ...wrapped,
      storage: {
        ...wrapped.storage,
        connection: remoteAccessConnection(wrapped.storage.connection, transport),
      },
    };
  }
  return wrapped;
}

function createRemoteAccessApp(app, transport) {
  return new Proxy(app, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== 'function') {
        return value;
      }
      return async (...args) => wrapRemoteAccessResult(await value.apply(target, args), transport);
    },
  });
}

function serverStorageEnv(env) {
  const storageMode = env.CONTEXTFORGE_SERVER_STORAGE_MODE || env.CONTEXTFORGE_STORAGE_MODE;
  return {
    ...env,
    CONTEXTFORGE_STORAGE_MODE: storageMode === 'remote' || !storageMode ? 'project-local' : storageMode,
    CONTEXTFORGE_RUNTIME_ROLE: 'http-server',
  };
}

export function createContextForgeServer({ app, env = process.env } = {}) {
  const serverApp = app || createContextForge({ env: serverStorageEnv(env), reuseStore: true });
  const authToken = env.CONTEXTFORGE_REMOTE_TOKEN || null;
  const maxBodyBytes = parseMaxBodyBytes(env);
  const adminUser = env.CONTEXTFORGE_ADMIN_USER || null;
  const adminPasswordHash = parseAdminPasswordHash(env);
  const adminSessionTtlMs = parsePositiveInteger(env.CONTEXTFORGE_ADMIN_SESSION_TTL_MS, DEFAULT_ADMIN_SESSION_TTL_MS);
  const adminLoginWindowMs = parsePositiveInteger(
    env.CONTEXTFORGE_ADMIN_LOGIN_WINDOW_MS,
    DEFAULT_ADMIN_LOGIN_WINDOW_MS,
  );
  const adminLoginMaxFailures = parsePositiveInteger(
    env.CONTEXTFORGE_ADMIN_LOGIN_MAX_FAILURES,
    DEFAULT_ADMIN_LOGIN_MAX_FAILURES,
  );
  const adminLoginMaxKeys = parsePositiveInteger(
    env.CONTEXTFORGE_ADMIN_LOGIN_MAX_KEYS,
    DEFAULT_ADMIN_LOGIN_MAX_KEYS,
  );
  const adminCookieSecureMode = parseAdminCookieSecureMode(env.CONTEXTFORGE_ADMIN_COOKIE_SECURE);
  const trustedProxy = parseTrustedProxy(env.CONTEXTFORGE_TRUST_PROXY);
  const adminSessions = new Map();
  const failedAdminLogins = new Map();

  function pruneAdminSessions(now = Date.now()) {
    for (const [session, entry] of adminSessions.entries()) {
      if (now > entry.expiresAt) {
        adminSessions.delete(session);
      }
    }
  }

  function loginAttemptKey(request, username) {
    const usernameHash = crypto.createHash('sha256').update(String(username || '')).digest('hex');
    return `${requestIp(request, trustedProxy)}:${usernameHash}`;
  }

  function pruneFailedAdminLogins(now = Date.now()) {
    for (const [key, entry] of failedAdminLogins.entries()) {
      if (now > entry.resetAt) failedAdminLogins.delete(key);
    }
  }

  function loginAllowed(key, now = Date.now()) {
    pruneFailedAdminLogins(now);
    const entry = failedAdminLogins.get(key);
    if (!entry) return failedAdminLogins.size < adminLoginMaxKeys;
    return entry.count < adminLoginMaxFailures;
  }

  function recordFailedLogin(key, now = Date.now()) {
    pruneFailedAdminLogins(now);
    const entry = failedAdminLogins.get(key);
    if (!entry) {
      if (failedAdminLogins.size >= adminLoginMaxKeys) return false;
      failedAdminLogins.set(key, { count: 1, resetAt: now + adminLoginWindowMs });
      return true;
    }
    entry.count += 1;
    return true;
  }

  const server = http.createServer(async (request, response) => {
    const requestUrl = new URL(request.url, 'http://localhost');

    if (request.method === 'GET' && requestUrl.pathname === '/healthz') {
      sendJson(response, 200, { ok: true });
      return;
    }

    if (request.method === 'GET' && requestUrl.pathname === '/ui/session') {
      const entry = originMatchesHost(request) ? getAdminSessionEntry(request, adminSessions) : null;
      if (!entry) {
        sendJson(response, 401, { ok: false });
        return;
      }
      response.writeHead(200, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
      });
      response.end(`${JSON.stringify({ ok: true, username: adminUser || '관리자' })}\n`);
      return;
    }

    if (request.method === 'POST' && requestUrl.pathname === '/ui/login') {
      try {
        if (!adminUser || !adminPasswordHash) {
          sendJson(response, 403, { error: { message: 'Admin login is not configured.' } });
          return;
        }
        const body = await readJsonBody(request, { maxBodyBytes });
        const attemptKey = loginAttemptKey(request, body.username);
        if (!loginAllowed(attemptKey)) {
          sendJson(response, 429, { error: { message: 'Too many failed login attempts.' } });
          return;
        }
        const ok =
          timingSafeStringEqual(body.username, adminUser) &&
          verifyAdminPassword(body.password, adminPasswordHash);
        if (!ok) {
          recordFailedLogin(attemptKey);
          sendJson(response, 401, { error: { message: 'Invalid login.' } });
          return;
        }
        failedAdminLogins.delete(attemptKey);
        pruneAdminSessions();
        const session = crypto.randomBytes(32).toString('hex');
        adminSessions.set(session, { createdAt: Date.now(), expiresAt: Date.now() + adminSessionTtlMs });
        response.writeHead(200, {
          'content-type': 'application/json',
          'cache-control': 'no-store',
          'set-cookie': makeCookie(ADMIN_COOKIE_NAME, session, {
            maxAge: Math.ceil(adminSessionTtlMs / 1000),
            secure: adminCookieSecureForRequest(request, adminCookieSecureMode, trustedProxy),
          }),
        });
        response.end(`${JSON.stringify({ ok: true })}\n`);
      } catch (error) {
        sendJson(response, error.statusCode || 500, { error: { message: error.message, name: error.name } });
      }
      return;
    }

    if (request.method === 'POST' && requestUrl.pathname === '/ui/logout') {
      const session = parseCookies(request)[ADMIN_COOKIE_NAME];
      if (session) adminSessions.delete(session);
      response.writeHead(200, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
        'set-cookie': makeCookie(ADMIN_COOKIE_NAME, '', {
          maxAge: 0,
          secure: adminCookieSecureForRequest(request, adminCookieSecureMode, trustedProxy),
        }),
      });
      response.end('{"ok":true}\n');
      return;
    }

    if (request.method === 'GET' && requestUrl.pathname === '/favicon.ico') {
      response.writeHead(204, { 'cache-control': 'no-store' });
      response.end();
      return;
    }

    if (request.method === 'GET' && requestUrl.pathname === '/ui') {
      response.writeHead(308, {
        location: `/ui/${requestUrl.search}`,
        'cache-control': 'no-store',
      });
      response.end();
      return;
    }

    if (request.method === 'GET' && requestUrl.pathname.startsWith('/ui/')) {
      await sendStaticUi(requestUrl, response);
      return;
    }

    if (requestUrl.pathname === '/mcp') {
      if (!isRequestAuthorized(request, authToken, adminSessions)) {
        sendJson(response, 401, { error: { message: 'Unauthorized.' } });
        return;
      }
      const mcpServer = createContextForgeMcpServer({
        app: createRemoteAccessApp(serverApp, 'http-mcp'),
        env,
      });
      try {
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
        });
        await mcpServer.connect(transport);
        await transport.handleRequest(request, response);
        response.on('close', () => {
          transport.close();
          mcpServer.close();
        });
      } catch (error) {
        if (!response.headersSent) {
          sendJson(response, 500, {
            jsonrpc: '2.0',
            error: {
              code: -32603,
              message: error.message,
            },
            id: null,
          });
        }
      }
      return;
    }

    if (request.method !== 'POST' || !requestUrl.pathname.startsWith('/v0/')) {
      sendJson(response, 404, { error: { message: 'Not found.' } });
      return;
    }

    if (!isRequestAuthorized(request, authToken, adminSessions)) {
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
      sendJson(response, 200, { result: wrapRemoteAccessResult(result, 'http-api') });
    } catch (error) {
      sendJson(response, error.statusCode || 500, {
        error: {
          message: error.message,
          name: error.name,
          code: error.code,
          warnings: error.warnings,
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
