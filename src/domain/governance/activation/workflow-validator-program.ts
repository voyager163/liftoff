import { types } from 'node:util';

export const workflowContextValidators = Object.freeze([
  'source-integrity', 'backend-tests', 'worker-tests', 'frontend-build', 'framework-source'
] as const);
export type WorkflowContextValidator = typeof workflowContextValidators[number];

/** CLI syntax only, never package identity, context meaning, setup or runner qualification. */
export function recognizeWorkflowValidatorProgramStep(value: unknown): WorkflowContextValidator | null {
  if (typeof value !== 'object' || value === null || types.isProxy(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return null;
  const step = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(step).length !== 4 || Reflect.ownKeys(step).some(key => typeof key !== 'string' ||
    !['name', 'run', 'shell', 'env'].includes(key)) ||
    Object.values(step).some(field => !field.enumerable || !Object.hasOwn(field, 'value')) ||
    typeof step.name?.value !== 'string' || !step.name.value ||
    step.shell?.value !== 'bash --noprofile --norc -euo pipefail {0}') return null;
  const environment: unknown = step.env?.value;
  if (typeof environment !== 'object' || environment === null || types.isProxy(environment) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(environment))) return null;
  const fields = Object.getOwnPropertyDescriptors(environment);
  if (Reflect.ownKeys(fields).length !== 3 ||
    fields.LIFTOFF_SOURCE_SHA?.value !== '${{ inputs.source_sha }}' ||
    fields.NODE_OPTIONS?.value !== '' || fields.NODE_PATH?.value !== '' ||
    Object.values(fields).some(field => !field.enumerable || !Object.hasOwn(field, 'value'))) return null;
  return workflowContextValidators.find(validator => step.run?.value ===
    `node ./node_modules/@msn-control/liftoff/dist/workflow-context-validator.js --validator ${validator} --source-sha "$LIFTOFF_SOURCE_SHA"`) ?? null;
}
