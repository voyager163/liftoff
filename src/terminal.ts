import picocolors, { createColors } from 'picocolors';

type Colors = ReturnType<typeof createColors>;

export type TerminalLayout = 'full' | 'compact' | 'plain';
export type StatusKind = 'success' | 'info' | 'warning' | 'error' | 'pending';

export interface TerminalRendererOptions {
  stream: NodeJS.WritableStream;
  columns?: number;
  color?: boolean;
  snapshot?: boolean;
  json?: boolean;
  env?: NodeJS.ProcessEnv;
}

export const LIFTOFF_WORDMARK = [
  ' _     ___ _____ _____ ___  _____ _____',
  '| |   |_ _|  ___|_   _/ _ \\|  ___|  ___|',
  '| |    | || |_    | || | | | |_  | |_',
  '| |___ | ||  _|   | || |_| |  _| |  _|',
  '|_____|___|_|     |_| \\___/|_|   |_|'
] as const;

const ANSI_PATTERN = /\u001B\[[0-?]*[ -/]*[@-~]/g;

export function visibleLength(value: string): number {
  return value.replace(ANSI_PATTERN, '').length;
}

function padVisible(value: string, width: number): string {
  return `${value}${' '.repeat(Math.max(0, width - visibleLength(value)))}`;
}

function wrapLine(value: string, width: number): string[] {
  if (value.length <= width) {
    return [value];
  }
  const words = value.split(/\s+/);
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    if (word.length > width) {
      if (current) {
        lines.push(current);
        current = '';
      }
      for (let index = 0; index < word.length; index += width) {
        lines.push(word.slice(index, index + width));
      }
      continue;
    }
    if (!current) {
      current = word;
    } else if (current.length + word.length + 1 <= width) {
      current += ` ${word}`;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current) {
    lines.push(current);
  }
  return lines.length > 0 ? lines : [''];
}

export class TerminalRenderer {
  readonly columns: number;
  readonly layout: TerminalLayout;
  readonly colorEnabled: boolean;
  readonly jsonMode: boolean;
  private readonly colors: Colors;

  constructor(private readonly options: TerminalRendererOptions) {
    const stream = options.stream as NodeJS.WritableStream & { isTTY?: boolean; columns?: number };
    const env = options.env ?? process.env;
    this.columns = Math.max(20, options.columns ?? stream.columns ?? 80);
    this.jsonMode = options.json ?? false;
    const tty = stream.isTTY === true;
    const noColor = Object.hasOwn(env, 'NO_COLOR');
    this.colorEnabled = !this.jsonMode && !options.snapshot && !noColor &&
      (options.color ?? (tty && !noColor && picocolors.isColorSupported));
    this.colors = createColors(this.colorEnabled);
    this.layout = this.jsonMode || (!tty && !options.snapshot)
      ? 'plain'
      : this.columns >= 96
        ? 'full'
        : this.columns >= 64
          ? 'compact'
          : 'plain';
  }

  write(value: string): void {
    if (value) {
      this.options.stream.write(value);
    }
  }

  json(value: unknown): string {
    return `${JSON.stringify(value, null, 2)}\n`;
  }

  banner(subtitle = 'Project workstation and scaffold initializer'): string {
    if (this.jsonMode) {
      return '';
    }
    if (this.layout === 'plain') {
      return `${this.colors.bold('Liftoff')} - ${subtitle}\n`;
    }
    if (this.layout === 'compact') {
      return `${this.colors.bold(this.colors.cyan('LIFTOFF'))}\n${this.colors.dim(subtitle)}\n`;
    }
    const contentWidth = Math.min(this.columns - 4, 92);
    const border = `+${'-'.repeat(contentWidth + 2)}+`;
    const lines = [
      ...LIFTOFF_WORDMARK.map((line) => this.colors.cyan(this.colors.bold(line))),
      '',
      this.colors.dim(subtitle)
    ];
    return [
      border,
      ...lines.map((line) => `| ${padVisible(line, contentWidth)} |`),
      border,
      ''
    ].join('\n');
  }

  heading(value: string): string {
    if (this.jsonMode) {
      return '';
    }
    return this.layout === 'plain'
      ? `${this.colors.bold(value)}\n`
      : `${this.colors.bold(this.colors.cyan(value))}\n${this.colors.dim('-'.repeat(Math.min(visibleLength(value), this.columns)))}\n`;
  }

  panel(title: string, lines: string[]): string {
    if (this.jsonMode) {
      return '';
    }
    if (this.layout !== 'full') {
      return `${this.heading(title)}${lines.map((line) => `${line}\n`).join('')}`;
    }
    const width = Math.min(this.columns - 4, 92);
    const body = lines.flatMap((line) => wrapLine(line, width));
    const topLabel = ` ${title} `;
    const top = `+${this.colors.bold(this.colors.cyan(topLabel))}${'-'.repeat(Math.max(0, width + 2 - topLabel.length))}+`;
    return [
      top,
      ...body.map((line) => `| ${padVisible(line, width)} |`),
      `+${'-'.repeat(width + 2)}+`,
      ''
    ].join('\n');
  }

  table(headers: string[], rows: string[][]): string {
    if (this.jsonMode) {
      return '';
    }
    if (headers.length === 0) {
      return '';
    }
    if (this.layout === 'plain' || this.columns < headers.length * 18) {
      return rows.map((row) =>
        row.map((cell, index) => `${headers[index] ?? `Column ${index + 1}`}: ${cell}`).join(' | ')
      ).join('\n') + (rows.length ? '\n' : '');
    }
    const natural = headers.map((header, index) => Math.max(
      visibleLength(header),
      ...rows.map((row) => visibleLength(row[index] ?? ''))
    ));
    const separators = (headers.length - 1) * 3;
    const available = Math.max(headers.length * 8, this.columns - separators);
    const capped = natural.map((width) => Math.min(width, Math.floor(available / headers.length)));
    const renderRow = (row: string[]) => row.map((cell, index) =>
      padVisible(cell, capped[index] ?? 8)
    ).join(' | ');
    return [
      this.colors.bold(renderRow(headers)),
      renderRow(capped.map((width) => '-'.repeat(width))),
      ...rows.map(renderRow),
      ''
    ].join('\n');
  }

  status(kind: StatusKind, label: string, detail?: string): string {
    if (this.jsonMode) {
      return '';
    }
    const tokens: Record<StatusKind, string> = {
      success: this.colors.green('[ok]'),
      info: this.colors.cyan('[info]'),
      warning: this.colors.yellow('[warn]'),
      error: this.colors.red('[error]'),
      pending: this.colors.dim('[....]')
    };
    return `${tokens[kind]} ${this.colors.bold(label)}${detail ? ` - ${detail}` : ''}\n`;
  }

  command(value: string): string {
    return this.jsonMode ? '' : `${this.colors.magenta('$')} ${this.colors.bold(value)}\n`;
  }

  warning(value: string): string {
    return this.status('warning', 'Warning', value);
  }

  error(value: string): string {
    return this.status('error', 'Error', value);
  }

  confirmation(value: string): string {
    return this.jsonMode ? '' : `${this.colors.yellow('?')} ${this.colors.bold(value)}\n`;
  }
}
