import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { cliCoverage } from '../vitest.config.js';
import { gatewayCoverage } from '../services/telemetry-ingest/vitest.config.js';
import {
  coverageEvidenceFile,
  coverageFloorPercent,
  coveragePackage,
  coverageTestEnvironment,
  defaultMaxWorkers,
  sourceInventory,
  targetedInvocation
} from '../scripts/coverage-gate.mjs';
import { comparisonPlatforms, contractBaselineParts, contractChangesParts, historicalWriters } from '../scripts/contract-baseline.mjs';
import { isolatedUserStateEnvironment, suppressedCredentialVariables } from './setup/user-state-isolation.js';

const read = (file: string) => readFileSync(path.join(process.cwd(), ...file.split('/')), 'utf8').replace(/\r\n/g, '\n');
const contributing = read('CONTRIBUTING.md');
const developer = read('DEVELOPER.md');
const gates = contributing.split('### Coverage gates')[1]?.split('\n## ')[0] ?? '';
const baseline = developer.split('## Contract baseline and coverage gates')[1]?.split('\n## ')[0] ?? '';
const packageJson = JSON.parse(read('package.json'));

function bashBlocks(text: string): string[] {
  return [...text.matchAll(/```bash\n([\s\S]*?)```/g)].flatMap((match) => match[1].split('\n').map((line) => line.trim()).filter(Boolean));
}

describe('coverage gate contributor guidance', () => {
  it('documents only real, runnable gate commands', () => {
    const commands = bashBlocks(gates);
    expect(commands).toEqual(expect.arrayContaining([
      'npm ci', 'npm ci --prefix services/telemetry-ingest', 'npm run coverage:cli', 'npm run coverage:gateway',
      'node scripts/coverage-gate.mjs verify cli', 'node scripts/coverage-gate.mjs verify gateway'
    ]));
    for (const command of commands.filter((line) => line.startsWith('npm run '))) {
      const [, , script] = command.split(' ');
      expect(packageJson.scripts[script], command).toMatch(/^node scripts\/coverage-gate\.mjs run (?:cli|gateway)$/);
    }
    const inspect = commands.find((line) => line.includes(' inspect '));
    const [, , , id, , source, , test] = inspect!.split(' ');
    expect(() => targetedInvocation(coveragePackage(id), { sources: [source], tests: [test] })).not.toThrow();
    expect(existsSync(path.join(process.cwd(), test))).toBe(true);
  });

  it('states the exact floor, provider, inventories and run environment', () => {
    expect(coverageFloorPercent).toBe(80.01);
    expect(gates).toContain('strictly\ngreater than 80% (configured floor 80.01%)');
    expect(gates).toContain('`@vitest/coverage-v8` `5.0.0`');
    expect(packageJson.devDependencies['@vitest/coverage-v8']).toBe('5.0.0');
    expect(cliCoverage.include).toEqual(['src/**/*.ts']);
    expect(gates).toContain('`src/**/*.ts`');
    expect(sourceInventory(coveragePackage('gateway')).files.map((entry: { path: string }) => entry.path)).toContain('src/telemetry/contract.ts');
    expect(gatewayCoverage.include).toContain('**/src/telemetry/contract.ts');
    expect(gates).toContain('`services/telemetry-ingest/src/**/*.ts` plus the whole\nshared `src/telemetry/contract.ts` module');
    for (const [name, value] of Object.entries(coverageTestEnvironment)) expect(gates).toContain(`\`${name}=${value}\``);
    expect(defaultMaxWorkers).toBe(2);
    expect(gates).toContain('two workers');
    expect(gates).toContain('`--allowOnly=false`');
  });

  it('lists the report files each run actually writes', () => {
    for (const reporter of ['json-summary', 'json']) expect(cliCoverage.reporter).toContain(reporter);
    for (const file of ['coverage-summary.json', 'coverage-final.json', 'coverage.txt', 'test-results.json', coverageEvidenceFile]) {
      expect(gates).toContain(`\`${file}\``);
    }
    expect(gates).toContain('`coverage/cli/` or `coverage/gateway/`');
    expect(gates).toContain('stale');
    expect(gates).toContain('unrun');
  });

  it('separates code coverage from native, packaged, generated and live qualification', () => {
    for (const phrase of [
      'Child processes', '`assets/repair/windows-job-controller.ps1`', '`npm run smoke:package`',
      '`npm run verify:generated-containers`', '`npm run verify:standard-node-templates`', 'native\nOpenTofu',
      'live Azure or GitHub', 'does not claim any of them'
    ]) {
      expect(gates).toContain(phrase);
    }
    expect(existsSync(path.join(process.cwd(), 'assets', 'repair', 'windows-job-controller.ps1'))).toBe(true);
    for (const script of ['smoke:package', 'verify:generated-containers', 'verify:standard-node-templates']) {
      expect(packageJson.scripts[script]).toBeTruthy();
    }
  });

  it('names the actual CI jobs and release ordering', () => {
    const ci = parseYaml(read('.github/workflows/ci.yml'));
    expect(ci.jobs['coverage-cli'].name).toBe('CLI coverage gate');
    expect(ci.jobs['coverage-gateway'].name).toBe('Telemetry gateway coverage gate');
    expect(gates).toContain('`CLI coverage gate` and `Telemetry gateway coverage gate` jobs');
    expect(gates).toContain('before packing the release tarball');
    expect(contributing).toContain('both source-complete coverage gates');
    expect(developer).toContain('coverage gates before packing and stores their evidence as a separate workflow\nartifact');
  });

  it('documents required native parser qualification without masking portable coverage', () => {
    for (const file of ['ci.yml', 'release.yml']) {
      const workflow = parseYaml(read(`.github/workflows/${file}`));
      const job = workflow.jobs['qualify-isolated-hcl'];
      expect(gates).toContain(`\`${job.name}\``);
      expect(gates).toContain(`\`${job['runs-on']}\``);
      expect(job.env.LIFTOFF_HCL_TEST_LANE).toBe('native');
      if (file === 'release.yml') {
        expect(workflow.jobs.qualify.needs).toBe('qualify-isolated-hcl');
        expect(workflow.jobs.publish.needs).toBe('qualify');
      }
    }
    expect(gates).toContain('LIFTOFF_HCL_TEST_LANE=portable npm run coverage:cli');
    for (const phrase of [
      '`native` fails on a runtime mismatch', 'synthetic rejection/routing',
      'not Linux, Windows or Node24.20 qualification', 'never inject successful\nASTs into a planner',
      'native coverage cannot mask a failing portable gate', 'each coverage invocation replaces `coverage/cli/`'
    ]) expect(gates).toContain(phrase);
  });

  it('links contributors to the reviewed contract-change record', () => {
    expect(contributing).toContain('`tests/fixtures/contract-baseline-changes.json`');
    expect(contributing).toContain('(DEVELOPER.md#contract-baseline-and-coverage-gates)');
    expect(developer).toContain('(CONTRIBUTING.md#coverage-gates)');
  });
});

describe('contract baseline developer guidance', () => {
  it('describes the real frozen files, commands and registry', () => {
    const directory = contractBaselineParts.join('/');
    expect(baseline).toContain(`\`${directory}/\``);
    for (const file of ['cli-text.json', 'cli-json.json', 'rendered-artifacts.json', 'manifest-readers.json',
      'activation-identities.json', 'history.json', 'provenance.json']) {
      expect(baseline).toContain(`\`${file}\``);
      expect(existsSync(path.join(process.cwd(), directory, file)), file).toBe(true);
    }
    expect(bashBlocks(baseline)).toEqual(['npx vitest run tests/contract-baseline.test.ts']);
    expect(baseline).toContain(`\`${contractChangesParts.join('/')}\``);
    for (const field of ['surface', 'key', 'task', 'reason', 'baselineSha256', 'currentSha256']) {
      expect(baseline).toContain(`\`${field}\``);
    }
    expect(baseline).toContain('Never regenerate\nthe baseline');
    expect(baseline).toContain('refuses\nto overwrite');
  });

  it('names every historical writer and the labeled reader defect accurately', () => {
    for (const writer of historicalWriters) expect(baseline).toContain(writer.version);
    const review = JSON.parse(read(contractChangesParts.join('/')));
    const defect = review.knownDefects[0];
    expect(baseline).toContain(`\`${defect.id}\``);
    expect(baseline).toContain(defect.owner);
    expect(baseline).toContain(`first\npublished in ${defect.firstAppearance.firstPublishedWith}`);
    expect(baseline).toContain('not a\npromise that those versions are unsupported');
    expect(comparisonPlatforms).toEqual(['darwin', 'linux']);
    expect(baseline).toContain('comparisons are enabled on macOS and Linux');
    expect(baseline).toContain('(darwin/arm64), so the Linux comparison remains unrun until CI executes it\nnatively');
    expect(baseline).toContain('Windows host paths');
    expect(baseline).toContain('`node scripts/contract-baseline.mjs observe-writers`');
    expect(baseline).toContain('(`rendered` or `none`)');
  });
});

describe('test user-state isolation guidance', () => {
  const guidance = contributing.split('Every root Vitest run, whether')[1]?.split('\n\n')[0] ?? '';

  it('names every redirected directory variable the harness actually sets', () => {
    const posix = isolatedUserStateEnvironment('/t/lus-a', 'linux');
    for (const name of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'AZURE_CONFIG_DIR', 'GH_CONFIG_DIR',
      'GOPATH', 'GOMODCACHE', 'GOCACHE', 'GOENV']) {
      expect(posix[name], name).toEqual(expect.any(String));
      expect(guidance).toContain(`\`${name}\``);
    }
    expect(posix.npm_config_userconfig && posix.npm_config_globalconfig && posix.npm_config_cache).toBeTruthy();
    expect(guidance).toContain('the npm user config, global config, and cache');
    expect(posix.AZURE_CORE_COLLECT_TELEMETRY).toBe('false');
    expect(posix.npm_config_update_notifier).toBe('false');
    expect(guidance).toContain('Azure CLI\ntelemetry and npm update checks are off');
    expect(isolatedUserStateEnvironment('C:\\t\\lus-a', 'win32').XDG_CONFIG_HOME).toBeUndefined();
    expect(guidance).toContain('the XDG directories (POSIX)');
  });

  it('describes credential clearing, timing, cleanup and its limits accurately', () => {
    expect(suppressedCredentialVariables).toEqual(expect.arrayContaining(['GH_TOKEN', 'AZURE_CLIENT_SECRET', 'NPM_TOKEN']));
    for (const phrase of [
      '`npm test`, a targeted `npx vitest run`, or the\ncoverage gate',
      'before Vitest writes its own user-data token',
      'a failed cleanup fails the run',
      'ambient gh, az, and npm credential\nvariables are cleared whatever their letter case',
      'Tool caches start empty',
      'injects its own fixture',
      'it is not a sandbox or network boundary',
      '`PATH`\nand native host settings are unchanged'
    ]) {
      expect(guidance).toContain(phrase);
    }
  });
});
