import { createHash } from 'node:crypto';
import { SelfUpgradeFailure } from '../../domain/distribution/liftoff-upgrade.js';
import type { NativeReleasePolicy } from '../../domain/distribution/native-upgrade.js';
import { isStableSemver, stableReleaseLookupTimeoutMs } from '../../stable-release.js';
import { authenticateNativeStableMetadata, type NativeStableSource } from './native-metadata.js';

const metadataLimit = 8 * 1024 * 1024;
const assetLimit = 256 * 1024 * 1024;
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const invalid = () => new SelfUpgradeFailure('failed', 'native_invalid');
const unavailable = () => new SelfUpgradeFailure('failed', 'native_unavailable');
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  return value as Record<string, unknown>;
};
const decode = (bytes: Buffer) => {
  try { return object(JSON.parse(bytes.toString('utf8'))); }
  catch { throw invalid(); }
};
const commit = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[a-f0-9]{40}$/.test(value)) throw invalid();
  return value;
};

export function createNativeStableSource(
  policy: NativeReleasePolicy, options: { fetch?: typeof globalThis.fetch } = {}
): NativeStableSource {
  const fetchRelease = options.fetch ?? globalThis.fetch.bind(globalThis);
  const api = `https://api.github.com/repos/${policy.repository}`;
  return {
    async readStable(installation, signal) {
      if (policy.repository !== 'voyager163/liftoff') throw invalid();
      if (!policy.approvedSigningKeySha256 ||
        installation.target.startsWith('linux-') && !policy.linux.archiveSigningKeySha256 ||
        installation.target === 'darwin-arm64' &&
          (!policy.homebrew.cask || !policy.homebrew.sourceRepository || !policy.homebrew.developerTeamId) ||
        installation.target === 'win32-x64' && (!policy.winget.packageIdentifier || !policy.winget.publisher ||
          !policy.winget.installerAppId || !policy.winget.certificateSha256)) {
        throw new SelfUpgradeFailure('blocked', 'native_unqualified');
      }
      const controller = new AbortController();
      const deadline = AbortSignal.any([signal, controller.signal]);
      const started = performance.now();
      const timer = setTimeout(() => controller.abort(), stableReleaseLookupTimeoutMs);
      let downloaded = 0;
      const read = async (requested: string, maximum: number, asset = false): Promise<Buffer> => {
        let url = requested;
        for (let redirects = 0; redirects <= 3; redirects++) {
          deadline.throwIfAborted();
          const response = await fetchRelease(url, {
            signal: deadline, redirect: asset ? 'manual' : 'error', credentials: 'omit', cache: 'no-store',
            headers: { accept: asset ? 'application/octet-stream' : 'application/vnd.github+json',
              'accept-encoding': 'identity', 'cache-control': 'no-cache' }
          });
          if (asset && [301, 302, 303, 307, 308].includes(response.status)) {
            const location = response.headers.get('location');
            await response.body?.cancel();
            if (!location || redirects === 3) throw invalid();
            let next: URL;
            try { next = new URL(location, url); } catch { throw invalid(); }
            if (next.protocol !== 'https:' || next.username || next.password || next.port || next.hash ||
              !['release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(next.hostname) ||
              !/^\/github-production-release-asset(?:-[a-z0-9]+)?\//.test(next.pathname)) throw invalid();
            url = next.href;
            continue;
          }
          if (!response.ok) {
            await response.body?.cancel();
            throw unavailable();
          }
          const length = response.headers.get('content-length');
          const encoding = response.headers.get('content-encoding');
          if (encoding !== null && encoding !== 'identity' ||
            length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)) ||
              Number(length) === 0 || Number(length) > maximum)) {
            await response.body?.cancel();
            throw invalid();
          }
          if (!response.body) throw invalid();
          const reader = response.body.getReader();
          const chunks: Buffer[] = [];
          let count = 0, complete = false;
          try {
            for (;;) {
              deadline.throwIfAborted();
              const item = await reader.read();
              if (item.done) { complete = true; break; }
              count += item.value.byteLength;
              downloaded += item.value.byteLength;
              if (count > maximum || downloaded > 2 * assetLimit + 32 * metadataLimit) throw invalid();
              chunks.push(Buffer.from(item.value));
            }
          } finally {
            try { if (!complete) await reader.cancel(); }
            finally { reader.releaseLock(); }
          }
          deadline.throwIfAborted();
          if (count === 0 || length !== null && count !== Number(length)) throw invalid();
          return Buffer.concat(chunks, count);
        }
        throw invalid();
      };
      const json = async (url: string) => decode(await read(url, metadataLimit));
      const release = async () => {
        const value = await json(`${api}/releases/latest`);
        if (!Number.isSafeInteger(value.id) || Number(value.id) <= 0 || value.draft !== false ||
          value.prerelease !== false || typeof value.tag_name !== 'string' ||
          !value.tag_name.startsWith('v') || !isStableSemver(value.tag_name.slice(1)) ||
          typeof value.published_at !== 'string' || !Number.isFinite(Date.parse(value.published_at)) ||
          !Array.isArray(value.assets)) throw invalid();
        const assets = new Map<string, Record<string, unknown>>();
        const base = `https://github.com/${policy.repository}/releases/download/${value.tag_name}/`;
        for (const entry of value.assets) {
          const item = object(entry);
          if (typeof item.name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,239}$/.test(item.name) ||
            assets.has(item.name) || !Number.isSafeInteger(item.id) || Number(item.id) <= 0 ||
            !Number.isSafeInteger(item.size) || Number(item.size) <= 0 || item.state !== 'uploaded' ||
            item.browser_download_url !== `${base}${item.name}` ||
            item.digest != null && (typeof item.digest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(item.digest))) {
            throw invalid();
          }
          assets.set(item.name, item);
        }
        return { tag: value.tag_name, version: value.tag_name.slice(1), base, assets,
          identity: JSON.stringify([value.id, value.tag_name, value.published_at,
            [...assets].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
              .map(([name, item]) => [name, item.id, item.size, item.digest ?? null, item.browser_download_url])]) };
      };
      const ref = async (name: string) => {
        const value = await json(`${api}/git/ref/${name}`);
        if (value.ref !== `refs/${name}`) throw invalid();
        const target = object(value.object);
        if (!['commit', 'tag'].includes(String(target.type))) throw invalid();
        return { sha: commit(target.sha), type: target.type };
      };
      const tag = async (name: string) => {
        const original = await ref(`tags/${name}`);
        let target = original;
        const seen = new Set<string>();
        while (target.type === 'tag') {
          if (seen.size >= 4 || seen.has(target.sha)) throw invalid();
          seen.add(target.sha);
          const annotation = await json(`${api}/git/tags/${target.sha}`);
          if (annotation.sha !== target.sha) throw invalid();
          const next = object(annotation.object);
          if (!['commit', 'tag'].includes(String(next.type))) throw invalid();
          target = { sha: commit(next.sha), type: next.type };
        }
        return { original: original.sha, commit: target.sha };
      };
      const load = async () => {
        const helper = await import('../../../distribution/native/native-release-catalog.mjs');
        if (!helper.nativeReleaseTargets.some(target => target === installation.target)) throw invalid();
        const observed = await release();
        const asset = async (item: { filename: string; bytes: number; sha256: string }, maximum: number) => {
          const metadata = observed.assets.get(item.filename);
          if (!metadata) throw unavailable();
          if (item.bytes > maximum || metadata.size !== item.bytes ||
            metadata.digest != null && metadata.digest !== `sha256:${item.sha256}`) throw invalid();
          const content = await read(`${observed.base}${item.filename}`, maximum, true);
          if (content.length !== item.bytes || hash(content) !== item.sha256) throw invalid();
          return content;
        };
        const catalogAsset = observed.assets.get(helper.nativeReleaseCatalogFilename);
        if (!catalogAsset) throw unavailable();
        const catalogBytes = await read(`${observed.base}${helper.nativeReleaseCatalogFilename}`, metadataLimit, true);
        if (catalogAsset.size !== catalogBytes.length ||
          catalogAsset.digest != null && catalogAsset.digest !== `sha256:${hash(catalogBytes)}`) throw invalid();
        let catalog: ReturnType<typeof helper.assertNativeReleaseCatalog>;
        try { catalog = helper.assertNativeReleaseCatalog(JSON.parse(catalogBytes.toString('utf8'))); }
        catch { throw invalid(); }
        if (catalog.repository !== policy.repository || catalog.version !== observed.version ||
          catalog.tag !== observed.tag || catalog.distTag !== 'latest' ||
          !Number.isSafeInteger(Number(catalog.runId))) throw invalid();
        const selected = catalog.targets.find(item => item.target === installation.target);
        if (!selected) throw invalid();
        const [recordBytes, qualification, signature, publicKey] = await Promise.all([
          asset(selected.manifest, metadataLimit), asset(selected.qualification, metadataLimit),
          asset(selected.signature, 64), asset(selected.publicKey, 4096)
        ]);
        const envelope = { record: recordBytes, qualification, signature, publicKey,
          stableTag: observed.tag, draft: false, prerelease: false };
        const { record, evidence } = await authenticateNativeStableMetadata(envelope, installation, policy);
        if (record.version !== catalog.version || record.commit !== catalog.commit ||
          record.runId !== catalog.runId || evidence.runId !== catalog.runId) throw invalid();
        const [sourceTag, main, run] = await Promise.all([
          tag(catalog.tag), ref('heads/main'), json(`${api}/actions/runs/${catalog.runId}`)
        ]);
        if (sourceTag.commit !== catalog.commit || main.type !== 'commit') throw invalid();
        const comparison = await json(`${api}/compare/${catalog.commit}...${main.sha}?per_page=1`);
        if (!['ahead', 'identical'].includes(String(comparison.status)) || comparison.behind_by !== 0 ||
          object(comparison.base_commit).sha !== catalog.commit ||
          object(comparison.merge_base_commit).sha !== catalog.commit) throw invalid();
        if (!Number.isSafeInteger(run.id) || String(run.id) !== catalog.runId || run.head_sha !== catalog.commit || run.event !== 'push' ||
          run.head_branch !== catalog.tag || run.status !== 'completed' || run.conclusion !== 'success' ||
          object(run.repository).full_name !== policy.repository ||
          object(run.head_repository).full_name !== policy.repository) throw invalid();
        if (record.files.length !== selected.files.length) throw invalid();
        for (const [index, item] of selected.files.entries()) {
          const bound = object(record.files[index]);
          if (item.sourceFilename !== bound.filename || item.bytes !== bound.bytes || item.sha256 !== bound.sha256) {
            throw invalid();
          }
        }
        const digests = object(evidence.evidenceDigests);
        if (Object.keys(digests).length !== selected.evidence.length) throw invalid();
        for (const item of selected.evidence) {
          if (digests[item.kind] !== item.sha256) throw invalid();
        }
        const [files, proofs, installer, , archiveSignature, archivePublicKey] = await Promise.all([
          Promise.all(selected.files.map(async (item, index) =>
            [item.sourceFilename, await asset(item, index === 0 ? assetLimit : metadataLimit)] as const)),
          Promise.all(selected.evidence.map(async item => [item.kind, await asset(item, metadataLimit)] as const)),
          selected.installer ? asset(selected.installer, assetLimit) : undefined,
          Promise.all(selected.definitions.map(item => asset(item, metadataLimit))),
          selected.archiveSignature ? asset(selected.archiveSignature, 64) : undefined,
          selected.archivePublicKey ? asset(selected.archivePublicKey, 4096) : undefined
        ]);
        const assets = new Map<string, Buffer>(files);
        if (selected.installer && installer) assets.set(selected.installer.filename, installer);
        const platformEvidence = new Map<string, Buffer>(proofs);
        const [finalTag, finalMain, finalRelease] = await Promise.all([
          tag(catalog.tag), ref('heads/main'), release()
        ]);
        if (finalTag.original !== sourceTag.original || finalTag.commit !== sourceTag.commit ||
          finalMain.sha !== main.sha || finalRelease.identity !== observed.identity) throw invalid();
        deadline.throwIfAborted();
        if (performance.now() - started >= stableReleaseLookupTimeoutMs) {
          throw new SelfUpgradeFailure('failed', 'native_timeout');
        }
        return { ...envelope, assets, platformEvidence, archiveSignature, archivePublicKey };
      };
      let interrupt = () => {};
      const aborted = new Promise<never>((_, reject) => {
        interrupt = () => reject(deadline.reason);
        if (deadline.aborted) interrupt();
        else deadline.addEventListener('abort', interrupt, { once: true });
      });
      try {
        return await Promise.race([load(), aborted]);
      } catch (error) {
        if (controller.signal.aborted || performance.now() - started >= stableReleaseLookupTimeoutMs) {
          throw new SelfUpgradeFailure('failed', 'native_timeout');
        }
        if (error instanceof SelfUpgradeFailure) throw error;
        throw unavailable();
      } finally {
        deadline.removeEventListener('abort', interrupt);
        clearTimeout(timer);
        controller.abort();
      }
    }
  };
}
