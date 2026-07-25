import picocolors, { createColors } from 'picocolors';

type Colors = ReturnType<typeof createColors>;

export type TerminalLayout = 'full' | 'compact' | 'plain';
export type StatusKind = 'success' | 'info' | 'warning' | 'error' | 'pending';
export type SemanticColor =
  | 'brand'
  | 'info'
  | 'success'
  | 'warning'
  | 'error'
  | 'pending'
  | 'command'
  | 'metadata';

export interface TerminalRendererOptions {
  stream: NodeJS.WritableStream;
  columns?: number;
  color?: boolean;
  snapshot?: boolean;
  json?: boolean;
  env?: NodeJS.ProcessEnv;
  layout?: TerminalLayout;
}

export interface PresentationSessionOptions {
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  columns?: number;
  color?: boolean;
  snapshot?: boolean;
  json?: boolean;
  env?: NodeJS.ProcessEnv;
  layout?: TerminalLayout;
}

export interface DefinitionItem {
  label: string;
  value: string;
}

export interface ChoiceItem {
  label: string;
  value?: string;
  disabled?: boolean;
  default?: boolean;
  selected?: boolean;
}

export const TERMINAL_LAYOUT = {
  compactColumns: 64,
  fullColumns: 96,
  maximumContentColumns: 92,
  minimumColumns: 20,
  indent: 2,
  sectionSpacing: 1
} as const;

export const TERMINAL_GLYPHS = {
  topLeft: '┌',
  topRight: '┐',
  bottomLeft: '└',
  bottomRight: '┘',
  horizontal: '─',
  vertical: '│',
  leftJunction: '├',
  rightJunction: '┤',
  bullet: '•',
  choice: '›',
  selected: '●',
  unselected: '○'
} as const;

export const LIFTOFF_WORDMARK = [
  '██╗     ██╗███████╗████████╗ ██████╗ ███████╗███████╗',
  '██║     ██║██╔════╝╚══██╔══╝██╔═══██╗██╔════╝██╔════╝',
  '██║     ██║█████╗     ██║   ██║   ██║█████╗  █████╗',
  '██║     ██║██╔══╝     ██║   ██║   ██║██╔══╝  ██╔══╝',
  '███████╗██║██║        ██║   ╚██████╔╝██║     ██║',
  '╚══════╝╚═╝╚═╝        ╚═╝    ╚═════╝ ╚═╝     ╚═╝'
] as const;

export const LIFTOFF_COMPACT_WORDMARK = [
  '╻  ╻┏━╸╺┳╸┏━┓┏━╸┏━╸',
  '┃  ┃┣╸  ┃ ┃ ┃┣╸ ┣╸',
  '┗━╸╹╹   ╹ ┗━┛╹  ╹'
] as const;

const ANSI_PATTERN = /\u001B\[[0-?]*[ -/]*[@-~]/g;
const ANSI_ANY_PATTERN = /\u001B\[[0-?]*[ -/]*[@-~]/;
const ANSI_AT_START_PATTERN = /^\u001B\[[0-?]*[ -/]*[@-~]/;

export function stripAnsi(value: string): string {
  return value.replace(ANSI_PATTERN, '');
}

function codePointWidth(character: string): number {
  const codePoint = character.codePointAt(0);
  if (codePoint === undefined || codePoint === 0) {
    return 0;
  }
  if (
    codePoint < 32 ||
    codePoint >= 0x7f && codePoint < 0xa0 ||
    codePoint >= 0x300 && codePoint <= 0x36f ||
    codePoint >= 0x1ab0 && codePoint <= 0x1aff ||
    codePoint >= 0x1dc0 && codePoint <= 0x1dff ||
    codePoint >= 0x20d0 && codePoint <= 0x20ff ||
    codePoint >= 0xfe20 && codePoint <= 0xfe2f ||
    codePoint >= 0xfe00 && codePoint <= 0xfe0f ||
    codePoint >= 0x1f3fb && codePoint <= 0x1f3ff
  ) {
    return 0;
  }
  if (
    codePoint >= 0x1100 && (
      codePoint <= 0x115f ||
      codePoint === 0x2329 ||
      codePoint === 0x232a ||
      codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f ||
      codePoint >= 0xac00 && codePoint <= 0xd7a3 ||
      codePoint >= 0xf900 && codePoint <= 0xfaff ||
      codePoint >= 0xfe10 && codePoint <= 0xfe19 ||
      codePoint >= 0xfe30 && codePoint <= 0xfe6f ||
      codePoint >= 0xff00 && codePoint <= 0xff60 ||
      codePoint >= 0xffe0 && codePoint <= 0xffe6 ||
      codePoint >= 0x1f300 && codePoint <= 0x1faff ||
      codePoint >= 0x20000 && codePoint <= 0x3fffd
    )
  ) {
    return 2;
  }
  return 1;
}

export function visibleLength(value: string): number {
  return Array.from(stripAnsi(value)).reduce(
    (total, character) => total + (character === '\t' ? 4 : codePointWidth(character)),
    0
  );
}

export function padVisible(value: string, width: number): string {
  return `${value}${' '.repeat(Math.max(0, width - visibleLength(value)))}`;
}

function takeVisible(value: string, width: number): string {
  let output = '';
  let used = 0;
  for (const character of Array.from(value)) {
    const characterWidth = codePointWidth(character);
    if (used + characterWidth > width) {
      break;
    }
    output += character;
    used += characterWidth;
  }
  return output;
}

function truncateVisible(value: string, width: number): string {
  const plain = stripAnsi(value);
  if (visibleLength(plain) <= width) {
    return plain;
  }
  if (width <= 1) {
    return takeVisible(plain, width);
  }
  return `${takeVisible(plain, width - 1)}…`;
}

function splitLongWord(word: string, width: number): string[] {
  const chunks: string[] = [];
  let remaining = word;
  while (remaining) {
    const chunk = takeVisible(remaining, width);
    if (!chunk) {
      break;
    }
    chunks.push(chunk);
    remaining = remaining.slice(chunk.length);
  }
  return chunks.length > 0 ? chunks : [''];
}

function wrapPlainLine(value: string, width: number, breakLongWords: boolean): string[] {
  if (visibleLength(value) <= width) {
    return [value];
  }
  const words = value.trim().split(/\s+/);
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    if (visibleLength(word) > width) {
      if (current) {
        lines.push(current);
        current = '';
      }
      if (breakLongWords) {
        const chunks = splitLongWord(word, width);
        lines.push(...chunks.slice(0, -1));
        current = chunks.at(-1) ?? '';
      } else {
        current = word;
      }
      continue;
    }
    if (!current) {
      current = word;
    } else if (visibleLength(`${current} ${word}`) <= width) {
      current += ` ${word}`;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current || lines.length === 0) {
    lines.push(current);
  }
  return lines;
}

function wrapStyledLine(value: string, width: number): string[] {
  const lines: string[] = [];
  let line = '';
  let used = 0;
  let index = 0;
  while (index < value.length) {
    const ansi = value.slice(index).match(ANSI_AT_START_PATTERN)?.[0];
    if (ansi) {
      line += ansi;
      index += ansi.length;
      continue;
    }
    const codePoint = value.codePointAt(index);
    if (codePoint === undefined) {
      break;
    }
    const character = String.fromCodePoint(codePoint);
    const characterWidth = character === '\t' ? 4 : codePointWidth(character);
    if (used > 0 && used + characterWidth > width) {
      lines.push(line.trimEnd());
      line = '';
      used = 0;
      if (/\s/.test(character)) {
        index += character.length;
        continue;
      }
    }
    line += character;
    used += characterWidth;
    index += character.length;
  }
  if (line || lines.length === 0) {
    lines.push(line.trimEnd());
  }
  return lines;
}

export function wrapVisible(value: string, width: number, breakLongWords = false): string[] {
  const safeWidth = Math.max(1, width);
  return value.split(/\r?\n/).flatMap((line) =>
    ANSI_ANY_PATTERN.test(line)
      ? wrapStyledLine(line, safeWidth)
      : wrapPlainLine(line, safeWidth, breakLongWords)
  );
}

function fitColumnWidths(natural: number[], available: number): number[] {
  const widths = natural.map((width) => Math.max(4, width));
  while (widths.reduce((total, width) => total + width, 0) > available) {
    let largestIndex = -1;
    for (let index = 0; index < widths.length; index += 1) {
      if (widths[index] > 4 && (largestIndex === -1 || widths[index] > widths[largestIndex])) {
        largestIndex = index;
      }
    }
    if (largestIndex === -1) {
      break;
    }
    widths[largestIndex] -= 1;
  }
  return widths;
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
    this.columns = Math.max(
      TERMINAL_LAYOUT.minimumColumns,
      options.columns ?? stream.columns ?? 80
    );
    this.jsonMode = options.json ?? false;
    const tty = stream.isTTY === true;
    const noColor = Object.hasOwn(env, 'NO_COLOR');
    this.colorEnabled = !this.jsonMode && !options.snapshot && !noColor &&
      (options.color ?? (tty && picocolors.isColorSupported));
    this.colors = createColors(this.colorEnabled);
    this.layout = options.layout ?? (
      this.jsonMode || (!tty && !options.snapshot)
        ? 'plain'
        : this.columns >= TERMINAL_LAYOUT.fullColumns
          ? 'full'
          : this.columns >= TERMINAL_LAYOUT.compactColumns
            ? 'compact'
            : 'plain'
    );
  }

  write(value: string): void {
    if (value) {
      this.options.stream.write(value);
    }
  }

  json(value: unknown): string {
    return `${JSON.stringify(value, null, 2)}\n`;
  }

  style(kind: SemanticColor, value: string): string {
    switch (kind) {
      case 'brand':
      case 'info':
        return this.colors.cyan(value);
      case 'success':
        return this.colors.green(value);
      case 'warning':
        return this.colors.yellow(value);
      case 'error':
        return this.colors.red(value);
      case 'command':
        return this.colors.magenta(value);
      case 'pending':
      case 'metadata':
        return this.colors.dim(value);
    }
  }

  private contentWidth(): number {
    return Math.max(
      1,
      Math.min(this.columns - 4, TERMINAL_LAYOUT.maximumContentColumns)
    );
  }

  banner(subtitle = 'Project workstation and scaffold initializer'): string {
    if (this.jsonMode) {
      return '';
    }
    if (this.layout === 'plain') {
      return `${this.colors.bold('Liftoff')} - ${subtitle}\n\n`;
    }
    if (this.layout === 'compact') {
      return [
        ...LIFTOFF_COMPACT_WORDMARK.map((line) => this.colors.bold(this.style('brand', line))),
        ...wrapVisible(subtitle, this.columns).map((line) => this.style('metadata', line)),
        ''
      ].join('\n');
    }
    const width = this.contentWidth();
    const border = `${TERMINAL_GLYPHS.topLeft}${TERMINAL_GLYPHS.horizontal.repeat(width + 2)}${TERMINAL_GLYPHS.topRight}`;
    const lines = [
      ...LIFTOFF_WORDMARK.map((line) => this.colors.bold(this.style('brand', line))),
      '',
      ...wrapVisible(subtitle, width, true).map((line) => this.style('metadata', line))
    ];
    return [
      border,
      ...lines.map((line) =>
        `${TERMINAL_GLYPHS.vertical} ${padVisible(line, width)} ${TERMINAL_GLYPHS.vertical}`
      ),
      `${TERMINAL_GLYPHS.bottomLeft}${TERMINAL_GLYPHS.horizontal.repeat(width + 2)}${TERMINAL_GLYPHS.bottomRight}`,
      ''
    ].join('\n');
  }

  commandIdentity(command: string, description: string): string {
    if (this.jsonMode) {
      return '';
    }
    const identity = `LIFTOFF / ${command.toUpperCase()}`;
    if (this.layout === 'plain') {
      return `${identity} - ${description}\n\n`;
    }
    if (this.layout === 'compact') {
      return `${[
        this.colors.bold(this.style('brand', identity)),
        ...wrapVisible(description, this.columns).map((line) => this.style('metadata', line)),
        ''
      ].join('\n')}\n`;
    }
    return this.panel(identity, [this.style('metadata', description)]);
  }

  heading(value: string): string {
    if (this.jsonMode) {
      return '';
    }
    if (this.layout === 'plain') {
      return `${this.colors.bold(value)}\n`;
    }
    const title = this.colors.bold(this.style('brand', value));
    return `${title}\n${this.style('metadata', TERMINAL_GLYPHS.horizontal.repeat(
      Math.min(visibleLength(value), this.columns)
    ))}\n`;
  }

  stage(value: string, detail?: string): string {
    if (this.jsonMode) {
      return '';
    }
    const prefix = this.layout === 'plain' ? 'Stage' : '◆';
    const label = this.colors.bold(this.style('info', `${prefix}: ${value}`));
    return `${label}${detail ? `\n${this.style('metadata', detail)}` : ''}\n`;
  }

  panel(title: string, lines: string[]): string {
    if (this.jsonMode) {
      return '';
    }
    const bodyLines = lines.length > 0 ? lines : [''];
    if (this.layout === 'plain') {
      return `${this.heading(title)}${bodyLines.flatMap((line) => line.split(/\r?\n/)).map((line) => `${line}\n`).join('')}\n`;
    }
    if (this.layout === 'compact') {
      return `${this.heading(title)}${bodyLines.flatMap((line) => wrapVisible(line, this.columns)).map((line) => `${line}\n`).join('')}\n`;
    }
    const width = this.contentWidth();
    const wrapped = bodyLines.flatMap((line) => wrapVisible(line, width, true));
    const safeTitle = truncateVisible(title, Math.max(1, width - 2));
    const styledTitle = this.colors.bold(this.style('brand', safeTitle));
    const topPrefix = `${TERMINAL_GLYPHS.horizontal} ${styledTitle} `;
    const top = `${TERMINAL_GLYPHS.topLeft}${topPrefix}${TERMINAL_GLYPHS.horizontal.repeat(
      Math.max(0, width + 2 - visibleLength(topPrefix))
    )}${TERMINAL_GLYPHS.topRight}`;
    return [
      top,
      ...wrapped.map((line) =>
        `${TERMINAL_GLYPHS.vertical} ${padVisible(line, width)} ${TERMINAL_GLYPHS.vertical}`
      ),
      `${TERMINAL_GLYPHS.bottomLeft}${TERMINAL_GLYPHS.horizontal.repeat(width + 2)}${TERMINAL_GLYPHS.bottomRight}`,
      ''
    ].join('\n');
  }

  section(title: string, lines: string[]): string {
    return this.panel(title, lines);
  }

  definitionList(title: string, items: readonly DefinitionItem[]): string {
    const labelWidth = Math.min(
      24,
      Math.max(0, ...items.map((item) => visibleLength(item.label)))
    );
    const lines = items.map((item) => {
      return `${padVisible(item.label, labelWidth)}  ${item.value}`;
    });
    if (this.layout === 'plain') {
      return `${this.heading(title)}${items.map((item) => `${item.label}: ${item.value}\n`).join('')}\n`;
    }
    return this.panel(title, lines);
  }

  bulletList(title: string, items: readonly string[]): string {
    const marker = this.layout === 'full' ? TERMINAL_GLYPHS.bullet : '-';
    return this.panel(title, items.map((item) => `${marker} ${item}`));
  }

  choiceList(title: string, choices: readonly ChoiceItem[]): string {
    const lines = choices.map((choice, index) => {
      const marker = choice.selected
        ? TERMINAL_GLYPHS.selected
        : this.layout === 'full'
          ? TERMINAL_GLYPHS.unselected
          : `${index + 1}.`;
      const number = this.layout === 'full' ? `${index + 1}.` : '';
      const value = choice.value && choice.value !== choice.label
        ? this.style('metadata', ` (${choice.value})`)
        : '';
      const state = [
        choice.default ? this.style('info', 'default') : '',
        choice.disabled ? this.style('warning', 'unavailable') : ''
      ].filter(Boolean).join(', ');
      return `${marker} ${number ? `${number} ` : ''}${choice.label}${value}${state ? ` [${state}]` : ''}`;
    });
    return this.panel(title, lines);
  }

  table(headers: readonly string[], rows: readonly (readonly string[])[]): string {
    if (this.jsonMode || headers.length === 0) {
      return '';
    }
    if (this.layout === 'plain') {
      return rows.map((row) =>
        row.map((cell, index) => `${headers[index] ?? `Column ${index + 1}`}: ${cell}`).join(' | ')
      ).join('\n') + (rows.length > 0 ? '\n' : '');
    }
    const natural = headers.map((header, index) => Math.max(
      visibleLength(header),
      ...rows.map((row) => visibleLength(row[index] ?? ''))
    ));
    const separator = '  ';
    const available = (this.layout === 'full' ? this.contentWidth() : this.columns) -
      separator.length * (headers.length - 1);
    const widths = fitColumnWidths(natural, Math.max(headers.length * 4, available));
    const renderPhysicalRow = (row: readonly string[]): string[] => {
      const wrapped = widths.map((width, index) => wrapVisible(row[index] ?? '', width, true));
      const height = Math.max(...wrapped.map((cell) => cell.length));
      return Array.from({ length: height }, (_, lineIndex) =>
        wrapped.map((cell, index) => padVisible(cell[lineIndex] ?? '', widths[index])).join(separator).trimEnd()
      );
    };
    const header = renderPhysicalRow(headers).map((line) => this.colors.bold(line));
    const separatorLine = widths.map((width) => TERMINAL_GLYPHS.horizontal.repeat(width)).join(separator);
    return [
      ...header,
      this.style('metadata', separatorLine),
      ...rows.flatMap(renderPhysicalRow),
      ''
    ].join('\n');
  }

  tableSection(
    title: string,
    headers: readonly string[],
    rows: readonly (readonly string[])[]
  ): string {
    const lines = this.table(headers, rows).trimEnd().split('\n');
    return this.layout === 'full'
      ? this.panel(title, lines)
      : `${this.heading(title)}${lines.join('\n')}\n\n`;
  }

  status(kind: StatusKind, label: string, detail?: string): string {
    if (this.jsonMode) {
      return '';
    }
    const plainTokens: Record<StatusKind, string> = {
      success: '[ok]',
      info: '[info]',
      warning: '[warn]',
      error: '[error]',
      pending: '[....]'
    };
    const richTokens: Record<StatusKind, string> = {
      success: '✓',
      info: 'i',
      warning: '!',
      error: '×',
      pending: '…'
    };
    const token = this.layout === 'plain' ? plainTokens[kind] : richTokens[kind];
    return `${this.style(kind === 'pending' ? 'pending' : kind, token)} ${this.colors.bold(label)}${detail ? `: ${detail}` : ''}\n`;
  }

  command(value: string): string {
    return this.jsonMode
      ? ''
      : `${this.style('command', '$')} ${this.colors.bold(value)}\n`;
  }

  prompt(label: string, defaultValue?: string): string {
    if (this.jsonMode) {
      return '';
    }
    const suffix = defaultValue ? ` [${defaultValue}]` : '';
    return `${this.style('warning', '?')} ${this.colors.bold(label)}${this.style('metadata', suffix)}: `;
  }

  promptContext(label: string, detail?: string): string {
    return this.panel(label, detail ? [detail] : []);
  }

  remedy(value: string): string {
    if (this.jsonMode) {
      return '';
    }
    return `${this.style('info', 'Remedy:')} ${value}\n`;
  }

  compactError(message: string, remedy?: string): string {
    if (this.jsonMode) {
      return '';
    }
    const lines = message.split(/\r?\n/).filter(Boolean);
    if (this.layout === 'full') {
      return this.panel('Error', [
        ...lines.map((line) => this.style('error', line)),
        ...(remedy ? [`${this.style('info', 'Remedy:')} ${remedy}`] : [])
      ]);
    }
    return [
      this.status('error', 'Error', lines[0] ?? message).trimEnd(),
      ...lines.slice(1).map((line) => `  ${line}`),
      ...(remedy ? [this.remedy(remedy).trimEnd()] : []),
      ''
    ].join('\n');
  }

  warning(value: string): string {
    return this.status('warning', 'Warning', value);
  }

  error(value: string, remedy?: string): string {
    return this.compactError(value, remedy);
  }

  cancellation(value: string): string {
    return this.status('info', 'Cancelled', value);
  }

  completion(
    label: string,
    detail?: string,
    items: readonly DefinitionItem[] = [],
    nextCommand?: string
  ): string {
    return [
      this.status('success', label, detail),
      ...(items.length > 0 ? [this.definitionList('Completion', items)] : []),
      ...(nextCommand ? [this.command(nextCommand)] : [])
    ].join('');
  }

  confirmation(value: string): string {
    return this.jsonMode ? '' : `${this.style('warning', '?')} ${this.colors.bold(value)}\n`;
  }
}

export class PresentationSession {
  readonly stdout: TerminalRenderer;
  readonly stderr: TerminalRenderer;
  private readonly stdoutStream: NodeJS.WritableStream;
  private readonly stderrStream: NodeJS.WritableStream;

  constructor(options: PresentationSessionOptions) {
    this.stdoutStream = options.stdout;
    this.stderrStream = options.stderr;
    const rendererOptions = {
      columns: options.columns,
      color: options.color,
      snapshot: options.snapshot,
      json: options.json,
      env: options.env,
      layout: options.layout
    };
    this.stdout = new TerminalRenderer({ stream: options.stdout, ...rendererOptions });
    this.stderr = new TerminalRenderer({ stream: options.stderr, ...rendererOptions });
  }

  identity(subtitle: string): void {
    this.stdout.write(this.stdout.banner(subtitle));
  }

  commandIdentity(command: string, description: string): void {
    this.stdout.write(this.stdout.commandIdentity(command, description));
  }

  stage(title: string, detail?: string): void {
    this.stdout.write(this.stdout.stage(title, detail));
  }

  section(title: string, lines: string[]): void {
    this.stdout.write(this.stdout.section(title, lines));
  }

  definitions(title: string, items: readonly DefinitionItem[]): void {
    this.stdout.write(this.stdout.definitionList(title, items));
  }

  bullets(title: string, items: readonly string[]): void {
    this.stdout.write(this.stdout.bulletList(title, items));
  }

  choices(title: string, choices: readonly ChoiceItem[]): void {
    this.stdout.write(this.stdout.choiceList(title, choices));
  }

  prompt(label: string, defaultValue?: string): void {
    this.stdout.write(this.stdout.prompt(label, defaultValue));
  }

  table(title: string, headers: readonly string[], rows: readonly (readonly string[])[]): void {
    this.stdout.write(this.stdout.tableSection(title, headers, rows));
  }

  status(kind: StatusKind, label: string, detail?: string): void {
    this.stdout.write(this.stdout.status(kind, label, detail));
  }

  warning(value: string): void {
    this.stdout.write(this.stdout.warning(value));
  }

  command(value: string): void {
    this.stdout.write(this.stdout.command(value));
  }

  remedy(value: string): void {
    this.stdout.write(this.stdout.remedy(value));
  }

  cancellation(value: string): void {
    this.stdout.write(this.stdout.cancellation(value));
  }

  completion(
    label: string,
    detail?: string,
    items: readonly DefinitionItem[] = [],
    nextCommand?: string
  ): void {
    this.stdout.write(this.stdout.completion(label, detail, items, nextCommand));
  }

  error(message: string, remedy?: string): void {
    if (this.stderr.jsonMode) {
      this.stderrStream.write([
        message.trimEnd(),
        ...(remedy ? [`Remedy: ${remedy}`] : [])
      ].join('\n') + '\n');
      return;
    }
    this.stderr.write(this.stderr.compactError(message, remedy));
  }

  rawStdout(value: string): void {
    this.stdoutStream.write(value);
  }

  rawStderr(value: string): void {
    this.stderrStream.write(value);
  }

  childStreams(): { stdout: NodeJS.WritableStream; stderr: NodeJS.WritableStream } {
    return {
      stdout: this.stdoutStream,
      stderr: this.stderrStream
    };
  }
}
