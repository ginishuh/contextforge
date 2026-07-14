import assert from 'node:assert/strict';
import test from 'node:test';
import { REMOTE_METHOD_CAPABILITIES, TOKEN_CAPABILITIES } from '../../src/auth/token_authorization.js';
import {
  ALL_MCP_TOOL_NAMES,
  createContextForgeMcpServer,
  getContextForgeMcpSurfaceInfo,
} from '../../src/mcp.js';
import {
  MCP_OPERATION_TOOL_NAMES,
  OPERATION_REGISTRY,
  operationByMcpTool,
  operationByName,
  OPTIONALLY_SCOPED_REMOTE_OPERATION_NAMES,
  REMOTE_OPERATION_NAMES,
  UNSCOPED_REMOTE_OPERATION_NAMES,
} from '../../src/operations/registry.js';
import { REMOTE_METHODS } from '../../src/remote/client.js';
import { SQLITE_MIGRATIONS } from '../../src/storage/migrations/index.js';
import { SCHEMA_VERSION } from '../../src/storage/sqlite.js';

test('operation registry is the canonical remote and authorization contract', () => {
  assert.equal(OPERATION_REGISTRY.length, 83);
  assert.equal(new Set(REMOTE_OPERATION_NAMES).size, REMOTE_OPERATION_NAMES.length);
  assert.deepEqual(REMOTE_METHODS, REMOTE_OPERATION_NAMES);
  assert.deepEqual(Object.keys(REMOTE_METHOD_CAPABILITIES), REMOTE_OPERATION_NAMES);
  assert.deepEqual(
    OPERATION_REGISTRY.map((operation) => operation.capability),
    REMOTE_OPERATION_NAMES.map((name) => REMOTE_METHOD_CAPABILITIES[name]),
  );
  for (const operation of OPERATION_REGISTRY) {
    assert.equal(operationByName(operation.name), operation);
    assert.ok(TOKEN_CAPABILITIES.includes(operation.capability));
    assert.ok(['process', 'all', 'workspace', 'optional', 'migration', 'scoped'].includes(operation.scopeMode));
    assert.ok(['unscoped', 'optional', 'scoped'].includes(operation.remoteDispatch));
  }
  assert.deepEqual(
    UNSCOPED_REMOTE_OPERATION_NAMES,
    OPERATION_REGISTRY.filter((operation) => operation.remoteDispatch === 'unscoped').map(
      (operation) => operation.name,
    ),
  );
  assert.deepEqual(
    OPTIONALLY_SCOPED_REMOTE_OPERATION_NAMES,
    OPERATION_REGISTRY.filter((operation) => operation.remoteDispatch === 'optional').map(
      (operation) => operation.name,
    ),
  );
});

test('MCP tool dispatch and read-only annotations come from the operation registry', async () => {
  assert.deepEqual(ALL_MCP_TOOL_NAMES, MCP_OPERATION_TOOL_NAMES);
  const app = new Proxy(
    { config: {} },
    {
      get(target, property, receiver) {
        if (Reflect.has(target, property)) return Reflect.get(target, property, receiver);
        return async () => ({});
      },
    },
  );
  const server = createContextForgeMcpServer({ app, profile: 'all' });
  try {
    const surface = getContextForgeMcpSurfaceInfo(server);
    assert.equal(surface.toolCount, MCP_OPERATION_TOOL_NAMES.length);
    assert.deepEqual(surface.tools.map((tool) => tool.name), MCP_OPERATION_TOOL_NAMES);
    for (const tool of surface.tools) {
      const operation = operationByMcpTool(tool.name);
      assert.ok(operation, `Missing registry operation for ${tool.name}`);
      assert.equal(tool.operation, operation.name);
      assert.equal(tool.annotations.readOnlyHint, operation.mcp.annotations.readOnlyHint);
    }
  } finally {
    await server.close().catch(() => {});
  }
});

test('SQLite compatibility migrations have unique ordered versioned manifests', () => {
  const versions = SQLITE_MIGRATIONS.map((migration) => migration.version);
  assert.equal(new Set(versions).size, versions.length);
  assert.deepEqual(versions, [...versions].sort((left, right) => left - right));
  assert.equal(versions.at(-1), SCHEMA_VERSION);
  for (const migration of SQLITE_MIGRATIONS) {
    assert.match(migration.id, /^v\d+-/);
    assert.ok(migration.columns.length > 0);
  }
});
