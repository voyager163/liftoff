import { describe, expect, it } from 'vitest';
import { formatCommandHelp, formatGeneralHelp } from '../src/args.js';
import { TerminalRenderer, visibleLength } from '../src/terminal.js';
import { CaptureStream } from './helpers.js';

function terminal(
  width: number,
  options: { tty?: boolean; color?: boolean; noColor?: boolean; json?: boolean; snapshot?: boolean } = {}
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
  it('renders stable full, compact, and plain banner snapshots', () => {
    expect(terminal(100).banner('Ready for launch')).toMatchInlineSnapshot(`
      "+----------------------------------------------------------------------------------------------+
      |  _     ___ _____ _____ ___  _____ _____                                                      |
      | | |   |_ _|  ___|_   _/ _ \\|  ___|  ___|                                                     |
      | | |    | || |_    | || | | | |_  | |_                                                        |
      | | |___ | ||  _|   | || |_| |  _| |  _|                                                       |
      | |_____|___|_|     |_| \\___/|_|   |_|                                                         |
      |                                                                                              |
      | Ready for launch                                                                             |
      +----------------------------------------------------------------------------------------------+
      "
    `);
    expect(terminal(80).banner('Ready for launch')).toMatchInlineSnapshot(`
      "LIFTOFF
      Ready for launch
      "
    `);
    expect(terminal(50).banner('Ready for launch')).toMatchInlineSnapshot(`
      "Liftoff - Ready for launch
      "
    `);
  });

  it('selects layouts by visible terminal capability', () => {
    expect(terminal(100).layout).toBe('full');
    expect(terminal(80).layout).toBe('compact');
    expect(terminal(50).layout).toBe('plain');
    expect(terminal(120, { tty: false, snapshot: false }).layout).toBe('plain');
  });

  it('honors color support and NO_COLOR without corrupting visible width', () => {
    const colored = terminal(80, { color: true }).status('success', 'Node.js', 'ready');
    const disabled = terminal(80, { color: true, noColor: true }).status('success', 'Node.js', 'ready');
    const plain = terminal(80, { tty: false, color: false }).status('success', 'Node.js', 'ready');

    expect(colored).toMatch(/\u001B\[/);
    expect(disabled).not.toMatch(/\u001B\[/);
    expect(plain).not.toMatch(/\u001B\[/);
    expect(visibleLength(colored)).toBe(plain.length);
  });

  it('bypasses decorative output in JSON mode', () => {
    const renderer = terminal(100, { json: true });
    expect(renderer.banner()).toBe('');
    expect(renderer.status('success', 'Ready')).toBe('');
    expect(renderer.json({ status: 'ready' })).toBe('{\n  "status": "ready"\n}\n');
  });

  it('renders responsive panels, tables, statuses, and commands without ANSI in snapshots', () => {
    const renderer = terminal(80);
    const output = [
      renderer.panel('Readiness', ['Node.js 20.19.0', 'OpenSpec 1.6.0']),
      renderer.table(['Tool', 'State'], [['Node.js', 'ready'], ['Docker', 'warning']]),
      renderer.status('warning', 'Docker', 'daemon is stopped'),
      renderer.command('liftoff init --install-tools')
    ].join('');

    expect(output).toMatchInlineSnapshot(`
      "Readiness
      ---------
      Node.js 20.19.0
      OpenSpec 1.6.0
      Tool    | State  
      ------- | -------
      Node.js | ready  
      Docker  | warning
      [warn] Docker - daemon is stopped
      $ liftoff init --install-tools
      "
    `);
    expect(output).not.toMatch(/\u001B\[/);
  });
});

describe('generated help metadata', () => {
  it('groups commands by the onboarding hierarchy', () => {
    const help = formatGeneralHelp('0.4.0');
    expect(help.indexOf('Onboarding:')).toBeLessThan(help.indexOf('Maintenance:'));
    expect(help.indexOf('Maintenance:')).toBeLessThan(help.indexOf('Reference:'));
    expect(help).toContain('Run `liftoff help <command>`');
  });

  it('shares flag metavariables, descriptions, and defaults with command help', () => {
    const help = formatCommandHelp('init');
    expect(help).toContain('--agents <list>');
    expect(help).toContain('default: copilot');
    expect(help).toContain('Consent options:');
    expect(help).toContain('--install-tools');
  });
});
