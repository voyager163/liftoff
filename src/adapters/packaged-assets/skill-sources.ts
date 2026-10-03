import { readDeclaredAssetBytes, type PackagedAssetReadOptions } from './plugin-assets.js';

const skillIds = ['setup', 'governance-assessment', 'repair'] as const;
export type PackagedSkillId = typeof skillIds[number];

export function loadPackagedSkillSource(id: PackagedSkillId, options?: PackagedAssetReadOptions): string {
  if (!skillIds.includes(id)) throw new Error('Unknown packaged Liftoff skill source.');
  const [asset] = readDeclaredAssetBytes([{
    owner: { kind: 'core' }, id: `liftoff-${id}`, pathParts: ['assets', 'skills', `${id}.md`]
  }], { maxAssetBytes: 16_384, maxTotalAssetBytes: 16_384, maxPathParts: 4, maxPartLength: 64 }, options);
  if (!asset) throw new Error(`Packaged Liftoff skill source ${id} was not read.`);
  const text = new TextDecoder('utf-8', { fatal: true }).decode(asset.bytes);
  if (!text.trim() || !text.endsWith('\n') || /[\r\0]/u.test(text)) {
    throw new Error(`Packaged Liftoff skill source ${id} must be nonempty LF-terminated text without NUL.`);
  }
  if (id !== 'repair' && /\{\{|\}\}/u.test(text)) {
    throw new Error(`Packaged Liftoff skill source ${id} does not support placeholders.`);
  }
  return text;
}

const sources = new Map<PackagedSkillId, string>();

export function packagedSkillSource(id: PackagedSkillId): string {
  const cached = sources.get(id);
  if (cached !== undefined) return cached;
  const text = loadPackagedSkillSource(id);
  sources.set(id, text);
  return text;
}
