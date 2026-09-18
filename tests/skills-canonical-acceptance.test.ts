import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from '../src/cli/args/parser.js';
import { loadCanonicalSkillCatalog } from '../src/adapters/packaged-assets/skill-assets.js';
import {
  loadPackagedTemplateCatalog, resetResourceCatalogCache, setPackageRootOverride
} from '../src/adapters/packaged-assets/resource-catalog.js';
import { installedPackageRoot } from '../src/adapters/packaged-assets/package-root.js';
import { computeComponentDigest, computeTemplateCatalogDigest, type TemplateCatalog } from '../src/domain/standards/resource-catalog-schema.js';
import { canonicalJson } from '../src/domain/governance/activation/canonical-json.js';
import { CANONICAL_SKILL_IDS, SUPPORTED_SKILL_HOSTS } from '../src/domain/skills/contracts.js';
import { projectSkillForHost, renderRetainedProjectSkill } from '../src/adapters/skills/host-projections.js';
import { governanceAgentIntegrations } from '../src/domain/project/catalog.js';
import { renderAssessmentIntegration, renderRepairIntegration, renderSetupIntegration } from '../src/application/repository-governance/agent-rendering.js';

describe('Verified canonical catalog and real CLI command contracts', () => {
  let root: string;
  let resources: TemplateCatalog;
  let rawCatalog: Record<string, unknown> & { skills: Array<Record<string, unknown>> };

  async function refreshResources() {
    for (const [id, descriptor] of Object.entries(resources.resources)) {
      if (id !== 'skills.catalog' && !CANONICAL_SKILL_IDS.some((skill) => id === `skills.${skill}`)) continue;
      const bytes = await readFile(path.join(root, ...descriptor.path.split('/')));
      descriptor.size = bytes.length;
      descriptor.digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    }
    for (const component of Object.values(resources.components)) {
      component.digest = computeComponentDigest(component, resources.resources);
    }
    resources.digest = computeTemplateCatalogDigest(resources);
    await writeFile(path.join(root, 'assets', 'templates', 'catalog.json'), `${JSON.stringify(resources, null, 2)}\n`);
    resetResourceCatalogCache();
  }

  async function saveCatalog(raw: unknown = rawCatalog) {
    await writeFile(path.join(root, 'assets', 'skills', 'catalog.json'), `${JSON.stringify(raw, null, 2)}\n`);
    await refreshResources();
  }

  beforeEach(async () => {
    setPackageRootOverride(undefined);
    resetResourceCatalogCache();
    const canonical = loadCanonicalSkillCatalog();
    resources = structuredClone(loadPackagedTemplateCatalog(true));
    rawCatalog = {
      schemaVersion: 1, catalogVersion: canonical.catalogVersion,
      skills: canonical.skills.map(({ content: _content, contentHash: _hash, ...metadata }) => ({ ...metadata }))
    };
    root = path.resolve(`tests/.canonical-acceptance-${process.pid}-${randomUUID()}`);
    await mkdir(path.join(root, 'assets', 'templates'), { recursive: true });
    for (const skill of canonical.skills) {
      const directory = path.join(root, 'assets', 'skills', skill.id);
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, 'SKILL.md'), skill.content);
    }
    await saveCatalog();
    setPackageRootOverride(root);
  });

  afterEach(async () => {
    setPackageRootOverride(undefined);
    resetResourceCatalogCache();
    await rm(root, { recursive: true, force: true });
  });

  it('loads all eleven verified resources with truthful human/JSON output contracts', () => {
    const catalog = loadCanonicalSkillCatalog();
    expect(catalog.skills.map((skill) => skill.id)).toEqual(CANONICAL_SKILL_IDS);
    for (const id of ['init', 'migrate'] as const) {
      expect(catalog.skills.find((skill) => skill.id === id)).toMatchObject({
        commandOutput: 'human', commandResultSchema: null, authorizationMechanism: 'flag-consent'
      });
      expect(() => parseArgs([id, '--json'])).toThrow();
      expect(() => parseArgs([id, '--plan-only'])).toThrow();
      expect(() => parseArgs([id, '--approve-plan', 'a'.repeat(64)])).toThrow();
    }
    expect(catalog.skills.find((skill) => skill.id === 'repair')).toMatchObject({
      commandOutput: 'json', commandResultSchema: 2, contractVersion: 1
    });
    expect(catalog.skills.find((skill) => skill.id === 'cli-upgrade')).toMatchObject({
      commandOutput: 'json', commandResultSchema: 1, authorizationMechanism: 'command-invocation'
    });
  });

  it('parses every fenced and inline CLI example through the current production parser', () => {
    let count = 0;
    for (const skill of loadCanonicalSkillCatalog().skills) {
      const commands = new Set([...skill.content.matchAll(/^liftoff [^\n]+$/gm)].map((match) => match[0]));
      for (const match of skill.content.matchAll(/`(liftoff [^`\n]+)`/gu)) commands.add(match[1]);
      expect([...commands][0], skill.id).toBe('liftoff capabilities --json');
      for (const command of commands) {
        expect(command, skill.id).not.toMatch(/[<>{}|]/u);
        expect(() => parseArgs(command.split(/\s+/u).slice(1)), `${skill.id}: ${command}`).not.toThrow();
        count++;
      }
    }
    expect(count).toBeGreaterThanOrEqual(60);
  });

  it('rejects root extras and duplicate JSON fields even when resource digests match', async () => {
    await saveCatalog({ ...rawCatalog, unexpected: true });
    expect(() => loadCanonicalSkillCatalog()).toThrow(/additional|unknown|fields/);
    const text = JSON.stringify(rawCatalog).replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1');
    await writeFile(path.join(root, 'assets', 'skills', 'catalog.json'), text);
    await refreshResources();
    expect(() => loadCanonicalSkillCatalog()).toThrow(/duplicate/i);
  });

  it.each([
    { requiredCapability: 'not-an-installed-capability' },
    { owningEngine: 'Project Generation' },
    { commandOutput: 'human', commandResultSchema: null },
    { commandResultSchema: 999 },
    { contractVersion: 7 },
    { authorizationMechanism: 'command-invocation' },
    { authorizationRequired: false },
    { supportedHosts: ['github-copilot', 'github-copilot', 'codex'] },
    { defaultInvocations: { 'github-copilot': '/liftoff-setup', claude: '/liftoff-setup', codex: '$liftoff-setup', other: '/extra' } },
    { defaultInvocations: { 'github-copilot': '/not-setup', claude: '/liftoff-setup', codex: '$liftoff-setup' } }
  ])('rejects an unregistered complete catalog tuple: %j', async (patch) => {
    rawCatalog.skills[0] = { ...rawCatalog.skills[0], ...patch };
    await saveCatalog();
    expect(() => loadCanonicalSkillCatalog()).toThrow();
  });

  it.each(['../setup/SKILL.md', 'setup\\SKILL.md', 'C:\\setup\\SKILL.md', '/setup/SKILL.md', 'setup/\u0000SKILL.md', 'setup/skill.md'])(
    'rejects entrypoint alias before source access: %s', async (entrypoint) => {
      rawCatalog.skills[0].entrypoint = entrypoint;
      await saveCatalog();
      expect(() => loadCanonicalSkillCatalog()).toThrow(/entrypoint|portable|identity/);
    }
  );

  it('rejects modified source bytes rather than computing a new trusted hash', async () => {
    await writeFile(path.join(root, 'assets', 'skills', 'setup', 'SKILL.md'), 'unregistered replacement bytes');
    expect(() => loadCanonicalSkillCatalog()).toThrow(/size|digest|modified|damaged/i);
  });

  it.each(['skills.catalog', 'skills.setup'])('rejects verified non-UTF-8 bytes in %s', async (id) => {
    const file = path.join(root, ...resources.resources[id].path.split('/'));
    await writeFile(file, Buffer.concat([await readFile(file), Buffer.from([0xff])]));
    await refreshResources();
    expect(() => loadCanonicalSkillCatalog()).toThrow(/UTF-8/);
  });

  it.each([
    { id: 'skills.catalog', maximumBytes: 256 * 1024 },
    { id: 'skills.setup', maximumBytes: 2 * 1024 * 1024 }
  ])('enforces the exact consumer byte bound for $id', async ({ id, maximumBytes }) => {
    const file = path.join(root, ...resources.resources[id].path.split('/'));
    const original = await readFile(file);
    const bounded = Buffer.concat([original, Buffer.alloc(maximumBytes - original.length, ' ')]);
    await writeFile(file, bounded);
    await refreshResources();
    expect(loadCanonicalSkillCatalog().skills).toHaveLength(11);
    await writeFile(file, Buffer.concat([bounded, Buffer.from(' ')]));
    await refreshResources();
    expect(() => loadCanonicalSkillCatalog()).toThrow(/size|bound/i);
  });

  it('rejects invalid or duplicate source frontmatter after verified resource reading', async () => {
    const file = path.join(root, 'assets', 'skills', 'setup', 'SKILL.md');
    const original = await readFile(file, 'utf8');
    await writeFile(file, original.replace('name: liftoff-setup', 'name: another-workflow'));
    await refreshResources();
    expect(() => loadCanonicalSkillCatalog()).toThrow(/frame|body/);
    const end = original.indexOf('\n\n') + 2;
    await writeFile(file, `${original.slice(0, end)}${original}`);
    await refreshResources();
    expect(() => loadCanonicalSkillCatalog()).toThrow(/frame|body/);
  });

  it.each(['file', 'parent', 'hardlink', 'case'] as const)('rejects real filesystem %s aliases', async (kind) => {
    const directory = path.join(root, 'assets', 'skills', 'setup');
    const file = path.join(directory, 'SKILL.md');
    if (kind === 'file') {
      await rename(file, path.join(directory, 'original.md'));
      await symlink(path.join(directory, 'original.md'), file);
    } else if (kind === 'parent') {
      await rename(directory, `${directory}-original`);
      await symlink(`${directory}-original`, directory, 'dir');
    } else if (kind === 'hardlink') {
      await link(file, path.join(directory, 'second-name.md'));
    } else {
      await rename(file, path.join(directory, 'skill.md'));
    }
    expect(() => loadCanonicalSkillCatalog()).toThrow(/link|alias|identity/i);
  });

  it('rejects a descriptor redirected to a different verified resource', async () => {
    const setup = resources.resources['skills.setup'];
    const alternate = path.join(root, 'assets', 'skills', 'setup', 'unregistered.md');
    await writeFile(alternate, await readFile(path.join(root, 'assets', 'skills', 'setup', 'SKILL.md')));
    setup.path = 'assets/skills/setup/unregistered.md';
    for (const component of Object.values(resources.components)) component.digest = computeComponentDigest(component, resources.resources);
    resources.digest = computeTemplateCatalogDigest(resources);
    await writeFile(path.join(root, 'assets', 'templates', 'catalog.json'), JSON.stringify(resources));
    resetResourceCatalogCache();
    expect(() => loadCanonicalSkillCatalog()).toThrow(/registered consumer path/);
  });

  it('propagates a verified canonical revision through every retained native producer', async () => {
    const file = path.join(root, 'assets', 'skills', 'repair', 'SKILL.md');
    await writeFile(file, `${await readFile(file, 'utf8')}\nVerified canonical revision marker.\n`);
    await refreshResources();
    for (const host of SUPPORTED_SKILL_HOSTS) {
      expect(renderRepairIntegration(host)).toContain('Verified canonical revision marker.');
    }
  });

  it('renders one frame and one shared personal file while retaining host-specific invocation identity', () => {
    const skill = loadCanonicalSkillCatalog().skills[0];
    const copilot = projectSkillForHost(skill, 'github-copilot', 'user');
    const codex = projectSkillForHost(skill, 'codex', 'user');
    expect(copilot.renderedContent).toBe(codex.renderedContent);
    expect(copilot.contentHash).toBe(codex.contentHash);
    expect(copilot.invocation).toBe('/liftoff-setup');
    expect(codex.invocation).toBe('$liftoff-setup');
    expect(copilot.renderedContent.match(/^---$/gm)).toHaveLength(2);
    expect(() => projectSkillForHost(skill, 'unknown' as never, 'user')).toThrow();
    expect(() => projectSkillForHost(skill, 'codex', 'unknown' as never)).toThrow();
  });

  it('keeps all nine registered project paths and richer safeguards while using canonical content', () => {
    const skills = loadCanonicalSkillCatalog();
    expect(Object.fromEntries(SUPPORTED_SKILL_HOSTS.flatMap((host) =>
      (['setup', 'assessment', 'repair'] as const).map((operation) => {
        const native = governanceAgentIntegrations[host][operation];
        return [native.logicalName, [native.pathParts.join('/'), native.invocation]];
      })))).toEqual({
      'liftoff-setup-copilot': ['.github/prompts/liftoff-setup.prompt.md', '/liftoff-setup'],
      'liftoff-governance-assess-copilot': ['.github/prompts/liftoff-governance-assess.prompt.md', '/liftoff-governance-assess'],
      'liftoff-repair-copilot': ['.github/prompts/liftoff-repair.prompt.md', '/liftoff-repair'],
      'liftoff-setup-claude': ['.claude/commands/liftoff-setup.md', '/liftoff-setup'],
      'liftoff-governance-assess-claude': ['.claude/commands/liftoff-governance-assess.md', '/liftoff-governance-assess'],
      'liftoff-repair-claude': ['.claude/commands/liftoff-repair.md', '/liftoff-repair'],
      'liftoff-setup-codex': ['.agents/skills/liftoff-setup/SKILL.md', '$liftoff-setup'],
      'liftoff-governance-assess-codex': ['.agents/skills/liftoff-governance-assess/SKILL.md', '$liftoff-governance-assess'],
      'liftoff-repair-codex': ['.agents/skills/liftoff-repair/SKILL.md', '$liftoff-repair']
    });
    for (const host of SUPPORTED_SKILL_HOSTS) {
      for (const [operation, id, render] of [
        ['setup', 'setup', renderSetupIntegration],
        ['assessment', 'governance-assess', renderAssessmentIntegration],
        ['repair', 'repair', renderRepairIntegration]
      ] as const) {
        const skill = skills.skills.find((entry) => entry.id === id)!;
        const current = render(host);
        expect(current).toBe(renderRetainedProjectSkill(skill, host));
        expect(current).toContain(governanceAgentIntegrations[host][operation].invocation);
        expect(current).toContain('Capability Negotiation');
        expect(current.indexOf('liftoff capabilities --json')).toBeLessThan(current.indexOf('liftoff governance status') === -1 ? Number.MAX_SAFE_INTEGER : current.indexOf('liftoff governance status'));
      }
    }
    const repair = renderRepairIntegration('codex');
    for (const safeguard of ['lifecycle: disabled', 'OUTSIDE the project', 'NOT an OS or network sandbox',
      'SEPARATELY', 'newer user files', 'Governance `none` stays disabled', 'Project Evolution', 'contract 1', 'schema 2']) {
      expect(repair, safeguard).toContain(safeguard);
    }
    expect(renderSetupIntegration('github-copilot')).toContain('Project setup stays post-init');
    expect(renderAssessmentIntegration('claude')).toContain('Stop after explaining it');
    expect(canonicalJson(skills)).not.toContain('supportedContinuations');
    expect(installedPackageRoot).not.toBe(root);
  });
});
