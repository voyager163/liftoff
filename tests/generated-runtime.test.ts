import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildProjectPlan } from '../src/planner.js';
import { buildArtifacts } from '../src/templates.js';

const root = path.resolve('tests', '.generated-runtime', randomUUID());
const python = process.env.LIFTOFF_TEST_PYTHON ?? 'python3';
const pythonSettingsAvailable = spawnSync(python, ['-c', 'import pydantic_settings'], { encoding: 'utf8' }).status === 0;
const pythonAvailable = spawnSync(python, ['-c', 'import pydantic_settings, pydantic_ai, fastapi'], { encoding: 'utf8' }).status === 0;
const goAvailable = spawnSync('go', ['version'], { encoding: 'utf8' }).status === 0;
const composeAvailable = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8' }).status === 0;
const run = (command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env) => {
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', timeout: 120_000 });
  expect(result.status, `${command}: ${result.error?.message ?? ''}\n${result.stdout}\n${result.stderr}`).toBe(0);
  return result.stdout;
};
async function fixture(name: string, options: Parameters<typeof buildProjectPlan>[0]) {
  const target = path.join(root, name);
  const artifacts = buildArtifacts(buildProjectPlan({
    projectName: 'Runtime Contract',
    cloud: 'azure',
    governanceProfile: 'none',
    ...options
  }, { requireProjectName: true }));
  for (const artifact of artifacts) {
    const file = path.join(target, ...artifact.pathParts);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, artifact.content);
  }
  return target;
}
function cleanEnvironment() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(APP_|DATABASE_URL|REDIS_|MESSAGING_|SERVICE_BUS_|AZURE_CLIENT_ID|PYDANTIC_AI_|OPENAI_|LANGFUSE_|LIFTOFF_ENV_FILE|CORS_|PORT$)/.test(key)) delete env[key];
  }
  return env;
}

beforeAll(async () => { await mkdir(root, { recursive: true }); });
afterAll(async () => { await rm(root, { recursive: true, force: true }); });

describe('generated native configuration contracts', () => {
  it('rejects explicit missing or malformed Node dotenv files even when process settings are complete', async () => {
    const target = await fixture('node-invalid-config', { projectType: 'standard', apiStack: 'node' });
    const source = "const {loadConfig} = await import('./src/config.ts'); loadConfig();";
    const cases = [
      ['unterminated.env', 'APP_NAME="private-test-value'],
      ['trailing.env', 'APP_NAME="valid" trailing'],
      ['assignment.env', 'APP_NAME valid'],
      ['invalid-key.env', 'INVALID-KEY=value'],
      ['escaped-quote.env', 'APP_NAME="a\\"b"'],
      ['nul.env', 'APP_NAME=invalid\0value'],
      ['invalid-utf8.env', Buffer.from([0x41, 0x3d, 0xff])],
      ['absent.env', undefined]
    ] as const;
    for (const [name, content] of cases) {
      if (content !== undefined) await writeFile(path.join(target, name), content);
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
        cwd: path.join(target, 'backend'), encoding: 'utf8',
        env: {
          ...cleanEnvironment(), DATABASE_URL: 'postgresql://localhost/process',
          REDIS_URL: 'redis://localhost:6379/0', LIFTOFF_ENV_FILE: `../${name}`
        }
      });
      expect(result.status, name).not.toBe(0);
      expect(result.stderr, name).toMatch(/Unable to read runtime configuration file|Malformed runtime configuration/);
      expect(result.stderr).not.toContain('private-test-value');
    }
    run(process.execPath, ['--input-type=module', '-e', source], path.join(target, 'backend'), {
      ...cleanEnvironment(), DATABASE_URL: 'postgresql://localhost/process', REDIS_URL: 'redis://localhost:6379/0'
    });
    await writeFile(path.join(target, 'valid.env'), '\ufeffexport APP_NAME="line one\nline two" # comment\n');
    run(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      const {loadConfig} = await import('./src/config.ts');
      assert.equal(loadConfig().appName, 'line one\\nline two');
    `], path.join(target, 'backend'), {
      ...cleanEnvironment(), DATABASE_URL: 'postgresql://localhost/process',
      REDIS_URL: 'redis://localhost:6379/0', LIFTOFF_ENV_FILE: '../valid.env'
    });
  });

  it.skipIf(!pythonSettingsAvailable)('rejects explicit missing or malformed Python dotenv files without falling back to process values', async () => {
    const target = await fixture('python-invalid-config', { pattern: 'generic' });
    const source = 'import sys; sys.path.insert(0, ".."); from backend.config.settings import get_settings; get_settings()';
    const cases = [
      ['unterminated.env', 'APP_NAME="private-test-value'],
      ['trailing.env', 'APP_NAME="valid" trailing'],
      ['assignment.env', 'APP_NAME valid'],
      ['invalid-key.env', 'INVALID-KEY=value'],
      ['nul.env', 'APP_NAME=invalid\0value'],
      ['invalid-utf8.env', Buffer.from([0x41, 0x3d, 0xff])],
      ['absent.env', undefined]
    ] as const;
    for (const [name, content] of cases) {
      if (content !== undefined) await writeFile(path.join(target, name), content);
      const result = spawnSync(python, ['-c', source], {
        cwd: path.join(target, 'backend'), encoding: 'utf8',
        env: {
          ...cleanEnvironment(), DATABASE_URL: 'postgresql://localhost/process',
          REDIS_URL: 'redis://localhost:6379/0', LIFTOFF_ENV_FILE: `../${name}`
        }
      });
      expect(result.status, name).not.toBe(0);
      expect(result.stderr, name).toMatch(/LIFTOFF_ENV_FILE must select|Unable to read runtime configuration file|Malformed runtime configuration/);
      expect(result.stderr).not.toContain('private-test-value');
    }
    run(python, ['-c', source], path.join(target, 'backend'), {
      ...cleanEnvironment(), DATABASE_URL: 'postgresql://localhost/process', REDIS_URL: 'redis://localhost:6379/0'
    });
    await writeFile(path.join(target, 'valid.env'), '\ufeffexport APP_NAME="line one\nline two" # comment\n');
    run(python, ['-c', `
import sys
sys.path.insert(0, "..")
from backend.config.settings import get_settings
assert get_settings().app_name == "line one\\nline two"
`], path.join(target, 'backend'), {
      ...cleanEnvironment(), DATABASE_URL: 'postgresql://localhost/process',
      REDIS_URL: 'redis://localhost:6379/0', LIFTOFF_ENV_FILE: '../valid.env'
    });
  });

  it.skipIf(!composeAvailable)('forwards selected model, transport and tracing settings while preserving container service addresses', async () => {
    const target = await fixture('compose', { pattern: 'rag' });
    await writeFile(path.join(target, 'selected.env'), [
      'DATABASE_URL=postgresql://localhost/native',
      'REDIS_URL=redis://localhost:6379/0',
      'PYDANTIC_AI_MODEL=openai-chat:file-model',
      'OPENAI_API_KEY=offline-key',
      'MESSAGING_TRANSPORT=azure-service-bus',
      'REDIS_STREAM_NAME=file-stream',
      'SERVICE_BUS_QUEUE_NAME=file-queue',
      'SERVICE_BUS_AUTH_MODE=managed-identity',
      'SERVICE_BUS_FULLY_QUALIFIED_NAMESPACE=offline.servicebus.windows.net',
      'AZURE_CLIENT_ID=00000000-0000-4000-8000-000000000001',
      'LANGFUSE_PUBLIC_KEY=offline-public',
      'LANGFUSE_SECRET_KEY=offline-secret',
      'LANGFUSE_HOST=http://langfuse:3000'
    ].join('\n'));
    const output = run('docker', ['compose', '--env-file', 'selected.env', 'config', '--format', 'json'], target, {
      ...cleanEnvironment(), PYDANTIC_AI_MODEL: 'openai-chat:process-model'
    });
    const environment = JSON.parse(output).services.backend.environment;
    expect(environment.PYDANTIC_AI_MODEL).toBe('openai-chat:process-model');
    expect(environment.REDIS_STREAM_NAME).toBe('file-stream');
    expect(environment.MESSAGING_TRANSPORT).toBe('azure-service-bus');
    expect(environment.SERVICE_BUS_QUEUE_NAME).toBe('file-queue');
    expect(environment.SERVICE_BUS_FULLY_QUALIFIED_NAMESPACE).toBe('offline.servicebus.windows.net');
    expect(environment.AZURE_CLIENT_ID).toBe('00000000-0000-4000-8000-000000000001');
    expect(environment.LANGFUSE_SECRET_KEY).toBe('offline-secret');
    expect(environment.OPENAI_API_KEY).toBe('offline-key');
    expect(environment.DATABASE_URL).toContain('@postgres:5432/');
    expect(environment.REDIS_URL).toBe('redis://redis:6379/0');
    expect(environment.BLOB_ENDPOINT).toBe('http://azurite:10000/devstoreaccount1');
    const empty = JSON.parse(run('docker', ['compose', '--env-file', 'selected.env', 'config', '--format', 'json'], target, {
      ...cleanEnvironment(), REDIS_STREAM_NAME: '', MESSAGING_TRANSPORT: ''
    })).services.backend.environment;
    expect(empty.REDIS_STREAM_NAME).toBe('');
    expect(empty.MESSAGING_TRANSPORT).toBe('');
  });
  it('uses Node runtime dotenv parsing, file precedence, process precedence, and one resolved object', async () => {
    const target = await fixture('node', { projectType: 'standard', apiStack: 'node' });
    await writeFile(path.join(target, '.env'), [
      'APP_NAME="file application"', 'DATABASE_URL=postgresql://localhost/native',
      'REDIS_URL=redis://localhost:6379/0', 'CORS_ALLOWED_ORIGINS=https://file.example',
      'PORT=8123'
    ].join('\n'));
    const source = `
      import assert from 'node:assert/strict';
      const {loadConfig} = await import('./src/config.ts');
      const settings = loadConfig();
      assert.equal(settings.appName, 'process application');
      assert.equal(settings.port, 8123);
      assert.equal(settings.databaseUrl, 'postgresql://localhost/native');
      assert.deepEqual(settings.corsAllowedOrigins, ['https://file.example']);
      process.env.APP_NAME = 'changed after resolution';
      assert.equal(loadConfig(), settings);
    `;
    run(process.execPath, ['--input-type=module', '-e', source], path.join(target, 'backend'), {
      ...cleanEnvironment(), APP_NAME: 'process application'
    });
    await writeFile(path.join(target, 'selected.env'), 'DATABASE_URL=postgresql://localhost/selected\nREDIS_URL=redis://localhost:6379/0\n');
    run(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      const {loadConfig} = await import('./src/config.ts');
      assert.equal(loadConfig().databaseUrl, 'postgresql://localhost/selected');
    `], path.join(target, 'backend'), { ...cleanEnvironment(), LIFTOFF_ENV_FILE: '../selected.env' });
    const missing = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
      cwd: path.join(target, 'backend'), encoding: 'utf8',
      env: { ...cleanEnvironment(), LIFTOFF_ENV_FILE: '../absent.env' }
    });
    expect(missing.status).not.toBe(0);
    expect(missing.stderr).toContain('Unable to read runtime configuration file');
  });

  it.skipIf(!goAvailable)('loads native Go JSON with process precedence using only standard-library configuration support', async () => {
    const target = await fixture('go', { projectType: 'standard', apiStack: 'go' });
    const example = JSON.parse(await readFile(path.join(target, 'runtime.config.example.json'), 'utf8'));
    await writeFile(path.join(target, 'runtime.config.json'), JSON.stringify({
      ...example, APP_NAME: 'file application', PORT: '8124', CORS_ALLOWED_ORIGINS: 'https://file.example'
    }));
    await writeFile(path.join(target, 'backend', 'internal', 'config', 'config_test.go'), `package config

import "testing"

func TestNativeConfiguration(t *testing.T) {
    first, err := Load()
    if err != nil { t.Fatal(err) }
    if first.AppName != "process application" || first.Port != "8124" || first.CORSAllowedOrigins != "https://file.example" {
        t.Fatalf("unexpected settings: %#v", first)
    }
    t.Setenv("APP_NAME", "changed")
    second, err := Load()
    if err != nil || second != first { t.Fatal("configuration was resolved twice") }
}
`);
    run('go', ['test', './internal/config'], path.join(target, 'backend'), {
      ...cleanEnvironment(), APP_NAME: 'process application',
      LIFTOFF_ENV_FILE: path.join(target, 'runtime.config.json')
    });
    expect(run('gofmt', ['-d', 'internal/config/config.go', 'internal/api/api.go', 'cmd/api/main.go'], path.join(target, 'backend'))).toBe('');
  });

  it.skipIf(!goAvailable)('rejects explicit missing and malformed Go configuration without fallback', async () => {
      const target = await fixture('go-invalid-config', { projectType: 'standard', apiStack: 'go' });
      const cases = ['{"APP_NAME":', 'null', '{"APP_NAME":null}', '{"PORT":8000}', '[]'];
      for (const [index, content] of cases.entries()) {
        await writeFile(path.join(target, `invalid-${index}.json`), content);
      }
      await writeFile(path.join(target, 'backend', 'internal', 'config', 'config_test.go'), `package config

import (
      "os"
      "path/filepath"
      "testing"
)

func TestRejectInvalidConfiguration(t *testing.T) {
      t.Setenv("DATABASE_URL", "postgresql://localhost/process")
      t.Setenv("REDIS_URL", "redis://localhost:6379/0")
      for _, file := range []string{"absent.json", "invalid-0.json", "invalid-1.json", "invalid-2.json", "invalid-3.json", "invalid-4.json"} {
          t.Setenv("LIFTOFF_ENV_FILE", filepath.Join(os.Getenv("FIXTURE_ROOT"), file))
          if _, err := load(); err == nil { t.Fatalf("accepted malformed or missing file %s", file) }
      }
      if err := os.Unsetenv("LIFTOFF_ENV_FILE"); err != nil { t.Fatal(err) }
      if _, err := load(); err != nil { t.Fatalf("absent default file blocked process configuration: %v", err) }
}
`);
      run('go', ['test', './internal/config'], path.join(target, 'backend'), {
        ...cleanEnvironment(), FIXTURE_ROOT: target
      });
  });

  it.skipIf(!pythonAvailable)('resolves Python file configuration once for models, tracing, readiness and injected RAG publishers', async () => {
    const target = await fixture('rag', { pattern: 'rag' });
    await writeFile(path.join(target, '.env'), [
      'APP_NAME=file application', 'DATABASE_URL=postgresql://localhost/native',
      'REDIS_URL=redis://localhost:6379/0', 'REDIS_STREAM_NAME=from-file',
      'PYDANTIC_AI_MODEL=openai-chat:offline-model', 'OPENAI_API_KEY=offline-test-key',
      'LANGFUSE_PUBLIC_KEY=', 'LANGFUSE_SECRET_KEY=',
      'SERVICE_BUS_AUTH_MODE=managed-identity',
      'SERVICE_BUS_FULLY_QUALIFIED_NAMESPACE=offline.servicebus.windows.net',
      'SERVICE_BUS_QUEUE_NAME=from-file-queue',
      'AZURE_CLIENT_ID=00000000-0000-4000-8000-000000000001'
    ].join('\n'));
    run(python, ['-c', `
import asyncio, json, os, sys
sys.path.insert(0, "..")
from backend.config.settings import get_settings
from backend.orchestration.model_config import ModelConfig, PydanticAgentRunner
from backend.orchestration.tools.messaging import build_message_publisher, MessagingConfigurationError
from backend.observability.tracing import build_tracer, DisabledTracer, TracingConfigurationError
from backend.orchestration.agents.rag_agent import enqueue_ingestion
settings = get_settings()
assert settings.app_name == "process application"
assert settings.database_url == "postgresql://localhost/native"
assert ModelConfig.from_settings().model_name == "openai-chat:offline-model"
assert ModelConfig.from_settings().api_key == "offline-test-key"
PydanticAgentRunner(ModelConfig.from_settings())
assert isinstance(build_tracer(), DisabledTracer)
os.environ["PYDANTIC_AI_MODEL"] = "changed"
assert get_settings() is settings
assert ModelConfig.from_settings().model_name == "openai-chat:offline-model"
class Redis:
    def __init__(self): self.calls = []
    async def xadd(self, name, fields): self.calls.append((name, fields))
redis = Redis()
publisher = build_message_publisher(redis_client=redis)
result = asyncio.run(enqueue_ingestion("offline://document", publisher=publisher))
assert result["status"] == "queued"
assert redis.calls[0][0] == "from-file"
class Sender:
    def __init__(self): self.messages = []
    async def __aenter__(self): return self
    async def __aexit__(self, *args): pass
    async def send_messages(self, message): self.messages.append(message)
class Bus:
    def __init__(self): self.queues = []; self.sender = Sender()
    def get_queue_sender(self, *, queue_name): self.queues.append(queue_name); return self.sender
bus = Bus()
publisher = build_message_publisher("azure-service-bus", service_bus_client=bus, message_factory=lambda body: body)
asyncio.run(enqueue_ingestion("offline://document", publisher=publisher))
assert bus.queues == ["from-file-queue"]
assert json.loads(bus.sender.messages[0])["topic"] == "rag.ingest"
from unittest.mock import patch
with patch("azure.identity.aio.ManagedIdentityCredential") as credential, patch("azure.servicebus.aio.ServiceBusClient") as client:
    build_message_publisher("azure-service-bus")
    credential.assert_called_once_with(client_id=settings.azure_client_id)
    client.assert_called_once_with("offline.servicebus.windows.net", credential.return_value)
with patch("azure.servicebus.aio.ServiceBusClient") as client:
    build_message_publisher("azure-service-bus", settings=settings.model_copy(update={
        "service_bus_auth_mode": "connection-string", "service_bus_connection_string": "offline-connection"
    }))
    client.from_connection_string.assert_called_once_with("offline-connection")
with patch("langfuse.Langfuse") as client:
    build_tracer(settings=settings.model_copy(update={
        "langfuse_public_key": "offline-public", "langfuse_secret_key": "offline-secret",
        "langfuse_host": "https://tracing.example"
    }))
    client.assert_called_once_with(public_key="offline-public", secret_key="offline-secret", host="https://tracing.example")
for field in ["service_bus_queue_name", "service_bus_fully_qualified_namespace", "azure_client_id"]:
    try:
        build_message_publisher("azure-service-bus", settings=settings.model_copy(update={field: ""}), service_bus_client=bus)
    except MessagingConfigurationError: pass
    else: raise AssertionError("missing " + field + " accepted")
try:
    build_message_publisher(settings=settings.model_copy(update={"redis_stream_name": ""}), redis_client=redis)
except MessagingConfigurationError: pass
else: raise AssertionError("empty Redis stream accepted")
try:
    build_tracer(settings=settings.model_copy(update={"langfuse_public_key": "offline", "langfuse_secret_key": ""}))
except TracingConfigurationError: pass
else: raise AssertionError("partial tracing accepted")
from fastapi.testclient import TestClient
from backend.apis.main import app
assert TestClient(app).get("/ready").json() == {"status": "ready"}
`], path.join(target, 'backend'), { ...cleanEnvironment(), APP_NAME: 'process application' });
    await writeFile(path.join(target, 'selected.env'), [
      'DATABASE_URL=postgresql://localhost/selected',
      'REDIS_URL=redis://localhost:6379/0',
      'PYDANTIC_AI_MODEL=openai-chat:selected-file',
      'OPENAI_API_KEY=selected-offline-key'
    ].join('\n'));
    run(python, ['-c', `
import sys
sys.path.insert(0, "..")
from backend.config.settings import get_settings
from backend.orchestration.model_config import ModelConfig
assert get_settings().database_url == "postgresql://localhost/selected"
assert ModelConfig.from_settings().model_name == "openai-chat:process-model"
assert ModelConfig.from_settings().api_key == "selected-offline-key"
`], path.join(target, 'backend'), {
      ...cleanEnvironment(), LIFTOFF_ENV_FILE: '../selected.env', PYDANTIC_AI_MODEL: 'openai-chat:process-model'
    });
  });
});
