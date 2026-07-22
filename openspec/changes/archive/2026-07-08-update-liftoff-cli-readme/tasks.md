## 1. README Content

- [x] 1.1 Update root `README.md` so installation and quick-start guidance come before internal contract details.
- [x] 1.2 Add a quick-start command flow covering `liftoff plan`, `liftoff create`, `liftoff validate`, `liftoff doctor`, and local development startup.
- [x] 1.3 Add a generated project structure section that identifies core folders and conditional `frontend`, `functions/<worker-name>`, and `migration/legacy` folders.
- [x] 1.4 Add a command lifecycle section explaining `plan`, `create`, `migrate`, `validate`, `doctor`, `update`, `dev`, and `infra`.
- [x] 1.5 Clarify `liftoff.config.json` as user-owned desired state and `liftoff.manifest.json` as the CLI-owned manifest v2 compatibility record.
- [x] 1.6 Preserve and, where useful, connect the existing contract conventions, development, and release sections to the new workflow documentation.

## 2. Validation

- [x] 2.1 Review the README command descriptions against `src/commands.ts`, `src/catalogs.ts`, and `src/templates.ts` so documented behavior matches implementation.
- [x] 2.2 Confirm path examples in the README are presented as logical project structure and do not imply platform-specific filesystem handling; if implementation expands beyond documentation, add Windows path-focused verification before completion.
- [x] 2.3 Run `npm run check` to ensure the Liftoff package still builds and tests.
- [x] 2.4 Run `openspec status --change update-liftoff-cli-readme` and confirm the change remains apply-ready after implementation tasks are updated.