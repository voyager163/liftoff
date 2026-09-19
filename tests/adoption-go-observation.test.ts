import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isActualGoHumaImportAndUsage } from '../src/adapters/filesystem/standards-assessment/evidence.js';
import { adoptProject, type AdoptionReport } from '../src/application/project-evolution/adoption/use-case.js';
import { PresentationSession } from '../src/terminal.js';
import { CaptureStream } from './helpers.js';

const roots: string[] = [];
const modulePath = 'github.com/danielgtaylor/huma/v2';
const usage = 'var config = huma.DefaultConfig("Tool API", "1.0.0")';
const source = (imports: string, body = usage) => `package tool\n\n${imports}\n\n${body}\n`;
const goMod = `module example.test/tool\n\ngo 1.26.0\n\nrequire ${modulePath} v2.34.1\n`;

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture(content: string, filename = 'app.go') {
  const parent = path.resolve('tests', `.adoption-go-${randomUUID()}`);
  roots.push(parent);
  const project = path.join(parent, 'project'), home = path.join(parent, 'home');
  const component = path.join(project, 'tool');
  await mkdir(component, { recursive: true });
  await mkdir(home);
  await writeFile(path.join(component, 'go.mod'), goMod);
  await writeFile(path.join(component, filename), content);
  return { parent, project, home, component, content, filename };
}

async function inspect(current: Awaited<ReturnType<typeof fixture>>) {
  const stdout = new CaptureStream(), stderr = new CaptureStream();
  const run = vi.fn(async () => { throw new Error('Source observation must not execute project or tool commands.'); });
  const before = await readdir(current.project, { recursive: true });
  const code = await adoptProject({
    project: current.project, component: 'tool', profile: 'go-huma', check: true, json: true
  }, {
    cwd: current.parent, stdout, stderr, runner: { run },
    presentation: new PresentationSession({ stdout, stderr, json: true }),
    updateNow: () => new Date('2026-09-15T06:00:00Z'),
    updatePreview: { homedir: current.home, env: {}, repositoryRoot: current.project }
  });
  expect(code, stderr.text() || stdout.text()).toBe(2);
  const report = JSON.parse(stdout.text()) as AdoptionReport;
  expect(report.committed).toBe(false);
  expect(report.effects).toEqual({ preparationCommands: 0, projectCommands: 0, networkAuthorized: false, frameworkCommands: 0 });
  expect(run).not.toHaveBeenCalled();
  expect(await readdir(current.project, { recursive: true })).toEqual(before);
  expect(await readFile(path.join(current.component, current.filename), 'utf8')).toBe(current.content);
  expect(await readFile(path.join(current.component, 'go.mod'), 'utf8')).toBe(goMod);
  return report;
}

describe('adoption Go import and usage observation', () => {
  it.each([
    ['default single import', source(`import "${modulePath}"`)],
    ['named single import', source(`import api "${modulePath}"`, 'var config = api.DefaultConfig("Tool API", "1.0.0")')],
    ['parenthesized imports', source(`import (\n"fmt"\n"${modulePath}"\n)`, `var config = huma.DefaultConfig(fmt.Sprint("Tool API"), "1.0.0")`)],
    ['named block import with comments', source(`import (\n// Actual framework dependency.\napi /* exact binding */ "${modulePath}" // retained alias\n)`, 'var config = api.DefaultConfig("Tool API", "1.0.0")')],
    ['raw import path', source(`import \`${modulePath}\``)],
    ['comment markers in other literals', source(`import "${modulePath}"`, `${usage}\nconst example = "/* import fmt */ // huma.DefaultConfig()"`)],
    ['newline after import keyword', source(`import\n(\n"${modulePath}"\n)`)],
    ['explicit declaration semicolons', `package tool; import ("fmt"; "${modulePath}"); var config = huma.DefaultConfig(fmt.Sprint("Tool API"), "1.0.0")\n`],
    ['implicit separator inside a block comment', source(`import (\n"fmt" /* separator\n*/ "${modulePath}"\n)`, 'var config = huma.DefaultConfig(fmt.Sprint("Tool API"), "1.0.0")')],
    ['Unicode-escaped import path', source('import "\\u0067ithub.com/danielgtaylor/huma/v2"')],
    ['hex-escaped import path', source('import "\\x67ithub.com/danielgtaylor/huma/v2"')],
    ['octal-escaped import path', source('import "\\147ithub.com/danielgtaylor/huma/v2"')],
    ['long-Unicode-escaped import path', source('import "\\U00000067ithub.com/danielgtaylor/huma/v2"')]
  ])('preserves %s with an actual bound framework call', async (_name, content) => {
    expect(isActualGoHumaImportAndUsage(content)).toBe(true);
    const report = await inspect(await fixture(content));
    expect(report.status, report.blockers.join(' ')).toBe('planned');
    expect(report.plan?.component.profile.id).toBe('go-huma');
  });

  it.each([
    ['ordinary path string and unused dependency', source('import "fmt"', `func main() { fmt.Println("${modulePath}") }`)],
    ['raw example containing imports and calls', source('import "fmt"', `func main() { fmt.Println(\`import "${modulePath}"\n${usage}\`) }`)],
    ['escaped source example', source('import "fmt"', String.raw`func main() { fmt.Println("import \"github.com/danielgtaylor/huma/v2\"\nvar config = huma.DefaultConfig(\"Tool API\", \"1.0.0\")") }`)],
    ['line-comment import', source(`// import "${modulePath}"`)],
    ['block-comment import', source(`/* import "${modulePath}" */`)],
    ['commented import block', source(`/* import (\n"${modulePath}"\n) */`)],
    ['unused real import', source(`import "${modulePath}"`, 'func main() {}')],
    ['usage only in a line comment', source(`import "${modulePath}"`, `// ${usage}\nfunc main() {}`)],
    ['usage only in a raw literal', source(`import "${modulePath}"`, `const example = \`${usage}\``)],
    ['usage only in an escaped literal', source(`import "${modulePath}"`, String.raw`const example = "huma.DefaultConfig(\"Tool API\", \"1.0.0\")"`)],
    ['blank import without a bound framework call', source(`import _ "${modulePath}"`)],
    ['unrelated package using the huma alias', source('import huma "fmt"', `var example = huma.Sprint("${modulePath}")`)],
    ['shadowed package binding', source(`import "${modulePath}"`, 'func example(huma interface{}) { huma.DefaultConfig("Tool API", "1.0.0") }')],
    ['invalid Go escaped-slash import', source(String.raw`import "github.com\/danielgtaylor\/huma\/v2"`)],
    ['two import paths without a separator', source(`import "fmt" "${modulePath}"`)],
    ['two block imports without a separator', source(`import ("fmt" "${modulePath}")`)],
    ['alias terminated by a block-comment newline', source(`import (\nhuma /* separator\n*/ "${modulePath}"\n)`)],
    ['missing separator after a single import', `package tool\nimport "${modulePath}" ${usage}\n`],
    ['missing separator after an import block', `package tool\nimport ("${modulePath}") ${usage}\n`],
    ['reserved keyword used as an import alias', source(`import var "${modulePath}"`, 'var config = var.DefaultConfig("Tool API", "1.0.0")')],
    ['import after another top-level declaration', `package tool\nvar example = "not an import"\nimport "${modulePath}"\n${usage}\n`],
    ['unterminated raw source example', source('import "fmt"', `const example = \`import "${modulePath}"\n${usage}`)]
  ])('blocks %s without converting a marker into source authority', async (_name, content) => {
    expect(isActualGoHumaImportAndUsage(content)).toBe(false);
    const report = await inspect(await fixture(content));
    expect(report.status).toBe('blocked');
    expect(report.blockers.join(' ')).toMatch(/do not establish supported Huma/);
  });

  it('does not borrow real imports and calls from another component', async () => {
    const current = await fixture(source('import "fmt"', `var example = fmt.Sprint("${modulePath}")`));
    await mkdir(path.join(current.project, 'other'));
    await writeFile(path.join(current.project, 'other', 'go.mod'), goMod);
    await writeFile(path.join(current.project, 'other', 'app.go'), source(`import "${modulePath}"`));
    expect((await inspect(current)).status).toBe('blocked');
  });

  it('does not promote a test-only import and call into application evidence', async () => {
    const current = await fixture(source(`import "${modulePath}"`), 'app_test.go');
    expect((await inspect(current)).status).toBe('blocked');
  });
});
