import { isUtf8 } from 'node:buffer';
import { controlledGnomeSourceCommit } from '../../domain/repair/controlled-keystore.js';
import { StateMigrationError } from '../../domain/repair/stateful.js';
import { stateDigest } from '../../domain/repair/stateful-invariants.js';

export const maximumControlledGnomeStoreBytes = 1024 * 1024;
const magic = Buffer.from('GnomeKeyring\n\r\0\n\0', 'ascii');

/**
 * Structural admission for the pinned GNOME binary writer, not decryption,
 * password verification, filesystem custody, durability or authenticated proof.
 */
export function inspectControlledGnomeBinary(bytes: Uint8Array) {
  const input = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let cursor = 0;
  const require = (condition: unknown): void => {
    if (!condition) throw new StateMigrationError('artifact-integrity');
  };
  const take = (length: number): Buffer => {
    require(Number.isSafeInteger(length) && length >= 0 && length <= input.length - cursor);
    const value = input.subarray(cursor, cursor + length);
    cursor += length;
    return value;
  };
  const number = (): number => take(4).readUInt32BE(0);
  const string = (nullable: boolean, maximum: number): Buffer | null => {
    const length = number();
    if (length === 0xffffffff) { require(nullable); return null; }
    require(length <= maximum);
    const text = take(length);
    require(isUtf8(text) && !text.includes(0));
    return text;
  };
  require(input.length <= maximumControlledGnomeStoreBytes && input.length >= magic.length + 4);
  require(take(magic.length).equals(magic));
  require(take(4).equals(Buffer.alloc(4)));
  string(true, 1024);
  take(16);
  const flags = number();
  require(flags === 0 || flags === 1 || flags === 2);
  number();
  const iterations = number();
  require(iterations >= 1000 && iterations < 4096);
  take(8);
  for (let index = 0; index < 4; index++) require(number() === 0);
  const items = number();
  require(items === 1);
  const itemId = number();
  number();
  const attributes = number();
  require(attributes <= 16);
  const names = new Set<string>();
  for (let index = 0; index < attributes; index++) {
    const name = string(false, 256);
    require(name !== null && name.length > 0);
    const identity = name!.toString('hex');
    require(!names.has(identity));
    names.add(identity);
    const type = number();
    if (type === 0) string(true, 1024);
    else { require(type === 1); number(); }
  }
  const encryptedBytes = number();
  require(encryptedBytes >= 16 && encryptedBytes % 16 === 0);
  take(encryptedBytes);
  require(cursor === input.length);
  return Object.freeze({
    contract: 'controlled-gnome-binary-shape/1' as const,
    sourceCommit: controlledGnomeSourceCommit,
    sha256: stateDigest(input),
    bytes: input.length,
    itemId,
    encryptedBytes,
    format: 'gnome-keyring-binary-0.0' as const,
    cipher: 'aes-128-cbc' as const,
    contentChecksum: 'md5-not-authentication' as const,
    derivation: 'gnome-simple-sha256' as const,
    iterations,
    evidence: 'structural-only' as const,
    authenticated: false as const,
    persistenceVerified: false as const,
    readiness: false as const
  });
}
