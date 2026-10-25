---
name: liftoff-review-eval
description: Turn a missed bug, revert or incident into a review evaluation case, and decide which layer should have caught it. Use after a revert, an incident or a bug that reached a release, or when a reviewer finding turned out to be wrong.
---

# Learn from misses

Treat every miss as a question: what did the review not have in front of it?
Then fix that in the cheapest durable place, and keep a case so the reviewer
is checked against it from now on.

## Steps

1. **Identify the change** that introduced the problem and the change that
   fixed it (`git log`, `git blame`, the revert commit or incident notes).
2. **Pin down the defect**: the file and line where the bug was introduced,
   and the failure it caused. Ask someone who knows that code to confirm.
3. **Record an evaluation case** in `evals/review/<short-name>/` with:
   - `case.json`: `{"kind": "missed-bug", "base": "<sha>", "head": "<sha>",
     "file": "<path>", "line": <n>, "summary": "<one sentence>"}`;
   - `notes.md`: what happened, how it was found and how it was fixed.
   For a finding that was wrong, use `"kind": "false-positive"` and say why
   it was wrong.
4. **Decide which layer should have caught it**, cheapest first:
   - a type, lint rule or test (deterministic, catches it every time);
   - a rule in `REVIEW.md` or a project skill (guides every review);
   - a change to the review policy (more review for that area);
   - a human check (only when nothing automated can catch it).
   Propose the change; do not apply it without the person's agreement.

## Rules

- Never include secrets, customer data or private incident details in a
  case. Describe them instead.
- One case per defect. Keep cases small enough to rerun often.
- Measure, do not assume: a reviewer change that does not improve results on
  the cases should not be kept.
