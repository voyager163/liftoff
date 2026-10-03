import { createHash } from 'node:crypto';
import { types } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const hclComputationPolicy = Object.freeze({
  kind: 'liftoff-hcl-computation-policy', version: 2, protocolVersion: 2,
  parserPackage: '@cdktf/hcl2json', parserPackageVersion: '0.21.0',
  qualifiedRuntime: Object.freeze({ platform: 'darwin', arch: 'arm64', node: '24.21.0' }),
  wasmPages: 2048, v8OldSpaceMiB: 128, v8SemiSpaceMiB: 8, childDeadlineMs: 10000,
  terminationGraceMs: 1000, derivationDeadlineMs: 60000, sourceFileBytes: 1048576,
  derivationSourceBytes: 8388608, derivationDocuments: 512, batchDocuments: 32,
  batchSourceBytes: 1048576, batchTargetBytes: 65536, derivationChildren: 64,
  requestBytes: 6356992, stdoutBytes: 8388608, stderrBytes: 65536, derivationReplyBytes: 33554432,
  replyEnvelopeNodes: 2000000, replyEnvelopeDepth: 256, replyDecodedStringBytes: 8388608,
  concurrentChildren: 1, waitingDerivations: 0, parsedVisits: 500000, expressionRequests: 2048,
  expressionDepth: 64, order: 'captured-source-order', largeSingleSource: 'own-child-with-unchanged1MiB-cap',
  settlement: 'direct-owned-child-exit-close-and-pid-absence', totalRssLimit: 'not-claimed',
  sandbox: 'not-an-os-sandbox', sideEffects: 'installed-parser-resource-loads-and-owned-neutral-workspace-only',
  replyContract: 'closed-json-results-and-complete-template-parent-source-bound-static-object-key-asts-v2',
  objectKeyContract: 'paired-object-only-opaque-markers-utf8-byte-anchored-bare-or-unescaped-quoted-atoms-with-parent-spans',
  objectMembership: 'one-to-one-raw-items-and-ordered-key-value-children-no-collapsed-or-duplicate-literal-keys',
  objectSyntax: 'whitespace-comma-or-newline-separated-static-keys-no-comments-computed-parenthesized-or-interpolated-keys',
  errors: Object.freeze(['invalid-request', 'computation-unavailable', 'transport-limit', 'expression-limit'])
});

export class IsolatedHclError extends Error {}
export function hclFailure(message: string): never { throw new IsolatedHclError(message); }
export const hclRawDigest = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');
export function canonicalHclProtocol(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalHclProtocol).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalHclProtocol(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
export const hclPolicyDigest = hclRawDigest(canonicalHclProtocol(hclComputationPolicy));

export function ownHclRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) hclFailure('Invalid isolated parser record.');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== keys.length || keys.some(key => !descriptors[key]?.enumerable || !Object.hasOwn(descriptors[key], 'value'))) {
    hclFailure('Invalid isolated parser record fields.');
  }
  return value as Record<string, unknown>;
}
export function validateHclTransport(value: unknown): void {
  const pending: { value: unknown; depth: number }[] = [{ value, depth: 0 }];
  let count = 0, bytes = 0;
  while (pending.length) {
    const { value: entry, depth } = pending.pop()!;
    if (++count > hclComputationPolicy.replyEnvelopeNodes || depth > hclComputationPolicy.replyEnvelopeDepth) hclFailure('Isolated parser transport structure limit.');
    if (typeof entry === 'string') bytes += Buffer.byteLength(entry);
    else if (entry !== null && typeof entry === 'object') {
      if (types.isProxy(entry) || ![Object.prototype, Array.prototype, null].includes(Object.getPrototypeOf(entry))) hclFailure('Isolated parser transport is not plain data.');
      const array = Array.isArray(entry), descriptors = Object.getOwnPropertyDescriptors(entry);
      const keys = Reflect.ownKeys(entry);
      if (keys.length + count + pending.length > hclComputationPolicy.replyEnvelopeNodes + 1 ||
          array && (Object.getPrototypeOf(entry) !== Array.prototype || keys.length !== entry.length + 1)) hclFailure('Isolated parser transport collection limit.');
      for (const key of keys) {
        if (array && key === 'length') continue;
        const descriptor = descriptors[key as string];
        if (typeof key !== 'string' || !descriptor?.enumerable || !Object.hasOwn(descriptor, 'value') ||
            ['__proto__', 'constructor', 'prototype', 'toJSON'].includes(key) ||
            array && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= entry.length)) hclFailure('Isolated parser transport contains hooks or sparse data.');
        bytes += Buffer.byteLength(key);
        pending.push({ value: descriptor.value, depth: depth + 1 });
      }
    } else if (entry !== null && typeof entry !== 'boolean' && !(typeof entry === 'number' && Number.isFinite(entry))) {
      hclFailure('Invalid isolated parser transport value.');
    }
    if (bytes > hclComputationPolicy.replyDecodedStringBytes) hclFailure('Isolated parser decoded string limit.');
  }
}

export interface HclDocument { id: string; sourceSha256: string; text: string }
export interface HclRequest {
  schemaVersion: 2; policyDigest: string; requestId: string;
  expressionAllowance: number; replyAllowance: number; documents: readonly HclDocument[];
}
export type HclExpressionType =
  | 'template' | 'templateWrap' | 'tuple' | 'literalValue' | 'scopeTraversal' | 'relativeTraversal'
  | 'function' | 'for' | 'index' | 'splat' | 'conditional' | 'unaryOp' | 'binaryOp' | 'object';
export interface HclExpressionNode {
  type: HclExpressionType;
  meta: Record<string, unknown>;
  children: HclExpression[];
  range: unknown;
}
/** The dependency's real marker, admitted only as a source-bound static object key. */
export interface HclStaticObjectKey {
  type: '';
  children: HclExpression[];
  range: unknown;
}
export type HclExpression = HclExpressionNode | HclStaticObjectKey;
export interface HclResult { id: string; sourceSha256: string; parsed: Record<string, unknown> }
export interface HclExpressionResult { value: string; sourceSha256: string; ast: HclExpression }
export interface HclReply {
  schemaVersion: 2; policyDigest: string; requestId: string; status: 'ok';
  results: HclResult[]; expressions: HclExpressionResult[]; expressionCalls: number;
}
function integer(value: unknown, maximum: number): asserts value is number {
  if (!Number.isSafeInteger(value) || typeof value !== 'number' || value < 0 || value > maximum) hclFailure('Invalid isolated parser integer.');
}
export function makeHclRequest(documents: readonly HclDocument[], expressionAllowance: number, replyAllowance: number): HclRequest {
  const body = { schemaVersion: 2 as const, policyDigest: hclPolicyDigest, expressionAllowance, replyAllowance, documents };
  return { ...body, requestId: hclRawDigest(canonicalHclProtocol(body)) };
}
function validateRequest(value: unknown): HclRequest {
  validateHclTransport(value);
  const record = ownHclRecord(value, ['schemaVersion', 'policyDigest', 'requestId', 'expressionAllowance', 'replyAllowance', 'documents']);
  if (record.schemaVersion !== 2 || record.policyDigest !== hclPolicyDigest || !Array.isArray(record.documents) ||
      !record.documents.length || record.documents.length > hclComputationPolicy.batchDocuments) hclFailure('Invalid isolated parser request.');
  integer(record.expressionAllowance, hclComputationPolicy.expressionRequests);
  integer(record.replyAllowance, hclComputationPolicy.stdoutBytes);
  if (!record.replyAllowance) hclFailure('Isolated parser reply budget exhausted.');
  const documents: HclDocument[] = [];
  let bytes = 0;
  for (const [index, entry] of record.documents.entries()) {
    const file = ownHclRecord(entry, ['id', 'sourceSha256', 'text']);
    if (file.id !== String(index) || typeof file.text !== 'string' || hclRawDigest(file.text) !== file.sourceSha256) hclFailure('Invalid isolated parser document binding.');
    bytes += Buffer.byteLength(file.text);
    if (Buffer.byteLength(file.text) > hclComputationPolicy.sourceFileBytes || bytes > hclComputationPolicy.batchSourceBytes) hclFailure('Isolated parser source limit.');
    documents.push({ id: file.id, text: file.text, sourceSha256: String(file.sourceSha256) });
  }
  const request = makeHclRequest(documents, record.expressionAllowance, record.replyAllowance);
  if (request.requestId !== record.requestId) hclFailure('Invalid isolated parser request digest.');
  return request;
}
export function hclExpressionSource(value: string): string {
  let delimiter = 'LIFTOFF_REPAIR_EXPRESSION';
  while (value.includes(delimiter)) delimiter += '_';
  return `<<${delimiter}\n${value}\n${delimiter}\n`;
}
export function hclExpressionStrings(parsed: unknown): string[] {
  const pending = [parsed], strings = new Set<string>();
  while (pending.length) {
    const value = pending.pop();
    if (typeof value === 'string' && (value.includes('${') || value.includes('%{'))) strings.add(value);
    else if (Array.isArray(value)) for (let index = value.length - 1; index >= 0; index--) pending.push(value[index]);
    else if (value && typeof value === 'object') {
      const record = value as Record<string, unknown>;
      for (const name of Object.keys(record).sort().reverse()) pending.push(record[name]);
    }
  }
  return [...strings];
}

function validateAst(value: unknown, source: string): asserts value is HclExpression {
  const sourceBytes = Buffer.from(source), maximumBytes = sourceBytes.length;
  function range(value: unknown): { start: number; end: number } {
    const span = ownHclRecord(value, ['start', 'end']);
    const start = ownHclRecord(span.start, ['line', 'column', 'byte']);
    const end = ownHclRecord(span.end, ['line', 'column', 'byte']);
    for (const marker of [start, end]) {
      integer(marker.byte, maximumBytes); integer(marker.line, maximumBytes + 1); integer(marker.column, maximumBytes + 1);
    }
    if (Number(start.byte) > Number(end.byte)) hclFailure('Invalid HCL AST range.');
    return { start: Number(start.byte), end: Number(end.byte) };
  }
  function sourceSlice(start: number, end: number): string {
    integer(start, maximumBytes); integer(end, maximumBytes);
    if (end < start) hclFailure('Invalid HCL source span.');
    const bytes = sourceBytes.subarray(start, end), text = bytes.toString('utf8');
    if (!Buffer.from(text).equals(bytes)) hclFailure('HCL source span splits a UTF-8 character.');
    return text;
  }
  function expressionSpan(node: Record<string, unknown>, meta: Record<string, unknown>, root = false) {
    const observed = range(node.range);
    if (root) {
      if (node.type !== 'template' || meta.value !== source.slice(0, -1)) hclFailure('HCL AST root source mismatch.');
      return { start: 0, end: maximumBytes };
    }
    const raw = meta.value;
    if (typeof raw !== 'string' && !(node.type === 'literalValue' && (raw === null || typeof raw === 'number' || typeof raw === 'boolean'))) {
      hclFailure('Invalid HCL expression source metadata.');
    }
    const text = String(raw), start = observed.start - (node.type === 'template' && text.startsWith('"') ? 1 : 0);
    const end = start + Buffer.byteLength(text);
    if (sourceSlice(start, end) !== text || observed.end > end) hclFailure('HCL expression range or metadata differs from its actual source bytes.');
    return { start, end };
  }
  function staticKey(value: unknown): { raw: string; literal: string; start: number; end: number } {
    const marker = ownHclRecord(value, ['type', 'children', 'range']);
    if (marker.type !== '' || !Array.isArray(marker.children)) hclFailure('Invalid object-key marker.');
    const span = range(marker.range), atom = sourceSlice(span.start, span.end);
    if (marker.children.length === 0 && /^[A-Za-z_][A-Za-z0-9_-]*$/u.test(atom)) {
      return { raw: atom, literal: atom, ...span };
    }
    if (marker.children.length !== 1 || !atom || /["\\$\u0000-\u001f]|%\{/u.test(atom) ||
        span.start < 1 || span.end >= maximumBytes ||
        sourceSlice(span.start - 1, span.start) !== '"' || sourceSlice(span.end, span.end + 1) !== '"') {
      hclFailure('Unsupported opaque object key; only source-proven static atoms are admitted.');
    }
    const template = ownHclRecord(marker.children[0], ['type', 'meta', 'children', 'range']);
    const meta = ownHclRecord(template.meta, ['value']), raw = `"${atom}"`;
    if (template.type !== 'template' || meta.value !== raw || !Array.isArray(template.children) || template.children.length !== 1 ||
        canonicalHclProtocol(template.range) !== canonicalHclProtocol(marker.range)) hclFailure('Invalid quoted object-key correspondence.');
    const literal = ownHclRecord(template.children[0], ['type', 'meta', 'children', 'range']);
    const literalMeta = ownHclRecord(literal.meta, ['type', 'value']);
    if (literal.type !== 'literalValue' || literalMeta.type !== 'string' || literalMeta.value !== atom ||
        !Array.isArray(literal.children) || literal.children.length !== 0 ||
        canonicalHclProtocol(literal.range) !== canonicalHclProtocol(marker.range)) hclFailure('Invalid quoted object-key literal.');
    return { raw, literal: atom, start: span.start - 1, end: span.end + 1 };
  }
  function objectMembers(node: Record<string, unknown>, meta: Record<string, unknown>): { start: number; end: number }[] {
    const span = range(node.range), raw = meta.value;
    if (typeof raw !== 'string' || !raw.startsWith('{') || !raw.endsWith('}') ||
        span.end !== span.start + 1 || !Array.isArray(node.children) || node.children.length % 2 !== 0) {
      hclFailure('Invalid HCL object span or paired children.');
    }
    const end = span.start + Buffer.byteLength(raw);
    if (sourceSlice(span.start, end) !== raw) hclFailure('HCL object metadata differs from its actual source bytes.');
    const items = meta.items;
    if (!items || typeof items !== 'object' || Array.isArray(items)) hclFailure('Invalid HCL object membership.');
    const itemRecord = items as Record<string, unknown>, names = Object.keys(itemRecord);
    if (names.length !== node.children.length / 2) hclFailure('Collapsed or missing HCL object keys.');
    const seen = new Set<string>(), literals = new Set<string>();
    const positions: { start: number; end: number }[] = [];
    let cursor = span.start + 1;
    for (let index = 0; index < node.children.length; index += 2) {
      const atom = staticKey(node.children[index]);
      if (atom.start < cursor || atom.end > end - 1) hclFailure('HCL key is outside its ordered object position.');
      const gap = sourceSlice(cursor, atom.start);
      if (index === 0 ? !/^[ \t\r\n]*$/u.test(gap) :
        !/^(?:[ \t\r\n]*,[ \t\r\n]*|[ \t]*\r?\n[ \t\r\n]*)$/u.test(gap)) {
        hclFailure('Unsupported or ambiguous object member delimiter.');
      }
      if (seen.has(atom.raw) || literals.has(atom.literal) || !Object.hasOwn(itemRecord, atom.raw)) {
        hclFailure('Duplicate, reordered or unrepresented HCL object key.');
      }
      seen.add(atom.raw); literals.add(atom.literal);
      const member = ownHclRecord(node.children[index + 1], ['type', 'meta', 'children', 'range']);
      const memberMeta = member.meta;
      if (!memberMeta || typeof memberMeta !== 'object' || Array.isArray(memberMeta)) hclFailure('Missing HCL object value metadata.');
      const rawValue = itemRecord[atom.raw];
      if (typeof rawValue !== 'string' || !rawValue || (memberMeta as Record<string, unknown>).value !== rawValue) {
        hclFailure('HCL object key/value metadata mismatch.');
      }
      const separator = sourceSlice(atom.end, end - 1).match(/^[ \t\r\n]*[=:][ \t\r\n]*/u)?.[0];
      if (!separator) hclFailure('Unsupported HCL object assignment delimiter.');
      const valueStart = atom.end + Buffer.byteLength(separator), valueEnd = valueStart + Buffer.byteLength(rawValue);
      if (valueEnd > end - 1 || sourceSlice(valueStart, valueEnd) !== rawValue) hclFailure('HCL object value differs from its source position.');
      const valueRange = range(member.range);
      if (member.type === 'template' && rawValue.startsWith('"') && rawValue.endsWith('"')) {
        if (valueRange.start !== valueStart + 1 || valueRange.end !== valueEnd - 1) hclFailure('HCL quoted value range mismatch.');
      } else if (valueRange.start !== valueStart || valueRange.end > valueEnd || valueRange.end <= valueStart) {
        hclFailure('HCL value range mismatch.');
      }
      positions.push({ start: atom.start, end: atom.end }, { start: valueStart, end: valueEnd });
      cursor = valueEnd;
    }
    if (!/^[ \t\r\n]*,?[ \t\r\n]*$/u.test(sourceSlice(cursor, end - 1))) hclFailure('Unrepresented HCL object members.');
    if (seen.size !== names.length) hclFailure('HCL object membership is incomplete.');
    return positions;
  }
  const fields: Record<string, readonly string[]> = {
    template: [], templateWrap: [], tuple: [],
    literalValue: ['type'],
    scopeTraversal: ['fullAccessor', 'traversal'],
    relativeTraversal: ['fullAccessor', 'traversal', 'sourceExpression'],
    function: ['name', 'expandedFinalArgument', 'nameRange', 'openParenRange', 'closeParenRange', 'argsRanges'],
    for: ['keyVar', 'valVar', 'collectionExpression', 'conditionalExpression', 'valueExpression', 'keyExpression', 'groupedValue', 'openRange', 'openRangeValue', 'closeRange', 'closeRangeValue'],
    index: ['keyExpression', 'collectionExpression'],
    splat: ['sourceExpression', 'eachExpression', 'anonSymbolExpression', 'markerRange'],
    conditional: ['conditionExpression', 'trueExpression', 'falseExpression'],
    unaryOp: ['operator', 'valueExpression', 'symbolRange', 'returnType'],
    binaryOp: ['operator', 'returnType', 'lhsExpression', 'rhsExpression'],
    object: ['items']
  };
  const pending: { value: unknown; depth: number; objectKey: boolean; parent: { start: number; end: number }; exact?: { start: number; end: number } }[] =
    [{ value, depth: 0, objectKey: false, parent: { start: 0, end: maximumBytes } }];
  while (pending.length) {
    const next = pending.pop()!;
    if (next.depth > hclComputationPolicy.expressionDepth) hclFailure('HCL expression depth limit.');
    if (next.objectKey) {
      const key = staticKey(next.value);
      if (!next.exact || key.start !== next.exact.start || key.end !== next.exact.end) hclFailure('HCL key is not in its proven parent position.');
      const marker = ownHclRecord(next.value, ['type', 'children', 'range']);
      if (!Array.isArray(marker.children)) hclFailure('Invalid object-key children.');
      for (const child of marker.children) pending.push({ value: child, depth: next.depth + 1, objectKey: false, parent: key, exact: key });
      continue;
    }
    const node = ownHclRecord(next.value, ['type', 'meta', 'children', 'range']);
    if (typeof node.type !== 'string' || !Object.hasOwn(fields, node.type) || !Array.isArray(node.children)) hclFailure('Unknown HCL AST shape.');
    const meta = ownHclRecord(node.meta, ['value', ...fields[node.type]]);
    range(node.range);
    const span = expressionSpan(node, meta, next.depth === 0);
    if (span.start < next.parent.start || span.end > next.parent.end ||
        next.exact && (span.start !== next.exact.start || span.end !== next.exact.end)) {
      hclFailure('HCL expression is outside its exact parent/source position.');
    }
    if (node.type !== 'literalValue' && typeof meta.value !== 'string') hclFailure('Invalid HCL AST source value.');
    for (const name of fields[node.type]) {
      const value = meta[name];
      if (name.endsWith('Range')) range(value);
      else if (name === 'argsRanges') {
        if (!Array.isArray(value) || value.length !== node.children.length) hclFailure('HCL argument correspondence mismatch.');
        value.forEach(range);
      } else if (name === 'expandedFinalArgument' || name === 'groupedValue') {
        if (typeof value !== 'boolean') hclFailure('Invalid HCL AST boolean.');
      } else if (name === 'traversal') {
        if (!Array.isArray(value) || !value.length) hclFailure('Invalid HCL traversal.');
        for (const entry of value) {
          const part = ownHclRecord(entry, ['type', 'segment', 'range']);
          if (!['nameTraversal', 'indexTraversal'].includes(String(part.type)) || typeof part.segment !== 'string') hclFailure('Invalid HCL traversal segment.');
          range(part.range);
        }
      } else if (name === 'items') {
        if (!value || typeof value !== 'object' || Array.isArray(value) || Object.values(value).some(item => typeof item !== 'string')) hclFailure('Invalid HCL object metadata.');
      } else if (typeof value !== 'string') hclFailure('Invalid HCL AST metadata.');
    }
    if (node.type === 'literalValue') {
      if (!['string', 'number', 'bool', 'null', 'dynamic'].includes(String(meta.type)) ||
          meta.value !== null && !['string', 'boolean', 'number'].includes(typeof meta.value)) hclFailure('Invalid HCL literal value.');
    }
    let positions: { start: number; end: number }[] | undefined;
    if (node.type === 'object') positions = objectMembers(node, meta);
    if (node.type === 'function') {
      const name = range(meta.nameRange), open = range(meta.openParenRange), close = range(meta.closeParenRange);
      if (name.start !== span.start || sourceSlice(name.start, name.end) !== meta.name ||
          !/^[ \t\r\n]*$/u.test(sourceSlice(name.end, open.start)) ||
          sourceSlice(open.start, open.end) !== '(' || sourceSlice(close.start, close.end) !== ')' || close.end !== span.end ||
          !Array.isArray(meta.argsRanges)) hclFailure('Invalid HCL function source correspondence.');
      positions = meta.argsRanges.map(range);
      let cursor = open.end;
      for (const [index, argument] of positions.entries()) {
        if (argument.start < cursor || argument.end > close.start) hclFailure('Invalid HCL argument order.');
        const gap = sourceSlice(cursor, argument.start);
        if (!(index === 0 ? /^[ \t\r\n]*$/u : /^[ \t\r\n]*,[ \t\r\n]*$/u).test(gap)) hclFailure('Unrepresented HCL function arguments.');
        cursor = argument.end;
      }
      const tail = sourceSlice(cursor, close.start);
      if (!(meta.expandedFinalArgument ? /^[ \t\r\n]*\.\.\.[ \t\r\n]*$/u : /^[ \t\r\n]*,?[ \t\r\n]*$/u).test(tail)) hclFailure('Unrepresented HCL function argument suffix.');
    }
    if (node.type === 'tuple') {
      if (sourceSlice(span.start, span.start + 1) !== '[' || sourceSlice(span.end - 1, span.end) !== ']') hclFailure('Invalid HCL tuple source.');
      positions = [];
      let cursor = span.start + 1;
      for (const [index, value] of node.children.entries()) {
        const child = ownHclRecord(value, ['type', 'meta', 'children', 'range']);
        if (!child.meta || typeof child.meta !== 'object' || Array.isArray(child.meta)) hclFailure('Invalid HCL tuple member metadata.');
        const member = expressionSpan(child, child.meta as Record<string, unknown>);
        if (member.start < cursor || member.end > span.end - 1) hclFailure('Invalid HCL tuple member range.');
        const gap = sourceSlice(cursor, member.start);
        if (!(index === 0 ? /^[ \t\r\n]*$/u : /^[ \t\r\n]*,[ \t\r\n]*$/u).test(gap)) hclFailure('Unrepresented HCL tuple members.');
        positions.push(member); cursor = member.end;
      }
      if (!/^[ \t\r\n]*,?[ \t\r\n]*$/u.test(sourceSlice(cursor, span.end - 1))) hclFailure('Unrepresented HCL tuple suffix.');
    }
    if (node.type === 'template' || node.type === 'templateWrap') {
      const raw = String(meta.value);
      const start = next.depth === 0 ? sourceBytes.indexOf(10) + 1 : span.start + 1;
      const end = next.depth === 0 ? sourceBytes.lastIndexOf(10, maximumBytes - 2) + 1 : span.end - 1;
      if (next.depth !== 0 && (!raw.startsWith('"') || !raw.endsWith('"'))) hclFailure('Unsupported nested template source envelope.');
      positions = [];
      let cursor = start;
      for (const value of node.children) {
        const child = ownHclRecord(value, ['type', 'meta', 'children', 'range']);
        if (!child.meta || typeof child.meta !== 'object' || Array.isArray(child.meta)) hclFailure('Invalid HCL template member.');
        const childMeta = child.meta as Record<string, unknown>, member = expressionSpan(child, childMeta);
        if (member.start < cursor || member.end > end) hclFailure('Invalid HCL template child order.');
        if (child.type === 'literalValue' && childMeta.type === 'string' && member.start === cursor) {
          cursor = member.end;
        } else {
          if (sourceSlice(cursor, member.start) !== '${' || sourceSlice(member.end, member.end + 1) !== '}') {
            hclFailure('Unrepresented HCL template expression.');
          }
          cursor = member.end + 1;
        }
        positions.push(member);
      }
      if (cursor !== end) hclFailure('HCL template omitted actual source content.');
    }
    const arity = ({ literalValue: 0, scopeTraversal: 0, unaryOp: 1, binaryOp: 2, conditional: 3 } as Record<string, number>)[node.type];
    if (arity !== undefined && node.children.length !== arity) hclFailure('Invalid HCL AST child count.');
    for (const [index, child] of node.children.entries()) pending.push({
      value: child, depth: next.depth + 1, objectKey: node.type === 'object' && index % 2 === 0,
      parent: span, ...(positions ? { exact: positions[index] } : {})
    });
  }
}

export function validateHclReply(value: unknown, request: HclRequest): HclReply {
  request = validateRequest(request);
  validateHclTransport(value);
  const reply = ownHclRecord(value, ['schemaVersion', 'policyDigest', 'requestId', 'status', 'results', 'expressions', 'expressionCalls']);
  if (reply.schemaVersion !== 2 || reply.policyDigest !== hclPolicyDigest || reply.requestId !== request.requestId || reply.status !== 'ok' ||
      !Array.isArray(reply.results) || reply.results.length !== request.documents.length || !Array.isArray(reply.expressions)) hclFailure('Isolated parser reply correspondence failed.');
  integer(reply.expressionCalls, request.expressionAllowance);
  if (reply.expressionCalls !== reply.expressions.length) hclFailure('Isolated parser expression-call accounting mismatch.');
  const results: HclResult[] = [], required = new Set<string>();
  for (const [index, entry] of reply.results.entries()) {
    const file = ownHclRecord(entry, ['id', 'sourceSha256', 'parsed']), requested = request.documents[index];
    if (file.id !== requested.id || file.sourceSha256 !== requested.sourceSha256 || !file.parsed ||
        typeof file.parsed !== 'object' || Array.isArray(file.parsed)) hclFailure('Isolated parser source-result mismatch.');
    for (const expression of hclExpressionStrings(file.parsed)) required.add(expression);
    results.push({ id: requested.id, sourceSha256: requested.sourceSha256, parsed: file.parsed as Record<string, unknown> });
  }
  const expressions: HclExpressionResult[] = [];
  for (const entry of reply.expressions) {
    const expression = ownHclRecord(entry, ['value', 'sourceSha256', 'ast']);
    if (typeof expression.value !== 'string' || !required.delete(expression.value) ||
        hclRawDigest(expression.value) !== expression.sourceSha256) hclFailure('Missing, duplicate or invented HCL expression.');
    const source = hclExpressionSource(expression.value);
    validateAst(expression.ast, source);
    if (expression.ast.type !== 'template' || expression.ast.meta.value !== source.slice(0, -1)) hclFailure('HCL AST does not bind the actual expression source.');
    expressions.push({ value: expression.value, sourceSha256: String(expression.sourceSha256), ast: expression.ast });
  }
  if (required.size) hclFailure('Isolated parser omitted required expressions.');
  return { schemaVersion: 2, policyDigest: hclPolicyDigest, requestId: request.requestId, status: 'ok',
    results, expressions, expressionCalls: reply.expressionCalls };
}

async function childMain(): Promise<void> {
  let allowance: number = hclComputationPolicy.stdoutBytes;
  try {
    const flags = [`--wasm-max-mem-pages=${hclComputationPolicy.wasmPages}`,
      `--max-old-space-size=${hclComputationPolicy.v8OldSpaceMiB}`, `--max-semi-space-size=${hclComputationPolicy.v8SemiSpaceMiB}`];
    if (process.argv.length !== 2 || process.execArgv.join('\0') !== flags.join('\0') ||
        process.platform !== hclComputationPolicy.qualifiedRuntime.platform || process.arch !== hclComputationPolicy.qualifiedRuntime.arch ||
        process.versions.node !== hclComputationPolicy.qualifiedRuntime.node) hclFailure('computation-unavailable');
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of process.stdin) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > hclComputationPolicy.requestBytes) hclFailure('transport-limit');
      chunks.push(bytes);
    }
    const input = Buffer.concat(chunks), text = input.toString('utf8');
    if (!Buffer.from(text).equals(input)) hclFailure('invalid-request');
    const decoded: unknown = JSON.parse(text);
    validateHclTransport(decoded);
    if (JSON.stringify(decoded) !== text) hclFailure('invalid-request');
    const request = validateRequest(decoded); allowance = request.replyAllowance;
    const metadata = await import('@cdktf/hcl2json/package.json', { with: { type: 'json' } });
    if (metadata.default.version !== hclComputationPolicy.parserPackageVersion) hclFailure('computation-unavailable');
    const { parse, getExpressionAst } = await import('@cdktf/hcl2json');
    const results: HclResult[] = [], expressions = new Map<string, HclExpressionResult>();
    for (const file of request.documents) {
      const parsed: unknown = await parse('configuration.tf', file.text);
      validateHclTransport(parsed);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) hclFailure('computation-unavailable');
      for (const value of hclExpressionStrings(parsed)) {
        if (expressions.has(value)) continue;
        if (expressions.size >= request.expressionAllowance) hclFailure('expression-limit');
        const ast: unknown = await getExpressionAst('expression.hcl', hclExpressionSource(value));
        validateHclTransport(ast); validateAst(ast, hclExpressionSource(value));
        expressions.set(value, { value, sourceSha256: hclRawDigest(value), ast });
      }
      results.push({ id: file.id, sourceSha256: file.sourceSha256, parsed: parsed as Record<string, unknown> });
    }
    const reply: HclReply = { schemaVersion: 2, policyDigest: hclPolicyDigest, requestId: request.requestId,
      status: 'ok', results, expressions: [...expressions.values()], expressionCalls: expressions.size };
    validateHclReply(reply, request);
    const output = JSON.stringify(reply);
    if (Buffer.byteLength(output) > allowance) hclFailure('transport-limit');
    process.stdout.write(output, () => process.exit(0));
  } catch {
    const output = JSON.stringify({ schemaVersion: 2, policyDigest: hclPolicyDigest, status: 'blocked', code: 'computation-unavailable' });
    if (Buffer.byteLength(output) <= allowance) process.stdout.write(output, () => process.exit(2));
    else process.exit(2);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await childMain();
