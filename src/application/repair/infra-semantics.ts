import {
  directReference, object, onlyKeys, parseHcl, singleBlock, templateExpression,
  traversal, unsupported, type HclExpression, type HclObject
} from '../../adapters/hcl/semantic.js';
import type { EnvironmentId } from '../../domain/project/contracts.js';

const groupedResources = new Set([
  'azurerm_container_registry', 'azurerm_user_assigned_identity', 'azurerm_container_app_environment',
  'azurerm_container_app', 'azurerm_postgresql_flexible_server', 'azurerm_redis_cache',
  'azurerm_storage_account', 'azurerm_servicebus_namespace', 'azurerm_communication_service',
  'azurerm_key_vault', 'azurerm_service_plan', 'azurerm_linux_function_app'
]);
const childResources: Record<string, [string, string]> = {
  azurerm_postgresql_flexible_server_firewall_rule: ['server_id', 'azurerm_postgresql_flexible_server'],
  azurerm_storage_container: ['storage_account_id', 'azurerm_storage_account'],
  azurerm_servicebus_queue: ['namespace_id', 'azurerm_servicebus_namespace']
};
const pureFunctions = new Set([
  'abs', 'ceil', 'floor', 'min', 'max', 'pow', 'signum', 'log', 'parseint',
  'chomp', 'format', 'formatlist', 'indent', 'join', 'lower', 'upper', 'replace',
  'split', 'strrev', 'substr', 'title', 'trim', 'trimprefix', 'trimsuffix', 'trimspace',
  'startswith', 'endswith', 'regex', 'regexall', 'length', 'alltrue', 'anytrue',
  'chunklist', 'coalesce', 'coalescelist', 'compact', 'concat', 'contains', 'distinct',
  'element', 'flatten', 'index', 'keys', 'lookup', 'matchkeys', 'merge', 'one',
  'range', 'reverse', 'setintersection', 'setproduct', 'setsubtract', 'setunion',
  'slice', 'sort', 'sum', 'transpose', 'values', 'zipmap', 'base64decode', 'base64encode',
  'base64gzip', 'csvdecode', 'jsondecode', 'jsonencode', 'urlencode', 'yamldecode',
  'yamlencode', 'md5', 'sha1', 'sha256', 'sha512', 'base64sha256', 'base64sha512',
  'cidrhost', 'cidrnetmask', 'cidrsubnet', 'cidrsubnets', 'can', 'try', 'tobool',
  'tolist', 'tomap', 'tonumber', 'toset', 'tostring', 'nonsensitive', 'sensitive'
]);

export interface InfrastructureSemantics {
  variables: string[];
  outputs: { name: string; sensitive: boolean }[];
  resourceGroups: { environment: EnvironmentId; name: string }[];
  backend: { path: string[]; backup: string[]; workspace: string[] };
  implicitLocalBackend: boolean;
}

function namedBlocks(value: unknown, label: string): Map<string, HclObject> {
  return new Map(Object.entries(object(value, label)).map(([name, blocks]) => {
    if (!/^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(name)) unsupported(`${label}: unsupported block label.`);
    return [name, singleBlock(blocks, `${label}.${name}`)];
  }));
}

function literalString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.includes('${') || value.includes('%{')) {
    unsupported(`${label}: requires a literal string.`);
  }
  return value;
}

function backendPath(value: unknown, label: string, stateFile: boolean): string[] {
  const text = literalString(value, label);
  const parts = text.split('/');
  if (parts.length > 6 || parts.some((part) =>
    !/^[a-zA-Z0-9_.-]{1,80}$/.test(part) || part === '.' || part === '..' ||
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(part) ||
    part.endsWith('.') || part.startsWith('.terraform')
  ) || stateFile && !text.endsWith('.tfstate') && !text.endsWith('.tfstate.backup')) {
    unsupported(`${label}: local backend path is not a bounded project-relative state location.`);
  }
  return parts;
}

async function inspectBackend(content: string): Promise<InfrastructureSemantics['backend']> {
  const parsed = await parseHcl(content, 'backend.local.tf');
  onlyKeys(parsed, ['terraform'], 'backend.local.tf');
  if (!Object.keys(parsed).length) {
    return { path: ['terraform.tfstate'], backup: ['terraform.tfstate.backup'], workspace: ['terraform.tfstate.d'] };
  }
  const terraform = singleBlock(parsed.terraform, 'backend.local.tf terraform');
  onlyKeys(terraform, ['backend'], 'backend.local.tf terraform');
  const backends = object(terraform.backend, 'backend.local.tf backend');
  onlyKeys(backends, ['local'], 'backend.local.tf backend (remote backends are plan-only)');
  const local = singleBlock(backends.local, 'backend.local.tf backend.local');
  onlyKeys(local, ['path', 'workspace_dir'], 'backend.local.tf backend.local');
  const state = local.path === undefined ? ['terraform.tfstate'] :
    backendPath(local.path, 'backend.local.tf path', true);
  const workspace = local.workspace_dir === undefined ? ['terraform.tfstate.d'] :
    backendPath(local.workspace_dir, 'backend.local.tf workspace_dir', false);
  return {
    path: state,
    backup: [...state.slice(0, -1), `${state.at(-1)}.backup`],
    workspace
  };
}

async function inspectProviders(versions: string, providers: string, lock: string): Promise<void> {
  const v = await parseHcl(versions, 'versions.tf');
  onlyKeys(v, ['terraform'], 'versions.tf');
  const terraform = singleBlock(v.terraform, 'versions.tf terraform');
  onlyKeys(terraform, ['required_version', 'required_providers'], 'versions.tf terraform');
  literalString(terraform.required_version, 'versions.tf required_version');
  const requirements = singleBlock(terraform.required_providers, 'versions.tf required_providers');
  onlyKeys(requirements, ['azurerm'], 'versions.tf required_providers');
  const azure = object(requirements.azurerm, 'versions.tf azurerm');
  onlyKeys(azure, ['source', 'version'], 'versions.tf azurerm');
  if (!['hashicorp/azurerm', 'registry.terraform.io/hashicorp/azurerm',
    'registry.opentofu.org/hashicorp/azurerm'].includes(literalString(azure.source, 'azurerm source'))) {
    unsupported('versions.tf: unsupported Azure provider source.');
  }
  literalString(azure.version, 'versions.tf azurerm version');
  const p = await parseHcl(providers, 'providers.tf');
  onlyKeys(p, ['provider'], 'providers.tf');
  const provider = object(p.provider, 'providers.tf provider');
  onlyKeys(provider, ['azurerm'], 'providers.tf provider');
  const defaultAzure = singleBlock(provider.azurerm, 'providers.tf azurerm');
  onlyKeys(defaultAzure, ['features'], 'providers.tf azurerm (aliases, credentials and subscription overrides are unsupported)');
  const features = singleBlock(defaultAzure.features, 'providers.tf azurerm features');
  onlyKeys(features, [], 'providers.tf azurerm features');
  const l = await parseHcl(lock, '.terraform.lock.hcl');
  onlyKeys(l, ['provider'], '.terraform.lock.hcl');
  const locks = object(l.provider, '.terraform.lock.hcl provider');
  if (Object.keys(locks).length !== 1 ||
      !['registry.terraform.io/hashicorp/azurerm', 'registry.opentofu.org/hashicorp/azurerm'].includes(Object.keys(locks)[0])) {
    unsupported('.terraform.lock.hcl: unsupported or missing provider lock scope.');
  }
  const locked = singleBlock(Object.values(locks)[0], '.terraform.lock.hcl azurerm');
  onlyKeys(locked, ['version', 'constraints', 'hashes'], '.terraform.lock.hcl azurerm');
  literalString(locked.version, '.terraform.lock.hcl version');
  if (locked.constraints !== undefined) literalString(locked.constraints, '.terraform.lock.hcl constraints');
  if (!Array.isArray(locked.hashes) || !locked.hashes.length ||
      locked.hashes.some((item) => typeof item !== 'string' || !/^(h1|zh):[a-zA-Z0-9+/=]+$/.test(item))) {
    unsupported('.terraform.lock.hcl: missing or unsupported provider hashes.');
  }
}

async function assertLiteral(value: unknown, label: string, depth = 0): Promise<void> {
  if (depth > 32) unsupported(`${label}: literal nesting exceeds the inspection bound.`);
  if (typeof value === 'string') {
    const ast = await templateExpression(value);
    if (ast.children.some((child) => child.type !== 'literalValue')) {
      unsupported(`${label}: environment values and defaults must be literal; values were omitted.`);
    }
  } else if (Array.isArray(value)) {
    for (const item of value) await assertLiteral(item, label, depth + 1);
  } else if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      await assertLiteral(key, label, depth + 1);
      await assertLiteral(item, label, depth + 1);
    }
  }
}

export async function inspectLegacySemantics(
  source: Record<string, string>, environmentValues: Map<EnvironmentId, string>
): Promise<InfrastructureSemantics> {
  await inspectProviders(source['versions.tf'], source['providers.tf'], source['.terraform.lock.hcl']);
  const backend = await inspectBackend(source['backend.local.tf']);
  const implicitLocalBackend = Object.keys(await parseHcl(source['backend.local.tf'], 'backend.local.tf')).length === 0;
  // This registered example is retained as documentation, never a discovery source.
  if (Object.keys(await parseHcl(source['backend.remote.example.tf'], 'backend.remote.example.tf')).length) {
    unsupported('backend.remote.example.tf: the read-only example contains active configuration.');
  }
  const variablesFile = await parseHcl(source['variables.tf'], 'variables.tf');
  onlyKeys(variablesFile, ['variable'], 'variables.tf');
  const variables = namedBlocks(variablesFile.variable, 'variables.tf variable');
  if (!variables.has('environment')) unsupported('variables.tf: missing environment variable.');
  const main = await parseHcl(source['main.tf'], 'main.tf');
  onlyKeys(main, ['resource', 'locals', 'data'], 'main.tf');
  const resources = new Map<string, { type: string; body: HclObject }>();
  for (const [type, blocks] of Object.entries(object(main.resource, 'main.tf resource'))) {
    if (type !== 'azurerm_resource_group' && type !== 'azurerm_role_assignment' &&
        !groupedResources.has(type) && !Object.hasOwn(childResources, type)) {
      unsupported(`main.tf resource ${type}: resource-group containment is unsupported.`);
    }
    for (const [name, body] of namedBlocks(blocks, `main.tf resource ${type}`)) {
      resources.set(`${type}.${name}`, { type, body });
    }
  }
  if (resources.size > 128) unsupported('main.tf: more than 128 resource definitions are unsupported.');
  const locals: HclObject = {};
  if (main.locals !== undefined) {
    if (!Array.isArray(main.locals)) unsupported('main.tf: unsupported locals scope.');
    for (const block of main.locals) {
      for (const [name, value] of Object.entries(object(block, 'main.tf locals'))) {
        if (Object.hasOwn(locals, name)) unsupported(`main.tf: duplicate local ${name}.`);
        Object.defineProperty(locals, name, { value, enumerable: true });
      }
    }
  }
  const dataNames = new Set<string>();
  if (main.data !== undefined) {
    const data = object(main.data, 'main.tf data');
    onlyKeys(data, ['azurerm_client_config'], 'main.tf data (nonlocal lookups are unsupported)');
    for (const [name, body] of namedBlocks(data.azurerm_client_config, 'main.tf data azurerm_client_config')) {
      onlyKeys(body, [], `main.tf data azurerm_client_config.${name}`);
      dataNames.add(`azurerm_client_config.${name}`);
    }
  }
  const outputFile = await parseHcl(source['outputs.tf'], 'outputs.tf');
  onlyKeys(outputFile, ['output'], 'outputs.tf');
  const outputs = outputFile.output === undefined ? new Map<string, HclObject>() :
    namedBlocks(outputFile.output, 'outputs.tf output');

  let nodeCount = 0;
  function inspectExpression(ast: HclExpression, label: string, depth = 0): void {
    if (++nodeCount > 20000 || depth > 64) unsupported(`${label}: expression exceeds the inspection bound.`);
    if (ast.type === 'function' && !pureFunctions.has(ast.meta.name)) {
      unsupported(`${label}: unsupported function ${ast.meta.name}; path-dependent or external evaluation is not allowed.`);
    }
    if (ast.type === 'for' || ast.type === 'splat') unsupported(`${label}: dynamic collection expressions are unsupported.`);
    if (ast.type === 'scopeTraversal') {
      const parts = ast.meta.traversal.map((part) => part.segment);
      const root = parts[0];
      const known = root === 'var' && variables.has(parts[1]) ||
        root === 'local' && Object.hasOwn(locals, parts[1]) ||
        root === 'data' && dataNames.has(`${parts[1]}.${parts[2]}`) ||
        resources.has(`${root}.${parts[1]}`) || root === 'count' && parts[1] === 'index';
      if (!known) unsupported(`${label}: unsupported reference scope ${root}; paths, workspaces and external references are not allowed.`);
    }
    for (const child of ast.children) inspectExpression(child, label, depth + 1);
  }
  async function inspectValue(value: unknown, label: string, depth = 0): Promise<void> {
    if (depth > 64) unsupported(`${label}: configuration nesting exceeds the inspection bound.`);
    if (typeof value === 'string') {
      inspectExpression(await templateExpression(value), label);
    } else if (Array.isArray(value)) {
      for (const item of value) await inspectValue(item, label, depth + 1);
    } else if (value !== null && typeof value === 'object') {
      for (const [key, item] of Object.entries(value)) {
        if (['provisioner', 'connection', 'dynamic', 'provider', 'for_each'].includes(key)) {
          unsupported(`${label}: unsupported ${key} construct.`);
        }
        await inspectValue(key, label, depth + 1);
        await inspectValue(item, label, depth + 1);
      }
    }
  }
  for (const [name, body] of variables) {
    onlyKeys(body, ['type', 'default', 'description', 'sensitive', 'nullable', 'validation'], `variable ${name}`);
    if (body.sensitive !== undefined && typeof body.sensitive !== 'boolean') {
      unsupported(`variables.tf variable ${name}: input sensitivity must be a literal boolean.`);
    }
    if (body.sensitive === true && Object.hasOwn(body, 'default')) {
      unsupported(`variables.tf variable ${name}: a sensitive literal default cannot enter the repair journal; supply this input outside tracked configuration before requesting repair.`);
    }
    if (Object.hasOwn(body, 'default')) await assertLiteral(body.default, `variable ${name} default`);
    if (body.validation !== undefined) await inspectValue(body.validation, `variable ${name} validation`);
  }
  await inspectValue(locals, 'main.tf locals');
  for (const [name, resource] of resources) await inspectValue(resource.body, `main.tf ${name}`);
  for (const [name, body] of outputs) {
    onlyKeys(body, ['value', 'description', 'sensitive', 'depends_on', 'precondition'], `output ${name}`);
    if (!Object.hasOwn(body, 'value') || body.sensitive !== undefined && typeof body.sensitive !== 'boolean') {
      unsupported(`output ${name}: missing value or nonliteral sensitivity.`);
    }
    await inspectValue(body, `output ${name}`);
  }

  const groupOf = new Map<string, string>();
  async function confinedGroup(address: string, visiting = new Set<string>()): Promise<string> {
    const cached = groupOf.get(address);
    if (cached) return cached;
    if (visiting.has(address)) unsupported(`main.tf ${address}: cyclic resource-group ownership.`);
    visiting.add(address);
    const resource = resources.get(address);
    if (!resource) unsupported(`main.tf ${address}: unknown resource-group ownership reference.`);
    let group: string;
    if (resource.type === 'azurerm_resource_group') {
      if ('count' in resource.body || 'for_each' in resource.body) unsupported(`main.tf ${address}: dynamic resource group is unsupported.`);
      group = address;
    } else {
      const [field, parentType] = groupedResources.has(resource.type)
        ? ['resource_group_name', 'azurerm_resource_group']
        : resource.type === 'azurerm_role_assignment' ? ['scope', ''] : childResources[resource.type];
      const reference = await directReference(resource.body[field]);
      const attribute = groupedResources.has(resource.type) ? 'name' : 'id';
      if (!reference || reference.length !== 3 || reference[2] !== attribute ||
          parentType && reference[0] !== parentType) {
        unsupported(`main.tf ${address}.${field}: cannot prove resource-group containment through a direct resource reference.`);
      }
      group = await confinedGroup(`${reference[0]}.${reference[1]}`, visiting);
    }
    visiting.delete(address);
    groupOf.set(address, group);
    return group;
  }
  for (const address of resources.keys()) await confinedGroup(address);
  const groupAddresses = [...resources].filter(([, value]) => value.type === 'azurerm_resource_group').map(([key]) => key);
  if (!groupAddresses.length || groupAddresses.length > 16) unsupported('main.tf: requires between one and sixteen explicit resource groups.');
  const resourceGroups: InfrastructureSemantics['resourceGroups'] = [];
  const usedNames = new Set<string>();
  for (const [environment, rawValues] of environmentValues) {
    const values = await parseHcl(rawValues, `${environment}.tfvars`);
    for (const [key, value] of Object.entries(values)) {
      if (!variables.has(key)) unsupported(`${environment}.tfvars: value for undeclared variable ${key}.`);
      if (variables.get(key)!.sensitive === true) {
        unsupported(`${environment}.tfvars: a plaintext value for sensitive input ${key} cannot enter the repair journal; supply this input outside tracked configuration before requesting repair.`);
      }
      await assertLiteral(value, `${environment}.tfvars`);
    }
    const knownValues: HclObject = {};
    for (const [name, body] of variables) {
      if (Object.hasOwn(body, 'default')) Object.defineProperty(knownValues, name, { value: body.default, enumerable: true, configurable: true });
    }
    for (const [name, value] of Object.entries(values)) {
      Object.defineProperty(knownValues, name, { value, enumerable: true, configurable: true });
    }
    if (knownValues.environment !== environment) {
      unsupported(`${environment}.tfvars: environment value does not establish the selected environment.`);
    }
    async function evaluateAst(ast: HclExpression, seen: Set<string>): Promise<unknown> {
      if (ast.type === 'literalValue') {
        return ast.meta.type === 'number' ? Number(ast.meta.value) :
          ast.meta.type === 'bool' ? ast.meta.value === 'true' : ast.meta.value;
      }
      if (ast.type === 'template' || ast.type === 'templateWrap') {
        return (await Promise.all(ast.children.map((child) => evaluateAst(child, new Set(seen))))).join('');
      }
      const ref = traversal(ast);
      if (ref?.length === 2 && (ref[0] === 'var' || ref[0] === 'local')) {
        const key = ref.join('.');
        const context = ref[0] === 'var' ? knownValues : locals;
        if (seen.has(key) || !Object.hasOwn(context, ref[1])) unsupported(`main.tf: unresolved or cyclic discovery binding in ${environment}.`);
        return evaluate(context[ref[1]], new Set([...seen, key]));
      }
      if (ast.type === 'conditional') {
        const condition = await evaluateAst(ast.children[0], new Set(seen));
        if (typeof condition !== 'boolean') unsupported(`main.tf: unknown conditional discovery binding in ${environment}.`);
        return evaluateAst(ast.children[condition ? 1 : 2], seen);
      }
      unsupported(`main.tf: discovery binding in ${environment} is not a literal, known variable, or local template.`);
    }
    async function evaluate(value: unknown, seen = new Set<string>()): Promise<unknown> {
      if (seen.size > 32) unsupported('main.tf: discovery reference chain exceeds the inspection bound.');
      if (typeof value !== 'string') return value;
      const ast = await templateExpression(value);
      if (ast.children.length === 2 && ast.children[1].type === 'literalValue' &&
          ast.children[1].meta.value === '\n' && ast.children[0].type !== 'literalValue') {
        return evaluateAst(ast.children[0], seen);
      }
      return String(await evaluateAst(ast, seen)).slice(0, -1);
    }
    for (const [address, resource] of resources) {
      if (resource.body.count !== undefined) {
        const count = await evaluate(resource.body.count);
        if (typeof count !== 'number' || !Number.isInteger(count) || count < 0 || count > 64) {
          unsupported(`main.tf ${address}: count is not bounded by known ${environment} values.`);
        }
      }
    }
    for (const address of groupAddresses) {
      const name = await evaluate(resources.get(address)!.body.name);
      if (typeof name !== 'string' || !/^[a-zA-Z0-9_().-]{1,90}$/.test(name) || name.endsWith('.')) {
        unsupported(`main.tf ${address}.name: cannot derive a supported exact resource group for ${environment}.`);
      }
      if (usedNames.has(name.toLowerCase())) unsupported('main.tf: selected environment roots would share or duplicate a resource group.');
      usedNames.add(name.toLowerCase());
      resourceGroups.push({ environment, name });
    }
  }
  return {
    variables: [...variables.keys()].sort(),
    outputs: [...outputs].map(([name, body]) => ({ name, sensitive: body.sensitive === true })).sort((a, b) => a.name.localeCompare(b.name)),
    resourceGroups,
    backend,
    implicitLocalBackend
  };
}
