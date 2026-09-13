## 1. Safe upgrade target selection

- [x] 1.1 Implement verified macOS Homebrew prefix recovery; test both standard prefixes and reject local, linked, missing, mismatched, and escaping installation targets.
- [x] 1.2 Bind registry probes, exact installation, pre-write rechecks, and replacement verification to the selected prefix; test mirror policy, prefix drift, and launcher changes without real global installs.
- [x] 1.3 Preserve schema-1 JSON privacy and disclose only an optional enumerated installation target; test human output and prefix-aware exact-version failure guidance.

## 2. Documentation and validation

- [x] 2.1 Document supported Homebrew behavior and the check-first workaround for older binaries; verify documentation and exact command examples.
- [x] 2.2 Run focused upgrade and CLI suites, TypeScript build, strict OpenSpec validation, and a read-only reproduction against the installed package; record actual outcomes.
- [x] 2.3 Run the existing Windows CI coverage before release; retain simulated Windows/Linux path regression coverage locally and explicitly report native CI as pending until observed.

Validation on macOS: 187 tests passed across nine affected suites; TypeScript
build, installed-package smoke, strict OpenSpec validation, and diff formatting
checks passed. The patched service inspected the real installed 0.11.3 package
in check mode and reported 0.12.0 available with `installationTarget: homebrew-opt`,
without an environment prefix override or installation. Native Windows CI is
pending; no global package update, publication, or branch push was performed.
