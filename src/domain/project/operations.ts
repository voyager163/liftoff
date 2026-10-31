/** Operations that change an existing project in place, file by file. */
export const CHANGE_OPERATIONS = [
  "update",
  "repair",
  "adopt",
  "migrate-cleanup",
  "workflow-set",
  "profile-set",
  "agents-add",
] as const;
export type ChangeOperation = (typeof CHANGE_OPERATIONS)[number];

/** Operations that create a new project, in a new or empty directory. */
export const CREATE_OPERATIONS = ["init", "migrate"] as const;
export type CreateOperation = (typeof CREATE_OPERATIONS)[number];

/** Every operation that writes a project's files: creating it, or changing it. */
export const OPERATIONS = [...CREATE_OPERATIONS, ...CHANGE_OPERATIONS] as const;
export type Operation = (typeof OPERATIONS)[number];
