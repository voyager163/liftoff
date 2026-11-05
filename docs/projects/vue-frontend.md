# The Vue frontend

`--frontend vue` adds a web frontend to an API project with any stack: a
[Vue](https://vuejs.org/) application built with [Vite](https://vite.dev/),
styled with [Tailwind CSS](https://tailwindcss.com/) and written in
TypeScript. Its dependencies are locked in a committed `package-lock.json`.
Without the option, a project has no frontend.

## The application

| Behavior | Details |
| --- | --- |
| Example | shows whether the API is ready, lists the items and adds new ones |
| Reaching the API | calls `/api` on the page's own origin, so the API needs no CORS settings; a request that gets no answer within 10 seconds is given up, and the page offers to try again |
| Development | `npm run dev` on `http://127.0.0.1:5173`, forwarding `/api` to the API on `http://127.0.0.1:8000` (`API_URL` overrides it) |
| Container | built with Node.js, served by nginx as an unprivileged user on port 8080; nginx forwards `/api/` to `API_UPSTREAM` (`http://api:8000` in Compose, the API's internal HTTPS address in Azure) with the API's own host name, and looks its address up again every 10 seconds, so a recreated API is found |
| Security headers | a Content-Security-Policy that only allows the page's own origin, `nosniff` and no referrer |
| Checks | ESLint and Prettier, a strict TypeScript and Vue template check, Vitest with at least 80% on every coverage metric, the production build |
| Browser tests | Playwright, against the whole application running in Docker Compose |

The frontend uses TypeScript 6 while the rest of Liftoff's templates use
TypeScript 7: the Vue type checker and the ESLint TypeScript rules need
TypeScript's programming interface, which TypeScript 7 does not offer yet.

## Running it

`docker compose up --build` starts PostgreSQL, the API and the frontend,
which waits until the API is healthy and then serves the application on
`http://127.0.0.1:8080`. In CI, a job does the same and runs the Playwright
test against it; the other frontend jobs lint, type-check, test and build it.

## Dependencies

Every dependency is pinned exactly. Liftoff's `npm run lock:node` resolves the
template's lockfile to versions published at least 7 days earlier, then moves
any package with a known advisory to a fixed version its dependents accept,
and checks that every package comes from the npm registry. Base images are
pinned by digest; nginx is taken newer than 7 days only for a security fix.

## Layout

```text
demo/
  frontend/
    src/                    the Vue application
    src/__tests__/          unit tests
    e2e/                    Playwright browser tests
    nginx/                  the web server configuration in the container
    index.html, package.json, package-lock.json, .node-version
    vite.config.ts, vitest.config.ts, playwright.config.ts
    tsconfig.json, eslint.config.js, .prettierrc.json
    Dockerfile
  compose.yaml              adds the web service on port 8080
  .github/
    workflows/01-pr-ci.yml  adds the frontend lint, test and browser jobs
    workflows/02-codeql.yml analyzes the frontend's TypeScript and Vue code
    dependabot.yml          adds npm and Docker updates for frontend/
```

The frontend's files are seeded and yours, like the API's. Its checks are
listed in the project's README and AGENTS.md, and `liftoff doctor` checks
for Node.js.
