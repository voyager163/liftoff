# Requirements

Liftoff's own requirements, written as plain Markdown. Each requirement has a
stable ID, a short statement, scenarios and a verification method. There is no
specification framework: the files are read by people, coding agents and
`npm run check:trace`.

## Format

```markdown
### AREA-001 Short title

Statement of the requirement.

- Given … when … then …

Verification: test
```

- IDs are `AREA-NNN` and never reused. Retired requirements stay in the file
  with `Status: retired`.
- `Verification: test` means at least one test name must contain the ID.
  `npm run check:trace` fails if one has no test, or if a test cites an ID
  that does not exist.
- `Verification: live` means the requirement can only be proven against real
  GitHub, Azure or package-manager behavior. The test plan or release checklist
  records how and when it was observed; a fixture is never presented as
  live proof.

## Areas

| File | Area |
| --- | --- |
| [cli.md](cli.md) | Command surface, parsing, output and exit codes |
| [review.md](review.md) | Risk policy, review tiers and approvals |
| [skills.md](skills.md) | Coding-agent review skills and their rendering |
| [repository.md](repository.md) | Liftoff's own CI, checks and governance |
