import type { ProjectPlugin } from "../contracts/project-plugin.ts";
import { filesFrom } from "./files.ts";

const ROOT = "templates/common";

/** Repository basics every project gets: ignore, attributes and editor settings. */
export const commonPlugin: ProjectPlugin = {
  id: "common/repository",
  kind: "common",
  version: "1",
  summary: "Git and editor settings",
  templateRoots: [ROOT],
  artifacts: ({ templates, config }) => filesFrom(templates, ROOT, { name: config.name }, "seeded"),
};
