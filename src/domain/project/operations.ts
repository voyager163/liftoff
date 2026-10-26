/** Operations that change an existing project in place, file by file. */
export const CHANGE_OPERATIONS = [
  "update",
  "repair",
  "adopt",
  "workflow-set",
  "profile-set",
  "agents-add",
] as const;
export type ChangeOperation = (typeof CHANGE_OPERATIONS)[number];

/** Every operation that writes a project's files: creating it, or changing it. */
export const OPERATIONS = ["init", ...CHANGE_OPERATIONS] as const;
export type Operation = (typeof OPERATIONS)[number];
