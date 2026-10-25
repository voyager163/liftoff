import type { ProjectPlugin } from "../contracts/project-plugin.ts";

/**
 * Manual development: no specification framework. It writes nothing, so a
 * project never gets framework files, markers or archive steps it did not ask for.
 */
export const manualWorkflow: ProjectPlugin = {
  id: "workflow/manual",
  kind: "workflow",
  version: "1",
  summary: "No specification framework",
  templateRoots: [],
  artifacts: () => [],
};
