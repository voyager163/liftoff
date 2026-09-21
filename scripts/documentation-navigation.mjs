import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

export const readmeContentLineLimit = 135;
export const communityReportingRoutes = Object.freeze({
  support: 'https://github.com/voyager163/liftoff/issues',
  vulnerability: 'https://github.com/voyager163/liftoff/security/advisories/new',
  securityDocument: 'SECURITY.md#report-a-vulnerability',
  conduct: 'mailto:ask.msncontrol@gmail.com',
  conductDocument: 'CODE_OF_CONDUCT.md#report-a-conduct-concern'
});
export const documentationEntryPoints = Object.freeze([
  'README.md',
  'CONTRIBUTING.md',
  'SECURITY.md',
  'CODE_OF_CONDUCT.md',
  'DEVELOPER.md',
  'docs/getting-started.md',
  'docs/workloads.md',
  'docs/spec-workflows-and-agents.md',
  'docs/repository-governance.md',
  'docs/repository-security.md',
  'docs/reference/provider-default-controls.md',
  'docs/existing-repositories.md',
  'docs/prerequisites.md',
  'docs/supported-stack.md',
  'docs/safety-and-consent.md',
  'docs/telemetry.md',
  'docs/cli-reference.md',
  'docs/application-repair.md',
  'docs/project-structure.md',
  'docs/configuration-and-manifests.md',
  'docs/azure-deployment.md',
  'docs/troubleshooting.md',
  'docs/maintainer-reference.md'
]);
export const documentationRequiredFiles = Object.freeze([
  ...documentationEntryPoints,
  'LICENSE',
  'package.json',
  'docs/assets/liftoff-terminal.svg',
  'assets/governance/single-maintainer-gitflow/policy.md'
]);

export function normalizedContentLineCount(content) {
  const normalized = content.replace(/\r\n/g, '\n');
  return normalized === '' ? 0 : normalized.replace(/\n$/, '').split('\n').length;
}

function prose(markdown) {
  let fence;
  return markdown.replace(/\r\n/g, '\n').split('\n').filter((line) => {
    const match = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (match) {
      if (!fence) fence = match[1];
      else if (match[1][0] === fence[0] && match[1].length >= fence.length) fence = undefined;
      return false;
    }
    return !fence;
  }).join('\n');
}

export function markdownTargets(markdown) {
  const text = prose(markdown).replace(/(`+)[\s\S]*?\1/g, '');
  return [
    ...[...text.matchAll(/\]\((?:<([^>]+)>|([^\s)]+))(?:\s+["'][^"']*["'])?\)/g)]
      .map((match) => match[1] ?? match[2]),
    ...[...text.matchAll(/^ {0,3}\[[^\]]+\]:\s*(?:<([^>]+)>|(\S+))/gm)]
      .map((match) => match[1] ?? match[2])
  ];
}

export function markdownAnchors(markdown) {
  const text = prose(markdown);
  const anchors = new Set();
  const headings = [];
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index++) {
    const heading = lines[index].match(/^ {0,3}#{1,6}\s+(.+?)(?:\s+#+)?\s*$/);
    if (heading) headings.push(heading[1]);
    else if (index > 0 && /^ {0,3}(?:=+|-+)\s*$/.test(lines[index]) && lines[index - 1].trim()) {
      headings.push(lines[index - 1].trim());
    }
  }
  for (const heading of headings) {
    const base = heading.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/<[^>]*>/g, '').toLowerCase()
      .replace(/[^\p{L}\p{M}\p{N}_\-\s]/gu, '').replace(/\s/g, '-');
    let slug = base;
    for (let suffix = 1; anchors.has(slug); suffix++) slug = `${base}-${suffix}`;
    anchors.add(slug);
  }
  for (const match of text.matchAll(/<a\s+[^>]*(?:id|name)=["']([^"']+)["'][^>]*>/gi)) {
    anchors.add(match[1]);
  }
  return anchors;
}

export function resolveDocumentationTarget(root, source, target, paths = path) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('//')) return undefined;
  const separator = target.indexOf('#');
  const rawPath = (separator < 0 ? target : target.slice(0, separator)).split('?')[0];
  const relative = decodeURIComponent(rawPath);
  const fragment = separator < 0 ? '' : decodeURIComponent(target.slice(separator + 1));
  if (relative.includes('\\') || relative.startsWith('/') || /^[a-z]:/i.test(relative)) {
    throw new Error(`${source} contains a non-portable documentation link: ${target}`);
  }
  const absoluteRoot = paths.resolve(root);
  const sourcePath = paths.resolve(absoluteRoot, ...source.split('/'));
  const absolute = relative
    ? paths.resolve(paths.dirname(sourcePath), ...relative.split('/'))
    : sourcePath;
  const fromRoot = paths.relative(absoluteRoot, absolute);
  if (fromRoot === '..' || fromRoot.startsWith(`..${paths.sep}`) || paths.isAbsolute(fromRoot)) {
    throw new Error(`${source} contains a documentation link outside its root: ${target}`);
  }
  return { absolute, logicalPath: fromRoot.split(paths.sep).join('/'), fragment };
}

export async function validateDocumentationNavigation(root, requiredFiles = documentationRequiredFiles) {
  const absoluteRoot = await realpath(root);
  const checkedFiles = new Set();
  const documents = new Map();
  const queue = [...requiredFiles];
  let linksChecked = 0;

  async function assertFile(logicalPath) {
    const target = resolveDocumentationTarget(absoluteRoot, 'README.md', logicalPath);
    if (!target || target.fragment) throw new Error(`Invalid documentation inventory entry: ${logicalPath}`);
    let current = absoluteRoot;
    for (const part of target.logicalPath.split('/')) {
      const names = await readdir(current);
      if (!names.includes(part)) throw new Error(`Missing documentation file (exact case required): ${logicalPath}`);
      current = path.join(current, part);
      const physical = await realpath(current);
      const relative = path.relative(absoluteRoot, physical);
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error(`Documentation target escapes its artifact root: ${logicalPath}`);
      }
    }
    if (!(await stat(current)).isFile()) throw new Error(`Documentation target is not a file: ${logicalPath}`);
    return current;
  }

  async function document(logicalPath) {
    if (!documents.has(logicalPath)) documents.set(logicalPath, await readFile(await assertFile(logicalPath), 'utf8'));
    return documents.get(logicalPath);
  }

  while (queue.length) {
    const file = queue.shift();
    if (checkedFiles.has(file)) continue;
    await assertFile(file);
    checkedFiles.add(file);
    if (!file.endsWith('.md')) continue;
    const markdown = await document(file);
    if (file === 'README.md' && normalizedContentLineCount(markdown) >= readmeContentLineLimit) {
      throw new Error(`README.md must contain fewer than ${readmeContentLineLimit} normalized content lines`);
    }
    for (const link of markdownTargets(markdown)) {
      const target = resolveDocumentationTarget(absoluteRoot, file, link);
      if (!target) continue;
      await assertFile(target.logicalPath);
      if (target.fragment) {
        if (!target.logicalPath.endsWith('.md') || !markdownAnchors(await document(target.logicalPath)).has(target.fragment)) {
          throw new Error(`${file} contains a broken documentation anchor: ${link}`);
        }
      }
      linksChecked++;
      queue.push(target.logicalPath);
    }
  }
  const communityFiles = ['README.md', 'CONTRIBUTING.md', 'SECURITY.md', 'CODE_OF_CONDUCT.md'];
  if (communityFiles.every((file) => checkedFiles.has(file))) {
    const [readme, contributing, security, conduct] = await Promise.all(communityFiles.map(document));
    const expectedLinks = [
      ['README.md', readme, communityReportingRoutes.conductDocument],
      ['README.md', readme, communityReportingRoutes.securityDocument],
      ['CONTRIBUTING.md', contributing, communityReportingRoutes.conductDocument],
      ['CONTRIBUTING.md', contributing, communityReportingRoutes.securityDocument],
      ['CONTRIBUTING.md', contributing, communityReportingRoutes.support],
      ['CODE_OF_CONDUCT.md', conduct, communityReportingRoutes.conduct],
      ['CODE_OF_CONDUCT.md', conduct, communityReportingRoutes.securityDocument]
    ];
    for (const [file, text, link] of expectedLinks) {
      if (!markdownTargets(text).includes(link)) throw new Error(`${file} has a mismatched community reporting route: ${link}`);
    }
    const securityRoutes = [...security.matchAll(/https:\/\/github\.com\/[^\s)]+\/security\/advisories\/new/g)].map((match) => match[0]);
    if (!securityRoutes.length || securityRoutes.some((route) => route !== communityReportingRoutes.vulnerability)) {
      throw new Error('SECURITY.md has a mismatched private vulnerability route');
    }
    for (const [file, text] of documents) {
      const mailLinks = markdownTargets(text).filter((target) => target.startsWith('mailto:'));
      if (mailLinks.some((link) => file !== 'CODE_OF_CONDUCT.md' || link !== communityReportingRoutes.conduct)) {
        throw new Error(`${file} has an unexpected private reporting mailbox`);
      }
    }
  }
  return { files: [...checkedFiles].sort(), linksChecked };
}
