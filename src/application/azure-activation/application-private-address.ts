import { applicationPrivateAssert as must } from './application-private-errors.js';

export function applicationPrivateAddress(value: unknown) {
  must(typeof value === 'string' && value.length <= 512, 'resource-address');
  const match = /^((?:module\.[A-Za-z_][A-Za-z0-9_-]*\.)*)(data\.)?(azurerm_[a-z0-9_]+)\.([A-Za-z_][A-Za-z0-9_-]*)(?:\[(0|[1-9][0-9]{0,5})\])?$/u.exec(value);
  must(match, 'resource-address');
  return {
    address: value, declaration: `${match[1]}${match[2] ?? ''}${match[3]}.${match[4]}`,
    modulePrefix: match[1]!, type: match[3]!, name: match[4]!, mode: match[2] ? 'data' as const : 'managed' as const,
    index: match[5] === undefined ? null : Number(match[5])
  };
}
