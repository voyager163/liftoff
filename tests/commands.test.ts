import path from 'node:path';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { describe, expect, it } from 'vitest';
import { parseArgs } from '../src/args.js';
import { runCommand } from '../src/commands.js';
import { liftoffVersion } from '../src/version.js';
import { CaptureStream, ReadyInitRunner } from './helpers.js';

describe('commands', () => {
  it('parses init positional arguments without treating them as subcommands', () => {
    const parsed = parseArgs(['init', 'my-app', '--pattern', 'rag', '--cloud', 'azure']);

    expect(parsed.command).toBe('init');
    expect(parsed.subcommand).toBeUndefined();
    expect(parsed.positional).toEqual(['my-app']);
    expect(parsed.flags.pattern).toBe('rag');
  });

  it('parses standard project flags', () => {
    const parsed = parseArgs(['init', 'my-api', '--no-genai', '--api', 'node']);

    expect(parsed.flags.genai).toBe(false);
    expect(parsed.flags.api).toBe('node');
  });

  it('parses multi-agent and independent consent flags strictly', () => {
    const parsed = parseArgs([
      'init', 'my-api', '--agents', 'copilot,claude', '--default-agent', 'claude',
      '--yes', '--force', '--install-tools', '--install-dependencies'
    ]);
    expect(parsed.flags).toMatchObject({
      agents: 'copilot,claude',
      'default-agent': 'claude',
      yes: true,
      force: true,
      'install-tools': true,
      'install-dependencies': true
    });
    expect(() => parseArgs(['plan', '--force'])).toThrow(/Unknown flag/);
    expect(() => parseArgs(['init', '--agents='])).toThrow(/Missing value/);
  });

  it('parses explicit boolean values and rejects duplicate flags', () => {
    expect(parseArgs(['plan', '--frontend=false', '--no-genai', '--api=node']).flags).toMatchObject({
      frontend: false,
      genai: false,
      api: 'node'
    });
    expect(() => parseArgs(['plan', '--api', 'node', '--api', 'go'])).toThrow(/provided only once/);
  });

  it('rejects unknown flags, options, subcommands, and extra positionals', () => {
    expect(() => parseArgs(['init', 'app', '--cluod', 'aws'])).toThrow(/Unknown flag.*--cluod/);
    expect(() => parseArgs(['plan', '-f'])).toThrow(/Unknown option/);
    expect(() => parseArgs(['-v'])).toThrow(/Unknown option/);
    expect(() => parseArgs(['dev', 'destroy'])).toThrow(/Unsupported dev subcommand.*up, down, logs, reset/);
    expect(() => parseArgs(['regions', 'typo'])).toThrow(/Unsupported regions subcommand/);
    expect(() => parseArgs(['validate', 'one', 'two'])).toThrow(/Too many positional arguments/);
    expect(() => parseArgs(['create', 'app'])).toThrow(/replaced by `liftoff init`/);
  });

  it('rejects missing and malformed flag values', () => {
    expect(() => parseArgs(['plan', '--pattern'])).toThrow(/Missing value for --pattern/);
    expect(() => parseArgs(['plan', '--frontend=maybe'])).toThrow(/expects true or false/);
    expect(() => parseArgs(['plan', '--no-cloud'])).toThrow(/does not support the --no-cloud form/);
  });

  it('shows command help without evaluating required project options', async () => {
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();
    const code = await runCommand(parseArgs(['init', '--help']), { cwd: process.cwd(), stdout, stderr });
    expect(code).toBe(0);
    expect(stdout.text()).toContain('Usage: liftoff init [project-name]');
    expect(stdout.text()).toContain('--pattern <pattern>');
    expect(stderr.text()).toBe('');
  });

  it('reports the installed version and includes it in general help outside a project', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'liftoff-version-'));
    try {
      for (const argv of [[], ['help']]) {
        const stdout = new CaptureStream();
        const code = await runCommand(parseArgs(argv), { cwd: tempRoot, stdout, stderr: new CaptureStream() });
        expect(code).toBe(0);
        expect(stdout.text()).toContain(`Mission Control Liftoff ${liftoffVersion}`);
        expect(stdout.text()).toContain('--version');
      }

      const stdout = new CaptureStream();
      const stderr = new CaptureStream();
      const code = await runCommand(parseArgs(['--version']), { cwd: tempRoot, stdout, stderr });
      expect(code).toBe(0);
      expect(stdout.text()).toBe(`Liftoff ${liftoffVersion}\n`);
      expect(stderr.text()).toBe('');
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('rejects invalid configuration types before writing a project', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'liftoff-invalid-config-'));
    const configPath = path.join(tempRoot, 'liftoff.config.json');
    const stderr = new CaptureStream();
    try {
      await writeFile(configPath, JSON.stringify({
        projectName: 'invalid-config',
        projectType: 'standard',
        apiStack: 'node',
        cloud: 'azure',
        region: 'eastus',
        includeFrontend: 'false',
        environments: ['dev'],
        specWorkflow: 'openspec'
      }), 'utf8');
      const code = await runCommand(
        parseArgs(['init', '--config', configPath, '--yes']),
        { cwd: tempRoot, stdout: new CaptureStream(), stderr }
      );
      expect(code).toBe(1);
      expect(stderr.text()).toContain('includeFrontend must be a boolean');
      expect(await readdir(tempRoot)).toEqual(['liftoff.config.json']);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('lists all patterns', async () => {
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();

    const code = await runCommand(parseArgs(['patterns']), { cwd: process.cwd(), stdout, stderr });

    expect(code).toBe(0);
    expect(stdout.text()).toContain('multi-agent');
    expect(stdout.text()).toContain('fine-tuned');
    expect(stderr.text()).toBe('');
  });

  it('searches Azure regions', async () => {
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();

    const code = await runCommand(parseArgs(['regions', 'search', 'korea', '--cloud', 'azure']), { cwd: process.cwd(), stdout, stderr });

    expect(code).toBe(0);
    expect(stdout.text()).toContain('koreacentral');
    expect(stdout.text()).toContain('koreasouth');
  });

  it('previews a plan without writing files', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'liftoff-plan-'));
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();
    try {
      const code = await runCommand(parseArgs(['plan', '--pattern', 'rag', '--cloud', 'azure', '--frontend']), { cwd: tempRoot, stdout, stderr });

      expect(code).toBe(0);
      expect(stdout.text()).toContain('Artifacts');
      expect(stdout.text()).toContain('Coding agents: GitHub Copilot');
      expect(stdout.text()).toContain('Workstation requirements:');
      expect(stdout.text()).toContain('OpenSpec: exactly 1.6.0 [blocking]');
      expect(await readdir(tempRoot)).toEqual([]);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('previews a standard Node.js plan without writing files', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'liftoff-standard-plan-'));
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();
    try {
      const code = await runCommand(
        parseArgs(['plan', '--no-genai', '--api', 'node', '--cloud', 'azure']),
        { cwd: tempRoot, stdout, stderr }
      );

      expect(code).toBe(0);
      expect(stdout.text()).toContain('Standard application');
      expect(stdout.text()).toContain('Node.js / Fastify / TypeScript');
      expect(stdout.text()).not.toContain('Pattern:');
      expect(await readdir(tempRoot)).toEqual([]);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('creates and validates a backend-only project non-interactively', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'liftoff-create-'));
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();
    try {
      const runner = new ReadyInitRunner();
      const code = await runCommand(
        parseArgs(['init', 'claims-api', '--pattern', 'prompt', '--cloud', 'azure', '--region', 'eastus', '--spec', 'openspec', '--no-frontend', '--yes']),
        { cwd: tempRoot, stdout, stderr, runner }
      );

      expect(code).toBe(0);
      expect(stdout.text()).toContain('Initialized claims-api');
      expect(stdout.text()).toContain('Deferred project dependencies');
      expect(runner.calls.some((command) => command.args.includes('venv'))).toBe(false);
      expect(await readdir(path.join(tempRoot, 'claims-api'))).toContain('liftoff.manifest.json');

      const validateCode = await runCommand(parseArgs(['validate', 'claims-api']), { cwd: tempRoot, stdout: new CaptureStream(), stderr: new CaptureStream() });
      expect(validateCode).toBe(0);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('installs project dependencies only with independent explicit consent', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'liftoff-install-dependencies-'));
    const stdout = new CaptureStream();
    const runner = new ReadyInitRunner();
    try {
      const code = await runCommand(
        parseArgs([
          'init', 'dependency-app', '--no-genai', '--api', 'node', '--cloud', 'azure',
          '--region', 'eastus', '--spec', 'openspec', '--no-frontend', '--yes',
          '--install-dependencies'
        ]),
        { cwd: tempRoot, stdout, stderr: new CaptureStream(), runner }
      );

      expect(code).toBe(0);
      expect(stdout.text()).toContain('Project dependencies');
      expect(stdout.text()).not.toContain('Deferred project dependencies');
      expect(runner.calls).toContainEqual({ executable: 'npm', args: ['ci'] });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('creates a standard Go project non-interactively', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'liftoff-standard-create-'));
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();
    try {
      const code = await runCommand(
        parseArgs([
          'init', 'orders-api', '--no-genai', '--api', 'go', '--cloud', 'azure',
          '--region', 'eastus', '--spec', 'openspec', '--no-frontend', '--environments', 'dev,test,prod', '--yes'
        ]),
        { cwd: tempRoot, stdout, stderr, runner: new ReadyInitRunner() }
      );

      expect(code).toBe(0);
      expect(await readdir(path.join(tempRoot, 'orders-api', 'backend'))).toContain('go.mod');
      expect(stderr.text()).toBe('');
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('rejects a standard project with a GenAI pattern', async () => {
    const stderr = new CaptureStream();
    const code = await runCommand(
      parseArgs([
        'init', 'invalid', '--no-genai', '--api', 'node', '--pattern', 'rag', '--cloud', 'azure',
        '--region', 'eastus', '--spec', 'openspec', '--no-frontend', '--environments', 'dev', '--yes'
      ]),
      { cwd: process.cwd(), stdout: new CaptureStream(), stderr }
    );

    expect(code).toBe(1);
    expect(stderr.text()).toContain('cannot select a GenAI pattern');
  });

  it('runs the project lifecycle for every standard API stack', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'liftoff-standard-lifecycle-'));
    const previousRegistry = process.env.LIFTOFF_REGISTRY;
    process.env.LIFTOFF_REGISTRY = 'http://127.0.0.1:1';
    try {
      for (const [alias, stackId] of [
        ['python', 'python-fastapi'],
        ['node', 'node-fastify'],
        ['go', 'go-huma']
      ]) {
        const projectName = `standard-${alias}-api`;
        const plan = await runCommand(
          parseArgs(['plan', '--no-genai', '--api', alias, '--cloud', 'azure']),
          { cwd: tempRoot, stdout: new CaptureStream(), stderr: new CaptureStream() }
        );
        expect(plan).toBe(0);

        const init = await runCommand(
          parseArgs([
            'init', projectName, '--no-genai', '--api', alias, '--cloud', 'azure',
            '--region', 'eastus', '--spec', 'openspec', '--no-frontend', '--environments', 'dev', '--yes'
          ]),
          { cwd: tempRoot, stdout: new CaptureStream(), stderr: new CaptureStream(), runner: new ReadyInitRunner() }
        );
        expect(init).toBe(0);

        const projectRoot = path.join(tempRoot, projectName);
        const validate = await runCommand(
          parseArgs(['validate', projectRoot]),
          { cwd: tempRoot, stdout: new CaptureStream(), stderr: new CaptureStream() }
        );
        expect(validate).toBe(0);

        const updateOutput = new CaptureStream();
        const update = await runCommand(
          parseArgs(['update']),
          { cwd: projectRoot, stdout: updateOutput, stderr: new CaptureStream() }
        );
        expect(update).toBe(0);
        expect(updateOutput.text()).toContain('No drift');

        const doctorOutput = new CaptureStream();
        await runCommand(
          parseArgs(['doctor', '--json']),
          { cwd: projectRoot, stdout: doctorOutput, stderr: new CaptureStream() }
        );
        const doctor = JSON.parse(doctorOutput.text());
        expect(doctor.layers.map((layer: { title: string }) => layer.title)).toContain('Project');

        const manifest = JSON.parse(await readFile(path.join(projectRoot, 'liftoff.manifest.json'), 'utf8'));
        expect(manifest.project.apiStack).toBe(stackId);
      }
    } finally {
      if (previousRegistry === undefined) {
        delete process.env.LIFTOFF_REGISTRY;
      } else {
        process.env.LIFTOFF_REGISTRY = previousRegistry;
      }
      await rm(tempRoot, { recursive: true, force: true });
    }
  }, 120_000);

  it('preserves unrelated files in an existing named target', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'liftoff-existing-'));
    const target = path.join(tempRoot, 'existing-app');
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();
    try {
      await mkdir(target, { recursive: true });
      await writeFile(path.join(target, 'file.txt'), 'content', 'utf8');
      const code = await runCommand(
        parseArgs(['init', 'existing-app', '--pattern', 'rag', '--cloud', 'azure', '--region', 'eastus', '--spec', 'openspec', '--no-frontend', '--yes']),
        { cwd: tempRoot, stdout, stderr, runner: new ReadyInitRunner() }
      );

      expect(code).toBe(0);
      expect(await readFile(path.join(target, 'file.txt'), 'utf8')).toBe('content');
      expect(await readdir(target)).toContain('liftoff.manifest.json');
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('requires --force for listed regular-file conflicts even when --yes is present', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'liftoff-conflict-'));
    const target = path.join(tempRoot, 'existing-app');
    try {
      await mkdir(target);
      await writeFile(path.join(target, 'README.md'), 'developer content\n');
      await writeFile(path.join(target, 'unrelated.txt'), 'preserve\n');
      const base = [
        'init', 'existing-app', '--pattern', 'rag', '--cloud', 'azure', '--region', 'eastus',
        '--spec', 'openspec', '--no-frontend', '--environments', 'dev', '--yes'
      ];
      const stderr = new CaptureStream();
      expect(await runCommand(parseArgs(base), {
        cwd: tempRoot,
        stdout: new CaptureStream(),
        stderr,
        runner: new ReadyInitRunner()
      })).toBe(1);
      expect(stderr.text()).toContain('require --force');
      expect(await readFile(path.join(target, 'README.md'), 'utf8')).toBe('developer content\n');
      await expect(readFile(path.join(target, 'liftoff.manifest.json'))).rejects.toThrow();

      expect(await runCommand(parseArgs([...base, '--force']), {
        cwd: tempRoot,
        stdout: new CaptureStream(),
        stderr: new CaptureStream(),
        runner: new ReadyInitRunner()
      })).toBe(0);
      expect(await readFile(path.join(target, 'README.md'), 'utf8')).toContain('# existing-app');
      expect(await readFile(path.join(target, 'unrelated.txt'), 'utf8')).toBe('preserve\n');
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('initializes an exact Git root in place and infers its project identity', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'liftoff-in-place-'));
    try {
      await mkdir(path.join(root, '.git'));
      await writeFile(path.join(root, 'existing.txt'), 'preserve\n');
      const code = await runCommand(parseArgs([
        'init', '--pattern', 'prompt', '--cloud', 'azure', '--region', 'eastus',
        '--spec', 'openspec', '--no-frontend', '--environments', 'dev', '--yes'
      ]), {
        cwd: root,
        stdout: new CaptureStream(),
        stderr: new CaptureStream(),
        runner: new ReadyInitRunner({ gitRoot: root })
      });

      expect(code).toBe(0);
      expect(await readdir(root)).toContain('liftoff.manifest.json');
      expect(await readFile(path.join(root, 'existing.txt'), 'utf8')).toBe('preserve\n');
      const manifest = JSON.parse(await readFile(path.join(root, 'liftoff.manifest.json'), 'utf8'));
      expect(manifest.project.name).toBe(path.basename(root));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('persists canonical multi-agent Spec Kit configuration and default identity', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'liftoff-agent-init-'));
    try {
      const code = await runCommand(parseArgs([
        'init', 'agent-app', '--pattern', 'rag', '--cloud', 'azure', '--region', 'eastus',
        '--spec', 'spec-kit', '--agents', 'claude,copilot', '--default-agent', 'claude',
        '--no-frontend', '--environments', 'dev', '--yes'
      ]), {
        cwd: root,
        stdout: new CaptureStream(),
        stderr: new CaptureStream(),
        runner: new ReadyInitRunner()
      });

      expect(code).toBe(0);
      const manifest = JSON.parse(await readFile(path.join(root, 'agent-app', 'liftoff.manifest.json'), 'utf8'));
      expect(manifest.project.agents).toEqual(['github-copilot', 'claude']);
      expect(manifest.project.defaultAgent).toBe('claude');
      expect(await readFile(path.join(root, 'agent-app', '.specify', 'integration.json'), 'utf8'))
        .toContain('"default_integration": "claude"');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps --yes and --install-tools independent', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'liftoff-tool-consent-'));
    const argv = [
      'init', 'tool-app', '--pattern', 'rag', '--cloud', 'azure', '--region', 'eastus',
      '--spec', 'openspec', '--no-frontend', '--environments', 'dev', '--yes'
    ];
    try {
      const stderr = new CaptureStream();
      expect(await runCommand(parseArgs(argv), {
        cwd: root,
        stdout: new CaptureStream(),
        stderr,
        runner: new ReadyInitRunner({ missing: ['openspec'] })
      })).toBe(1);
      expect(stderr.text()).toContain('Resume with `liftoff init --install-tools`');
      await expect(readdir(path.join(root, 'tool-app'))).rejects.toThrow();

      expect(await runCommand(parseArgs([...argv, '--install-tools']), {
        cwd: root,
        stdout: new CaptureStream(),
        stderr: new CaptureStream(),
        runner: new ReadyInitRunner({ missing: ['openspec'] })
      })).toBe(0);
      expect(await readdir(path.join(root, 'tool-app'))).toContain('liftoff.manifest.json');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});