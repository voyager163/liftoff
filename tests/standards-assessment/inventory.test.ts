import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  categorizeFile,
  isProtectedPayload,
  scanInventory
} from '../../src/adapters/filesystem/standards-assessment/scanner.js';
import {
  computeInventoryDigest,
  containsSensitiveText,
  sanitizeText
} from '../../src/domain/standards-assessment/sanitizer.js';
import { PathSafetyError } from '../../src/adapters/filesystem/standards-assessment/errors.js';

const fixtureDirs: string[] = [];

function createFixtureDir(prefix: string): string {
  const dir = path.resolve(process.cwd(), 'tests', `.inventory-fixture-${prefix}-${randomUUID()}`);
  fixtureDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of fixtureDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe('standards assessment inventory and protected exclusions', () => {
  it('correctly categorizes files across the 13 declared inventory categories', () => {
    expect(categorizeFile(['liftoff.manifest.json'])).toBe('provenance');
    expect(categorizeFile(['openspec', 'config.yaml'])).toBe('framework');
    expect(categorizeFile(['.github', 'skills', 'openspec-apply', 'SKILL.md'])).toBe('framework');
    expect(categorizeFile(['.github', 'prompts', 'liftoff-repair.prompt.md'])).toBe('agent');
    expect(categorizeFile(['.github', 'workflows', 'ci.yml'])).toBe('workflows');
    expect(categorizeFile(['infrastructure', 'main.tf'])).toBe('infrastructure');
    expect(categorizeFile(['Dockerfile'])).toBe('containers');
    expect(categorizeFile(['docker-compose.yml'])).toBe('containers');
    expect(categorizeFile(['package-lock.json'])).toBe('locks');
    expect(categorizeFile(['uv.lock'])).toBe('locks');
    expect(categorizeFile(['package.json'])).toBe('declarations');
    expect(categorizeFile(['pyproject.toml'])).toBe('declarations');
    expect(categorizeFile(['tsconfig.json'])).toBe('build');
    expect(categorizeFile(['vite.config.ts'])).toBe('build');
    expect(categorizeFile(['.env.example'])).toBe('config');
    expect(categorizeFile(['tests', 'api.test.ts'])).toBe('tests');
    expect(categorizeFile(['README.md'])).toBe('docs');
    expect(categorizeFile(['src', 'server.ts'])).toBe('source');
  });

  it('identifies protected payload filenames for exclusion', () => {
    expect(isProtectedPayload('.env')).toBe(true);
    expect(isProtectedPayload('.env.local')).toBe(true);
    expect(isProtectedPayload('.env.production.local')).toBe(true);
    expect(isProtectedPayload('.env.example')).toBe(false);
    expect(isProtectedPayload('id_rsa')).toBe(true);
    expect(isProtectedPayload('id_dsa')).toBe(true);
    expect(isProtectedPayload('id_ed25519')).toBe(true);
    expect(isProtectedPayload('server.key')).toBe(true);
    expect(isProtectedPayload('cert.pem')).toBe(true);
    expect(isProtectedPayload('cert.asc')).toBe(true);
    expect(isProtectedPayload('cert.gpg')).toBe(true);
    expect(isProtectedPayload('terraform.tfstate')).toBe(true);
    expect(isProtectedPayload('terraform.tfstate.backup')).toBe(true);
    expect(isProtectedPayload('out.tfplan')).toBe(true);
    expect(isProtectedPayload('dev.tfplan')).toBe(true);
    expect(isProtectedPayload('credentials.json')).toBe(true);
    expect(isProtectedPayload('secrets.json')).toBe(true);
    expect(isProtectedPayload('token.pat')).toBe(true);
    expect(isProtectedPayload('main.py')).toBe(false);
  });

  it('scans inventory and excludes protected payload files without reading them', async () => {
    const dir = createFixtureDir('protected-exclusions');
    await mkdir(dir, { recursive: true });

    // Legitimate files
    await writeFile(path.join(dir, 'package.json'), '{"name":"demo"}\n');
    await writeFile(path.join(dir, 'package-lock.json'), '{"name":"demo","lockfileVersion":3}\n');
    await writeFile(path.join(dir, '.env.example'), 'PORT=3000\n');
    await writeFile(path.join(dir, 'README.md'), '# Demo\n');

    // Sensitive files that MUST be excluded
    await writeFile(path.join(dir, '.env'), 'SECRET_KEY=supersecret1234567890\n');
    await writeFile(path.join(dir, '.env.local'), 'TOKEN=ghp_secrettoken12345678901234567890\n');
    await writeFile(path.join(dir, 'id_rsa'), '-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n');
    await writeFile(path.join(dir, 'server.key'), '-----BEGIN PRIVATE KEY-----\n...\n');
    await writeFile(path.join(dir, 'terraform.tfstate'), '{"secret":"state"}\n');
    await writeFile(path.join(dir, 'dev.tfplan'), 'binary tfplan payload\n');
    await writeFile(path.join(dir, 'credentials.json'), '{"apiKey":"secret"}\n');
    await writeFile(path.join(dir, 'secrets.json'), '{"dbPassword":"secret"}\n');
    await writeFile(path.join(dir, 'cert.gpg'), 'binary gpg key\n');

    const inventory = await scanInventory(dir);

    // Protected exclusions must list the excluded files
    expect(inventory.protectedExclusions).toContain('.env');
    expect(inventory.protectedExclusions).toContain('.env.local');
    expect(inventory.protectedExclusions).toContain('id_rsa');
    expect(inventory.protectedExclusions).toContain('server.key');
    expect(inventory.protectedExclusions).toContain('terraform.tfstate');
    expect(inventory.protectedExclusions).toContain('dev.tfplan');
    expect(inventory.protectedExclusions).toContain('credentials.json');
    expect(inventory.protectedExclusions).toContain('secrets.json');
    expect(inventory.protectedExclusions).toContain('cert.gpg');

    // None of the sensitive files should be in files
    const filePaths = inventory.files.map((f) => f.path);
    expect(filePaths).not.toContain('.env');
    expect(filePaths).not.toContain('.env.local');
    expect(filePaths).not.toContain('id_rsa');
    expect(filePaths).not.toContain('server.key');
    expect(filePaths).not.toContain('terraform.tfstate');
    expect(filePaths).not.toContain('dev.tfplan');
    expect(filePaths).not.toContain('credentials.json');
    expect(filePaths).not.toContain('secrets.json');
    expect(filePaths).not.toContain('cert.gpg');

    // .env.example should be present
    expect(filePaths).toContain('.env.example');
    expect(filePaths).toContain('package.json');
    expect(filePaths).toContain('package-lock.json');
    expect(filePaths).toContain('README.md');
  });

  it('sanitizes sensitive patterns before truncating', () => {
    const sensitiveGhToken = 'Found ghp_123456789012345678901234567890 in log';
    expect(containsSensitiveText(sensitiveGhToken)).toBe(true);
    expect(sanitizeText(sensitiveGhToken)).toBe('[withheld: sensitive content]');

    const sensitiveBearer = 'Authorization: Bearer mySecretToken1234567890';
    expect(containsSensitiveText(sensitiveBearer)).toBe(true);
    expect(sanitizeText(sensitiveBearer)).toBe('[withheld: sensitive content]');

    const normalLongText = 'a'.repeat(3000);
    const sanitized = sanitizeText(normalLongText, 100);
    expect(sanitized.endsWith('[truncated]')).toBe(true);
    expect(sanitized.length).toBe(100);
  });

  it('marks files exceeding maxFileSize as unobserved with size_limit_exceeded', async () => {
    const dir = createFixtureDir('size-limit');
    await mkdir(dir, { recursive: true });

    // 500 byte file with maxFileSize = 200
    await writeFile(path.join(dir, 'large.bin'), 'x'.repeat(500));
    await writeFile(path.join(dir, 'small.txt'), 'hello');

    const inventory = await scanInventory(dir, { maxFileSize: 200 });

    const unobserved = inventory.unobserved.find((u) => u.path === 'large.bin');
    expect(unobserved).toBeDefined();
    expect(unobserved?.reason).toBe('size_limit_exceeded');

    expect(inventory.files.map((f) => f.path)).toContain('small.txt');
    expect(inventory.files.map((f) => f.path)).not.toContain('large.bin');
  });

  it('rejects symlinks that escape the project root with PathSafetyError', async () => {
    const dir = createFixtureDir('escaping-symlink');
    const project = path.join(dir, 'project');
    const outside = path.join(dir, 'outside');
    await mkdir(project, { recursive: true });
    await mkdir(outside, { recursive: true });

    await writeFile(path.join(outside, 'secret.txt'), 'secret');
    await symlink(path.join(outside, 'secret.txt'), path.join(project, 'link.txt'));

    await expect(scanInventory(project)).rejects.toThrow(PathSafetyError);
    await expect(scanInventory(project)).rejects.toThrow(/escapes project root/);
  });

  it('computes deterministic observation digest for inventory files', () => {
    const files = [
      { path: 'src/app.ts', digest: 'abc', size: 100 },
      { path: 'package.json', digest: 'def', size: 50 }
    ];
    const digest1 = computeInventoryDigest(files);
    const digest2 = computeInventoryDigest([files[1], files[0]]);
    expect(digest1).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(digest1).toBe(digest2);
  });
});
