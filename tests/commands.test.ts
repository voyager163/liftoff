import path from 'node:path';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { describe, expect, it } from 'vitest';
import { parseArgs } from '../src/args.js';
import { runCommand } from '../src/commands.js';
import { CaptureStream } from './helpers.js';

describe('commands', () => {
  it('parses create positional arguments without treating them as subcommands', () => {
    const parsed = parseArgs(['create', 'my-app', '--pattern', 'rag', '--cloud', 'azure']);

    expect(parsed.command).toBe('create');
    expect(parsed.subcommand).toBeUndefined();
    expect(parsed.positional).toEqual(['my-app']);
    expect(parsed.flags.pattern).toBe('rag');
  });

  it('parses standard project flags', () => {
    const parsed = parseArgs(['create', 'my-api', '--no-genai', '--api', 'node']);

    expect(parsed.flags.genai).toBe(false);
    expect(parsed.flags.api).toBe('node');
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
    expect(() => parseArgs(['create', 'app', '--cluod', 'aws'])).toThrow(/Unknown flag.*--cluod/);
    expect(() => parseArgs(['plan', '-f'])).toThrow(/Unknown option/);
    expect(() => parseArgs(['dev', 'destroy'])).toThrow(/Unsupported dev subcommand.*up, down, logs, reset/);
    expect(() => parseArgs(['regions', 'typo'])).toThrow(/Unsupported regions subcommand/);
    expect(() => parseArgs(['validate', 'one', 'two'])).toThrow(/Too many positional arguments/);
  });

  it('rejects missing and malformed flag values', () => {
    expect(() => parseArgs(['plan', '--pattern'])).toThrow(/Missing value for --pattern/);
    expect(() => parseArgs(['plan', '--frontend=maybe'])).toThrow(/expects true or false/);
    expect(() => parseArgs(['plan', '--no-cloud'])).toThrow(/does not support the --no-cloud form/);
  });

  it('shows command help without evaluating required project options', async () => {
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();
    const code = await runCommand(parseArgs(['create', '--help']), { cwd: process.cwd(), stdout, stderr });
    expect(code).toBe(0);
    expect(stdout.text()).toContain('Usage: liftoff create [project-name]');
    expect(stdout.text()).toContain('--pattern <value>');
    expect(stderr.text()).toBe('');
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
        parseArgs(['create', '--config', configPath, '--yes']),
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
      const code = await runCommand(
        parseArgs(['create', 'claims-api', '--pattern', 'prompt', '--cloud', 'azure', '--region', 'eastus', '--spec', 'openspec', '--no-frontend', '--yes']),
        { cwd: tempRoot, stdout, stderr }
      );

      expect(code).toBe(0);
      expect(stdout.text()).toContain('Created claims-api');
      expect(await readdir(path.join(tempRoot, 'claims-api'))).toContain('liftoff.manifest.json');

      const validateCode = await runCommand(parseArgs(['validate', 'claims-api']), { cwd: tempRoot, stdout: new CaptureStream(), stderr: new CaptureStream() });
      expect(validateCode).toBe(0);
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
          'create', 'orders-api', '--no-genai', '--api', 'go', '--cloud', 'azure',
          '--region', 'eastus', '--spec', 'openspec', '--no-frontend', '--environments', 'dev,test,prod', '--yes'
        ]),
        { cwd: tempRoot, stdout, stderr }
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
        'create', 'invalid', '--no-genai', '--api', 'node', '--pattern', 'rag', '--cloud', 'azure',
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

        const create = await runCommand(
          parseArgs([
            'create', projectName, '--no-genai', '--api', alias, '--cloud', 'azure',
            '--region', 'eastus', '--spec', 'openspec', '--no-frontend', '--environments', 'dev', '--yes'
          ]),
          { cwd: tempRoot, stdout: new CaptureStream(), stderr: new CaptureStream() }
        );
        expect(create).toBe(0);

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
  }, 30_000);

  it('rejects non-empty create targets', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'liftoff-existing-'));
    const target = path.join(tempRoot, 'existing-app');
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();
    try {
      await mkdir(target, { recursive: true });
      await writeFile(path.join(target, 'file.txt'), 'content', 'utf8');
      const code = await runCommand(
        parseArgs(['create', 'existing-app', '--pattern', 'rag', '--cloud', 'azure', '--region', 'eastus', '--spec', 'openspec', '--no-frontend', '--yes']),
        { cwd: tempRoot, stdout, stderr }
      );

      expect(code).toBe(1);
      expect(stderr.text()).toContain('must be new or empty');
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});