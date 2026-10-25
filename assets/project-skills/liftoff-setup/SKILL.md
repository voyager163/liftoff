---
name: liftoff-setup
description: Get this Liftoff project ready to work on locally. Checks the tools it needs with liftoff doctor, checks the project is intact with liftoff validate, then installs dependencies and runs the checks only with the person's go-ahead. Use when starting on the project, after cloning, or when something will not run.
---

# Set up the project locally

Make the project runnable on this machine without guessing, and without
changing anything the person did not agree to.

<!-- include: negotiate -->

## Steps

1. **Check the tools** with `liftoff doctor --json`. For each required tool
   that is missing or too old, say which one and how to install it. Do not
   install anything yourself without asking.
2. **Check the project** with `liftoff validate --json`. Report any Liftoff
   file that was changed by hand or is missing, but do not restore it: the
   person decides.
3. **Install dependencies** only after the person agrees, using the
   commands in `AGENTS.md` (for example `uv sync` in `backend/`).
4. **Run the checks** listed in `AGENTS.md` (`liftoff-verify`) and show their
   output.
5. **Start the API locally** when asked, following `README.md`. For the
   database, `docker compose up` needs a `.env` copied from `.env.example`;
   never put real secrets in either file.

<!-- include: evidence -->
