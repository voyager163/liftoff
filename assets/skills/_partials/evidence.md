## Evidence rules

- Quote real output. Never report a check, test or command you did not run,
  and never describe a result you did not see.
- A finding needs a file and line plus a concrete failure: this input, in
  this state, produces this wrong result. A guess from a name is not evidence.
- When you could not check something (a tool is missing, it needs network or
  credentials, the code is outside the repository), say so and name what a
  person should look at.
- Do not install dependencies, run project scripts that change state, use the
  network or write outside the repository without asking first.
