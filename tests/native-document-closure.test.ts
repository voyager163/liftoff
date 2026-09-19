import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DocumentationClosureError, localMarkdownTargets, OPERATOR_DOCUMENTS, REQUIRED_PUBLIC_DOCUMENTS,
  validateDocumentShippingEntries, verifyPublicMarkdownLinks
} from '../scripts/distribution/native-document-links.mjs';
import { inventoryTree } from '../scripts/distribution/native-build-files.mjs';
import { inspectArchiveDocumentation, inspectFile, verifyPackagedDocumentation } from '../scripts/release-evidence.mjs';

const root = path.join(process.cwd(), 'build', 'source-validation', `document-closure-${randomUUID()}`);
const python = process.platform === 'win32' ? 'python' : 'python3';
let rootIdentity: fs.Stats;

function documents(): Record<string, string> {
  return {
    ...Object.fromEntries(REQUIRED_PUBLIC_DOCUMENTS.map((name) => [name, '# Public document\n'])),
    'README.md': '[Contribute](CONTRIBUTING.md) [Security](SECURITY.md) [Guide](docs/telemetry.md)\n',
    'DEVELOPER.md': '[Contribute](CONTRIBUTING.md)\n',
    'docs/telemetry.md': '[Operator](../infrastructure/opentofu/telemetry/README.md#usage)\n',
    'infrastructure/opentofu/telemetry/README.md': '[Bootstrap](../bootstrap/README.md)\n',
    'infrastructure/opentofu/bootstrap/README.md': '[Telemetry](../telemetry/README.md) [Guide](../../../docs/telemetry.md)\n',
    'node_modules/example/README.md': '[Unrelated package author link](not-shipped.md)\n'
  };
}

function fixture(values: Record<string, string | Buffer> = documents()) {
  const directory = path.join(root, randomUUID());
  fs.mkdirSync(directory);
  for (const [name, content] of Object.entries({ 'package.json': '{"name":"liftoff","version":"0.13.0"}\n', ...values })) {
    const file = path.join(directory, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  return directory;
}

function archive(directory: string, format: 'zip' | 'tar.gz') {
  const output = path.join(root, `${randomUUID()}.${format}`);
  execFileSync(python, ['-c', [
    'import pathlib,sys,tarfile,zipfile',
    'root=pathlib.Path(sys.argv[1]); out=sys.argv[2]',
    'if out.endswith(".zip"):',
    ' with zipfile.ZipFile(out,"w",zipfile.ZIP_DEFLATED) as z:',
    '  for p in sorted(root.rglob("*")):',
    '   if p.is_file(): z.write(p,"bundle/"+p.relative_to(root).as_posix())',
    'else:',
    ' with tarfile.open(out,"w:gz") as t:',
    '  for p in sorted(root.rglob("*")):',
    '   if p.is_file(): t.add(p,arcname="bundle/"+p.relative_to(root).as_posix(),recursive=False)'
  ].join('\n'), directory, output], { timeout: 30000 });
  return inspectFile(root, path.basename(output));
}

beforeAll(() => {
  fs.mkdirSync(root, { recursive: true });
  rootIdentity = fs.lstatSync(root);
});
afterAll(() => {
  const current = fs.lstatSync(root);
  if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== rootIdentity.dev || current.ino !== rootIdentity.ino) {
    throw new Error('Owned document fixture root changed; retaining it');
  }
  fs.rmSync(root, { recursive: true, force: false });
});

describe('actual packaged public-document closure', () => {
  it('requires exactly named public support docs, not whole infrastructure', () => {
    expect(() => validateDocumentShippingEntries(['docs', ...REQUIRED_PUBLIC_DOCUMENTS])).not.toThrow();
    expect(() => validateDocumentShippingEntries(['docs', ...REQUIRED_PUBLIC_DOCUMENTS, 'infrastructure'])).toThrow('exact public operator README');
    expect(() => validateDocumentShippingEntries(['docs', ...REQUIRED_PUBLIC_DOCUMENTS, 'infrastructure/opentofu/telemetry/main.tf'])).toThrow('exact public operator README');
    for (const name of ['CONTRIBUTING.md', 'SECURITY.md', ...OPERATOR_DOCUMENTS]) {
      expect(() => validateDocumentShippingEntries(['docs', ...REQUIRED_PUBLIC_DOCUMENTS.filter((entry) => entry !== name)])).toThrow('omits required');
    }
  });

  it('resolves root/docs/operator README links and cycles only inside the payload inventory', () => {
    const values = documents();
    const result = verifyPublicMarkdownLinks(values, Object.keys(values));
    expect(result.documents).toEqual([...REQUIRED_PUBLIC_DOCUMENTS, 'docs/telemetry.md'].sort());
    expect(result.links).toContainEqual({
      from: 'infrastructure/opentofu/bootstrap/README.md', target: '../../../docs/telemetry.md', resolved: 'docs/telemetry.md'
    });
    expect(result.documents).not.toContain('node_modules/example/README.md');
  });

  it('handles reference/image/HTML and escaped or encoded local destinations without reading code examples', () => {
    const markdown = [
      '[![badge](docs/image\\(1\\).svg)](README.md)',
      '[reference][guide] [guide][] [guide]',
      '[angle](<docs/space name.md> "title")',
      '[parenthesized](docs/parent.md (title)) [multiline]',
      '<img src="docs/image%281%29.svg">',
      '`[not a link](missing-inline.md)`',
      '```md', '[not a link](missing-fence.md)', '```',
      '[guide]: docs/telemetry.md "Guide"',
      '[multiline]:', '  docs/multiline.md',
      '[external](https://example.test/a) [anchor](#local)'
    ].join('\n');
    expect(localMarkdownTargets(markdown)).toEqual([
      'docs/image(1).svg', 'README.md', 'docs/telemetry.md', 'docs/telemetry.md', 'docs/telemetry.md',
      'docs/space name.md', 'docs/parent.md', 'docs/multiline.md', 'docs/image%281%29.svg'
    ]);
  });

  it.each(['CONTRIBUTING.md', 'SECURITY.md', ...OPERATOR_DOCUMENTS])('rejects missing shipped public doc %s', (name) => {
    const values = documents();
    delete values[name];
    expect(() => verifyPublicMarkdownLinks(values, Object.keys(values))).toThrow(name);
  });

  it('does not let an existing checkout document satisfy a missing payload target', () => {
    const values = { ...documents(), 'README.md': '[CLI](docs/cli-reference.md)\n' };
    expect(fs.existsSync(path.join(process.cwd(), 'docs/cli-reference.md'))).toBe(true);
    expect(() => verifyPublicMarkdownLinks(values, Object.keys(values))).toThrow('Broken packaged Markdown link');
  });

  it('follows reachable Markdown outside docs and rejects its broken links', () => {
    const values = { ...documents(), 'docs/guide.md': '[Policy](../assets/policy.md)\n',
      'assets/policy.md': '[Missing](missing.md)\n' };
    expect(() => verifyPublicMarkdownLinks(values, Object.keys(values))).toThrow('assets/policy.md -> missing.md');
  });

  it.each(['../../outside.md', '/etc/passwd', 'file:///etc/passwd', '%2e%2e/%2e%2e/outside.md'])('rejects escaping local link %s', (target) => {
    const values = { ...documents(), 'README.md': `[Unsafe](${target})\n` };
    expect(() => verifyPublicMarkdownLinks(values, Object.keys(values))).toThrow('escapes its bundle');
  });

  it('rejects file autolinks and bounds malformed link/code syntax', () => {
    const values = { ...documents(), 'README.md': '<file:///etc/passwd>\n' };
    expect(() => verifyPublicMarkdownLinks(values, Object.keys(values))).toThrow('escapes its bundle');
    expect(() => localMarkdownTargets(`[${'a'.repeat(4097)}`)).toThrow('inspection bound');
    expect(() => localMarkdownTargets(`text ${'`'.repeat(65)}`)).toThrow('inspection bound');
  });

  it('refuses extra provider configuration and operational qualification payload files', () => {
    const values = documents();
    for (const file of ['infrastructure/opentofu/telemetry/main.tf', 'assets/qualification/release-scope.json']) {
      expect(() => verifyPublicMarkdownLinks(values, [...Object.keys(values), file])).toThrow('Unregistered infrastructure/qualification');
    }
  });

  it('reads actual installed bytes and rejects later document changes without a cache fallback', () => {
    const directory = fixture();
    const inventory = inventoryTree(directory);
    expect(verifyPackagedDocumentation(directory, inventory).documents).toContain('CONTRIBUTING.md');
    fs.appendFileSync(path.join(directory, 'CONTRIBUTING.md'), '[Bad](not-shipped.md)\n');
    expect(() => verifyPackagedDocumentation(directory, inventory)).toThrow('checksum mismatch');
    expect(() => verifyPackagedDocumentation(directory, inventoryTree(directory))).toThrow('Broken packaged Markdown link');
  });

  it('rejects invalid UTF-8 Markdown read through the shared bounded reader', () => {
    const directory = fixture({ ...documents(), 'CONTRIBUTING.md': Buffer.from([0xff]) });
    expect(() => verifyPackagedDocumentation(directory, inventoryTree(directory))).toThrow('Invalid UTF-8 packaged documentation');
  });

  it.each(['zip', 'tar.gz'] as const)('checks actual %s bytes without requiring fabricated native build metadata', (format) => {
    const directory = fixture();
    const result = inspectArchiveDocumentation(archive(directory, format), format, 'bundle', process.cwd());
    expect(result).toEqual(verifyPackagedDocumentation(directory, inventoryTree(directory)));
    expect(fs.existsSync(path.join(directory, 'build-info.json'))).toBe(false);
    fs.unlinkSync(path.join(directory, 'CONTRIBUTING.md'));
    expect(() => inspectArchiveDocumentation(archive(directory, format), format, 'bundle', process.cwd()))
      .toThrow(DocumentationClosureError);
  });
});
