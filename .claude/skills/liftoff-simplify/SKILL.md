---
name: liftoff-simplify
description: "Make the current change smaller and clearer without changing what it does. Reuses existing helpers, removes dead code and needless layers, and matches the surrounding style. Use before opening a pull request, when a diff feels large, or when asked to simplify."
---

<!-- Managed by Liftoff. Change it through Liftoff rather than by hand. -->

# Simplify the change

Every line in a pull request is something a person or a reviewer has to
read. A smaller diff is reviewed better and reverted more safely. This skill
improves quality only; it does not hunt for bugs or change behavior.

## Look for

- **Reuse**: a helper, type or pattern the repository already has that the
  change re-implements. Search before writing anything new.
- **Dead weight**: unused parameters, exports, branches, flags and
  configuration; code kept "just in case"; commented-out code.
- **Needless layers**: a wrapper that only forwards, an interface with one
  implementation and no test seam, an abstraction built for a second case
  that does not exist.
- **Noise**: comments that restate the code, logging nobody reads, defensive
  checks for states the types already rule out.
- **Mismatch**: naming, error handling and structure that differ from the
  surrounding code for no reason.
- **Unrelated edits**: formatting or refactors outside the change's purpose.
  Move them to their own pull request.

## Rules

- Behavior stays the same. Run the project's checks (`liftoff-verify`)
  before and after and show both results.
- Keep the diff focused on the change. Do not rewrite neighbouring code you
  were not asked to touch.
- If simplifying needs a behavior change, stop and describe it instead.
- Report what you removed or reused, file by file, and the size of the diff
  before and after.
