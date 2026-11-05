---
name: liftoff-pr
description: "Draft a pull request description with real evidence. Fills in what changed and why, Testing (the commands actually run and their results), Risk (tier and what could go wrong) and How to revert. Use when opening or updating a pull request."
---

<!-- Managed by Liftoff. Change it through Liftoff rather than by hand. -->

# Pull request description

The description is evidence for the people and reviewers who read the pull
request. You draft it; the person who asked for the change reviews it and
signs off before it is submitted.

## Before you call Liftoff

If `liftoff` is on the PATH, run `liftoff capabilities --json` once and use
only the commands and options it lists. Never guess a command or flag. If
Liftoff is not installed, or the command you need is not listed, do the step
by hand as this skill describes and say that the result was not checked by
Liftoff.

## Draft these sections

Use the repository's pull request template when there is one, and keep its
headings. Otherwise use:

1. **What and why**: the problem, the approach and anything deliberately
   left out. Link the issue.
2. **Testing**: each check you ran (see `liftoff-verify`) as the command and
   its result. List what you could not test and why. Never list a check you
   did not run.
3. **Risk**: the tier from `liftoff-risk`, what could go wrong in
   production, and who or what is affected if it does.
4. **How to revert**: the exact steps, for example "revert this commit; no
   data migration" or "turn off the `new-checkout` flag". If reverting needs
   more than a revert (migrations, published packages, external state), say
   so explicitly.

## Rules

- Keep it short and factual. No marketing, no claims you did not check.
- Mention material AI assistance where it affects provenance or review.
- Never include secrets, personal data, customer data or `.env` contents.
- Show the draft to the person before submitting it. Do not open, update or
  merge the pull request without their go-ahead.
