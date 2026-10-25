---
name: liftoff-address-review
description: Work through the open review comments on a pull request. Each finding is either fixed or answered with a reason and resolved; pre-existing bugs go to a separate issue; after three review rounds, stop and reconsider the approach. Use when a pull request has review comments from people or AI reviewers.
---

# Address review findings

Every finding gets an answer. Nothing is ignored, and nothing is resolved
without either a fix or a reason.

## Steps

1. **Collect** the open review threads with their file, line and author, for
   example with `gh pr view --comments` or the GitHub API. Note which review
   round this is.
2. **Decide each one**, checking the code yourself rather than trusting the
   comment:
   - **Real and caused by this change**: fix it, including every other
     instance of the same bug class, and add or adjust a test that fails
     without the fix.
   - **Real but pre-existing**: do not grow this pull request. Propose a
     separate issue with the evidence, and reply on the thread with its link.
   - **Wrong or not applicable**: reply with the specific reason and evidence
     (file, line, test), then resolve the thread.
   - **A matter of taste**: follow `REVIEW.md` and the surrounding code; if
     neither decides, ask the person who owns the change.
3. **Verify** with `liftoff-verify` after the fixes, and show the output.
4. **Summarise** for the person: what was fixed, what was answered and why,
   and what was moved to a separate issue. Push and resolve threads only with
   their go-ahead.

## Converge, do not loop

- Re-review only the new diff after the first round.
- If the same kind of finding keeps coming back, fix the cause (the design,
  a missing helper or a missing test), not just the latest instance.
- After three rounds, stop and recommend reconsidering the approach or
  splitting the change, instead of another round of small fixes.
- When reviewers keep flagging old code, that is a signal for a separate
  clean-up, not for this pull request.
