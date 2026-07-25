import { describe, expect, it } from 'vitest';
import {
  LIFTOFF_COMPACT_WORDMARK,
  LIFTOFF_WORDMARK,
  PresentationSession,
  TERMINAL_LAYOUT,
  TerminalRenderer,
  stripAnsi,
  visibleLength,
  wrapVisible
} from '../src/terminal.js';
import { formatCommandHelp, formatGeneralHelp, getCommandHelp, getGeneralHelp } from '../src/args.js';
import { CaptureStream } from './helpers.js';

function terminal(
  width: number,
  options: {
    tty?: boolean;
    color?: boolean;
    noColor?: boolean;
    json?: boolean;
    snapshot?: boolean;
  } = {}
) {
  const stream = new CaptureStream() as CaptureStream & { isTTY?: boolean; columns?: number };
  stream.isTTY = options.tty ?? true;
  stream.columns = width;
  return new TerminalRenderer({
    stream,
    snapshot: options.snapshot ?? options.color === undefined,
    color: options.color,
    json: options.json,
    env: options.noColor ? { NO_COLOR: '1' } : {}
  });
}

describe('terminal renderer', () => {
  it('renders stable rich, compact, and plain identities', () => {
    expect(terminal(100).banner('Ready for launch')).toMatchInlineSnapshot(`
      "┌──────────────────────────────────────────────────────────────────────────────────────────────┐
      │ ██╗     ██╗███████╗████████╗ ██████╗ ███████╗███████╗                                        │
      │ ██║     ██║██╔════╝╚══██╔══╝██╔═══██╗██╔════╝██╔════╝                                        │
      │ ██║     ██║█████╗     ██║   ██║   ██║█████╗  █████╗                                          │
      │ ██║     ██║██╔══╝     ██║   ██║   ██║██╔══╝  ██╔══╝                                          │
      │ ███████╗██║██║        ██║   ╚██████╔╝██║     ██║                                             │
      │ ╚══════╝╚═╝╚═╝        ╚═╝    ╚═════╝ ╚═╝     ╚═╝                                             │
      │                                                                                              │
      │ Ready for launch                                                                             │
      └──────────────────────────────────────────────────────────────────────────────────────────────┘
      "
    `);
    expect(terminal(80).banner('Ready for launch')).toMatchInlineSnapshot(`
      "╻  ╻┏━╸╺┳╸┏━┓┏━╸┏━╸
      ┃  ┃┣╸  ┃ ┃ ┃┣╸ ┣╸
      ┗━╸╹╹   ╹ ┗━┛╹  ╹
      Ready for launch
      "
    `);
    expect(terminal(50).banner('Ready for launch')).toBe(
      'Liftoff - Ready for launch\n\n'
    );
    expect(LIFTOFF_WORDMARK).toHaveLength(6);
    expect(LIFTOFF_COMPACT_WORDMARK).toHaveLength(3);
  });

  it('selects layouts at every centralized threshold boundary', () => {
    expect(terminal(TERMINAL_LAYOUT.fullColumns).layout).toBe('full');
    expect(terminal(TERMINAL_LAYOUT.fullColumns - 1).layout).toBe('compact');
    expect(terminal(TERMINAL_LAYOUT.compactColumns).layout).toBe('compact');
    expect(terminal(TERMINAL_LAYOUT.compactColumns - 1).layout).toBe('plain');
    expect(terminal(120, { tty: false, snapshot: false }).layout).toBe('plain');
  });

  it('keeps threshold-boundary screens within their selected terminal width', () => {
    for (const width of [
      TERMINAL_LAYOUT.compactColumns - 1,
      TERMINAL_LAYOUT.compactColumns,
      TERMINAL_LAYOUT.fullColumns - 1,
      TERMINAL_LAYOUT.fullColumns
    ]) {
      const renderer = terminal(width);
      const output = [
        renderer.commandIdentity(
          'doctor',
          'Inspect project structure, workstation tools, and local service readiness'
        ),
        renderer.panel('Readiness', [
          'Node.js, OpenSpec, Docker, and coding-agent checks remain readable at boundary widths.'
        ])
      ].join('');
      if (renderer.layout !== 'plain') {
        expect(output.split('\n').every((line) => visibleLength(line) <= width)).toBe(true);
      }
      if (renderer.layout === 'full') {
        const borders = output.split('\n').filter((line) => /^[┌└]/u.test(line));
        expect(borders.length).toBeGreaterThan(0);
        expect(borders.every((line) => visibleLength(line) === width)).toBe(true);
      } else {
        expect(output).not.toMatch(/[┌┐└┘│]/u);
      }
    }
  });

  it('handles ANSI-styled Unicode width, padding, and wrapping', () => {
    const styled = '\u001B[36m漢🚀e\u0301\u001B[39m';
    expect(visibleLength(styled)).toBe(5);
    expect(stripAnsi(styled)).toBe('漢🚀e\u0301');
    const wrapped = wrapVisible(
      '\u001B[36mA long styled Unicode value with 漢字 and 🚀 launch details\u001B[39m',
      18
    );
    expect(wrapped.length).toBeGreaterThan(1);
    expect(wrapped.every((line) => visibleLength(line) <= 18)).toBe(true);

    const panel = terminal(96).panel('Unicode alignment', [
      'Windows path C:\\workspace\\launch-app\\backend and 漢字 remain inside the panel.'
    ]);
    expect(panel.split('\n').every((line) => visibleLength(line) <= 96)).toBe(true);
  });

  it('honors semantic color and NO_COLOR without corrupting visible width', () => {
    const coloredRenderer = terminal(80, { color: true });
    const disabledRenderer = terminal(80, { color: true, noColor: true });
    const colored = coloredRenderer.status('success', 'Node.js', 'ready');
    const disabled = disabledRenderer.status('success', 'Node.js', 'ready');

    expect(colored).toMatch(/\u001B\[/);
    expect(disabled).not.toMatch(/\u001B\[/);
    expect(visibleLength(colored)).toBe(visibleLength(disabled));
    for (const kind of [
      'brand',
      'info',
      'success',
      'warning',
      'error',
      'pending',
      'command',
      'metadata'
    ] as const) {
      expect(coloredRenderer.style(kind, kind)).toMatch(/\u001B\[/);
      expect(disabledRenderer.style(kind, kind)).toBe(kind);
    }
  });

  it('bypasses decorative output in JSON mode', () => {
    const renderer = terminal(100, { json: true });
    expect(renderer.banner()).toBe('');
    expect(renderer.status('success', 'Ready')).toBe('');
    expect(renderer.commandIdentity('doctor', 'Readiness')).toBe('');
    expect(renderer.json({ status: 'ready' })).toBe('{\n  "status": "ready"\n}\n');
  });

  it('renders responsive panels, tables, statuses, and commands in compact mode', () => {
    const renderer = terminal(80);
    const output = [
      renderer.panel('Readiness', ['Node.js 20.19.0', 'OpenSpec 1.6.0']),
      renderer.table(['Tool', 'State'], [['Node.js', 'ready'], ['Docker', 'warning']]),
      renderer.status('warning', 'Docker', 'daemon is stopped'),
      renderer.command('liftoff init --install-tools')
    ].join('');

    expect(output).toMatchInlineSnapshot(`
      "Readiness
      ─────────
      Node.js 20.19.0
      OpenSpec 1.6.0

      Tool     State
      ───────  ───────
      Node.js  ready
      Docker   warning
      ! Docker: daemon is stopped
      $ liftoff init --install-tools
      "
    `);
    expect(output).not.toMatch(/\u001B\[/);
  });

  it('keeps redirected presentation deterministic, ASCII-only, and copyable', () => {
    const renderer = terminal(40, { tty: false, snapshot: false, color: false });
    const output = [
      renderer.commandIdentity('regions', 'Cloud deployment regions'),
      renderer.table(
        ['Identifier', 'Path', 'Command'],
        [['eastus', 'C:\\workspace\\launch-app', 'npm.cmd ci']]
      ),
      renderer.compactError('Region is unavailable.', 'Run `liftoff providers`.')
    ].join('');

    expect(output).toContain('Identifier: eastus');
    expect(output).toContain('C:\\workspace\\launch-app');
    expect(output).toContain('npm.cmd ci');
    expect(output).not.toMatch(/\u001B\[/);
    expect(output).not.toMatch(/[┌┐└┘│─]/);
  });

  it('keeps presentation sessions bound to their original raw streams', () => {
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();
    const session = new PresentationSession({ stdout, stderr, snapshot: true, columns: 100 });
    const childStreams = session.childStreams();

    expect(childStreams).toEqual({ stdout, stderr });
    session.stage('External command');
    childStreams.stdout.write('raw-out\r\n');
    childStreams.stderr.write('raw-err\r\n');

    expect(stdout.text()).toContain('raw-out\r\n');
    expect(stderr.text()).toBe('raw-err\r\n');
  });
});

describe('generated help metadata', () => {
  it('groups commands by the onboarding hierarchy', () => {
    const model = getGeneralHelp('0.4.0');
    const help = formatGeneralHelp('0.4.0');
    expect(model.commandGroups.map((group) => group.title)).toEqual([
      'Onboarding',
      'Maintenance',
      'Reference',
      'Operations'
    ]);
    expect(help.indexOf('Onboarding:')).toBeLessThan(help.indexOf('Maintenance:'));
    expect(help.indexOf('Maintenance:')).toBeLessThan(help.indexOf('Reference:'));
    expect(help).toContain('Run `liftoff help <command>`');
  });

  it('shares arguments, flag metavariables, descriptions, and defaults with command help', () => {
    const model = getCommandHelp('init');
    const help = formatCommandHelp('init');
    expect(model.arguments).toContainEqual({
      syntax: 'project-name',
      description: 'Project identity or child directory name'
    });
    expect(help).toContain('--agents <list>');
    expect(help).toContain('default: copilot');
    expect(help).toContain('Consent options:');
    expect(help).toContain('--install-tools');
  });
});
