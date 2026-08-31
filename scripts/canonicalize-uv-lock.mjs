#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const canonicalIndex = 'https://pypi.org/simple';
const lockPaths = process.argv.slice(2);

if (lockPaths.length === 0) {
  throw new Error('Usage: node scripts/canonicalize-uv-lock.mjs <uv.lock> [...]');
}

async function fetchRelease(name, version) {
  const response = await fetch(
    `https://pypi.org/pypi/${encodeURIComponent(name)}/${encodeURIComponent(version)}/json`,
    {
      headers: { 'user-agent': 'voyager163-liftoff-lock-refresh' },
      signal: AbortSignal.timeout(30_000)
    }
  );
  if (!response.ok) {
    throw new Error(`PyPI ${name} ${version} returned HTTP ${response.status}.`);
  }
  const value = await response.json();
  if (!Array.isArray(value.urls) || value.urls.length === 0) {
    throw new Error(`PyPI ${name} ${version} returned no distribution files.`);
  }
  return value.urls;
}

function artifact(file) {
  if (
    typeof file.url !== 'string' ||
    typeof file.digests?.sha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(file.digests.sha256)
  ) {
    throw new Error(`PyPI distribution metadata is incomplete for ${file.filename ?? 'unknown file'}.`);
  }
  return `{ url = ${JSON.stringify(file.url)}, hash = "sha256:${file.digests.sha256}" }`;
}

for (const inputPath of lockPaths) {
  const resolvedPath = path.resolve(inputPath);
  const source = await readFile(resolvedPath, 'utf8');
  const sections = source.split(/(?=^\[\[package\]\]$)/m);
  const packageSections = sections.filter((section) => section.startsWith('[[package]]'));
  const identities = packageSections.flatMap((section) => {
    if (/^source = \{ editable = "\." \}$/m.test(section)) {
      return [];
    }
    const name = section.match(/^name = "([^"]+)"$/m)?.[1];
    const version = section.match(/^version = "([^"]+)"$/m)?.[1];
    if (!name || !version) {
      throw new Error(`${inputPath} contains a registry package without name and version.`);
    }
    return [{ name, version }];
  });
  const releases = new Map(
    await Promise.all(identities.map(async ({ name, version }) => [
      `${name}\0${version}`,
      await fetchRelease(name, version)
    ]))
  );
  const normalized = sections.map((section) => {
    if (!section.startsWith('[[package]]') || /^source = \{ editable = "\." \}$/m.test(section)) {
      return section;
    }
    const name = section.match(/^name = "([^"]+)"$/m)?.[1];
    const version = section.match(/^version = "([^"]+)"$/m)?.[1];
    const files = releases.get(`${name}\0${version}`);
    if (!files) {
      throw new Error(`Missing fetched release metadata for ${name} ${version}.`);
    }
    const sdist = files
      .filter((file) => file.packagetype === 'sdist')
      .sort((left, right) => left.filename.localeCompare(right.filename))[0];
    const wheels = files
      .filter((file) => file.packagetype === 'bdist_wheel')
      .sort((left, right) => left.filename.localeCompare(right.filename));
    if (!sdist && wheels.length === 0) {
      throw new Error(`PyPI ${name} ${version} has no sdist or wheel.`);
    }

    let output = section
      .replace(
        /^source = \{ registry = "[^"]+" \}$/m,
        `source = { registry = "${canonicalIndex}" }`
      )
      .replace(/^sdist = \{[^\n]+\}\n/m, '')
      .replace(/^wheels = \[\n(?:    \{[^\n]+\},\n)+\]\n/m, '');
    const insertion = [
      ...(sdist ? [`sdist = ${artifact(sdist)}`] : []),
      ...(wheels.length > 0
        ? ['wheels = [', ...wheels.map((file) => `    ${artifact(file)},`), ']']
        : [])
    ].join('\n');
    const dependenciesEnd = output.match(/\ndependencies = \[[\s\S]*?\n\]\n/)?.[0];
    const metadataEnd = output.match(/\nmetadata = \{[\s\S]*?\n\}\n/)?.[0];
    const anchor = metadataEnd ?? dependenciesEnd;
    if (anchor) {
      output = output.replace(anchor, `${anchor}${insertion}\n`);
    } else {
      const sourceLine = `source = { registry = "${canonicalIndex}" }\n`;
      output = output.replace(sourceLine, `${sourceLine}${insertion}\n`);
    }
    return output;
  }).join('');

  await writeFile(resolvedPath, normalized, 'utf8');
  process.stdout.write(`Canonicalized ${inputPath}\n`);
}
