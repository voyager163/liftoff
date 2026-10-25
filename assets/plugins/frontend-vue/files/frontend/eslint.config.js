// Lint rules for Vue and TypeScript. Formatting is Prettier's job, so the
// rules that would argue with it are turned off.
import skipFormatting from "@vue/eslint-config-prettier/skip-formatting";
import {
  defineConfigWithVueTs,
  vueTsConfigs,
} from "@vue/eslint-config-typescript";
import { globalIgnores } from "eslint/config";
import pluginVue from "eslint-plugin-vue";

export default defineConfigWithVueTs(
  { name: "app/files-to-lint", files: ["**/*.{ts,vue}"] },
  globalIgnores([
    "**/dist/**",
    "**/coverage/**",
    "**/test-results/**",
    "**/playwright-report/**",
  ]),
  pluginVue.configs["flat/essential"],
  vueTsConfigs.recommended,
  skipFormatting,
);
