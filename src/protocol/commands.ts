import {
  assertSchemaVersion,
  assertStrictKeys,
  assertStrictObject,
  ProtocolValidationError,
  publicProtocolSchemaVersion,
  protocolChoice,
  protocolNativePath,
  protocolString
} from './schema.js';
import { validateStructuredContinuation, type StructuredContinuationV1 } from './continuation.js';

export interface PublicTargetV1 {
  kind: 'project' | 'installation' | 'user';
  path: string;
}

export interface PublicCommandEnvelopeV1<TPayload = unknown> {
  schemaVersion: 1;
  command: string;
  target?: PublicTargetV1;
  scope?: string;
  payload?: TPayload;
}

export interface PublicCommandResultEnvelopeV1<TResult = unknown> {
  schemaVersion: 1;
  command: string;
  status: 'success' | 'failure' | 'blocked' | 'partial';
  result: TResult;
  continuation?: StructuredContinuationV1;
}

const commandEnvelopeAllowedKeys = [
  'schemaVersion',
  'command',
  'target',
  'scope',
  'payload'
] as const;

const targetAllowedKeys = ['kind', 'path'] as const;

export function validatePublicTarget(value: unknown): PublicTargetV1 {
  const record = assertStrictObject(value, 'PublicTarget');
  assertStrictKeys(record, targetAllowedKeys, 'PublicTarget');

  return {
    kind: protocolChoice(record.kind, ['project', 'installation', 'user'] as const, 'PublicTarget.kind'),
    path: protocolNativePath(record.path, 'PublicTarget.path')
  };
}

function commandIdentity(value: unknown): string {
  const command = protocolString(value, 'PublicCommandEnvelope.command', 128);
  if (!/^[a-z][a-z0-9-]*(?: [a-z][a-z0-9-]*)?$/u.test(command)) {
    throw new ProtocolValidationError('PublicCommandEnvelope.command must be a literal command identity, not a shell expression.');
  }
  return command;
}

export function validatePublicCommandEnvelope(value: unknown): PublicCommandEnvelopeV1;
export function validatePublicCommandEnvelope<TPayload>(
  value: unknown, decodePayload: (payload: unknown) => TPayload
): PublicCommandEnvelopeV1<TPayload>;
export function validatePublicCommandEnvelope(
  value: unknown, decodePayload?: (payload: unknown) => unknown
): PublicCommandEnvelopeV1 {
  const record = assertStrictObject(value, 'PublicCommandEnvelope');
  assertSchemaVersion(record, publicProtocolSchemaVersion, 'PublicCommandEnvelope');
  assertStrictKeys(record, commandEnvelopeAllowedKeys, 'PublicCommandEnvelope');

  if (Object.hasOwn(record, 'payload') && record.payload === undefined) {
    throw new ProtocolValidationError('PublicCommandEnvelope.payload cannot contain an undefined value.');
  }
  return {
    schemaVersion: 1,
    command: commandIdentity(record.command),
    ...(record.target !== undefined ? { target: validatePublicTarget(record.target) } : {}),
    ...(record.scope !== undefined ? { scope: protocolString(record.scope, 'PublicCommandEnvelope.scope', 128) } : {}),
    ...(Object.hasOwn(record, 'payload') ? { payload: decodePayload ? decodePayload(record.payload) : record.payload } : {})
  };
}

export function createPublicCommandResultEnvelope<TResult>(
  command: string,
  status: 'success' | 'failure' | 'blocked' | 'partial',
  result: TResult,
  continuation?: StructuredContinuationV1
): PublicCommandResultEnvelopeV1<TResult> {
  return {
    schemaVersion: 1,
    command: commandIdentity(command),
    status: protocolChoice(status, ['success', 'failure', 'blocked', 'partial'] as const, 'PublicCommandResultEnvelope.status'),
    result,
    ...(continuation ? { continuation: validateStructuredContinuation(continuation) } : {})
  };
}
