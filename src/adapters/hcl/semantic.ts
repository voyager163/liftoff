import type { TFExpressionSyntaxTree } from '@cdktf/hcl2json';

export type HclObject = Record<string, unknown>;
export type HclExpression = TFExpressionSyntaxTree.ExpressionType;

export class InfrastructureInspectionError extends Error {}

export function unsupported(detail: string): never {
  throw new InfrastructureInspectionError(detail);
}

export function object(value: unknown, label: string): HclObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    unsupported(`${label}: expected a supported HCL object.`);
  }
  return value as HclObject;
}

export function singleBlock(value: unknown, label: string): HclObject {
  if (!Array.isArray(value) || value.length !== 1) {
    unsupported(`${label}: missing or duplicate block.`);
  }
  return object(value[0], label);
}

export function onlyKeys(value: HclObject, keys: readonly string[], label: string): void {
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) unsupported(`${label}: unsupported ${key} scope.`);
  }
}

export async function parseHcl(content: string, label: string): Promise<HclObject> {
  try {
    const { parse } = await import('@cdktf/hcl2json');
    const parsed: unknown = await parse('configuration.tf', content);
    return object(parsed, label);
  } catch {
    // Parser diagnostics can contain source values, including tfvars secrets.
    unsupported(`${label}: invalid or unsupported HCL syntax.`);
  }
}

export async function templateExpression(value: string): Promise<HclExpression> {
  let delimiter = 'LIFTOFF_REPAIR_EXPRESSION';
  while (value.includes(delimiter)) delimiter += '_';
  try {
    const { getExpressionAst } = await import('@cdktf/hcl2json');
    const expression = await getExpressionAst(
      'expression.hcl', `<<${delimiter}\n${value}\n${delimiter}\n`
    );
    if (!expression) unsupported('Unsupported HCL expression.');
    return expression;
  } catch {
    unsupported('Unsupported HCL expression; source values were omitted.');
  }
}

export function traversal(expression: HclExpression): string[] | undefined {
  if (expression.type !== 'scopeTraversal' ||
      expression.meta.traversal.some((part) => part.type !== 'nameTraversal')) return undefined;
  return expression.meta.traversal.map((part) => part.segment);
}

export async function directReference(value: unknown): Promise<string[] | undefined> {
  if (typeof value !== 'string') return undefined;
  const ast = await templateExpression(value);
  const children = ast.children;
  if (children.length !== 2 || children[1].type !== 'literalValue' ||
      children[1].meta.value !== '\n') return undefined;
  return traversal(children[0]);
}

function expressionIdentity(ast: HclExpression): unknown {
  if (!['literalValue', 'scopeTraversal', 'function', 'binaryOp', 'unaryOp',
    'template', 'templateWrap', 'tuple', 'conditional'].includes(ast.type)) {
    // Do not infer equivalence for AST forms whose metadata carries additional
    // semantics (relative accessors, object keys, comprehensions, and indexes).
    return ['opaque', ast.type, ast.meta.value];
  }
  return [
    ast.type,
    ast.type === 'literalValue' ? [ast.meta.type, ast.meta.value] :
      ast.type === 'scopeTraversal' ? ast.meta.traversal.map((part) => [part.type, part.segment]) :
        ast.type === 'function' ? [ast.meta.name, ast.meta.expandedFinalArgument] :
          ast.type === 'binaryOp' || ast.type === 'unaryOp' ? ast.meta.operator : null,
    ast.children.map(expressionIdentity)
  ];
}

async function canonical(value: unknown, depth = 0): Promise<unknown> {
  if (depth > 64) unsupported('HCL nesting exceeds the supported inspection bound.');
  if (typeof value === 'string' && (value.includes('${') || value.includes('%{'))) {
    return ['expression', expressionIdentity(await templateExpression(value))];
  }
  if (Array.isArray(value)) return ['array', await Promise.all(value.map((item) => canonical(item, depth + 1)))];
  if (value !== null && typeof value === 'object') {
    return ['object', await Promise.all(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(async ([key, item]) => [key, await canonical(item, depth + 1)]))];
  }
  return [typeof value, value];
}

export async function equivalentHcl(left: string, right: string, label: string): Promise<boolean> {
  if (left === right) return true;
  return JSON.stringify(await canonical(await parseHcl(left, label))) ===
    JSON.stringify(await canonical(await parseHcl(right, label)));
}
