## Frontend

The web frontend in `frontend/` is a [Vue](https://vuejs.org/) application
built with [Vite](https://vite.dev/) and styled with
[Tailwind CSS](https://tailwindcss.com/). It needs
[Node.js](https://nodejs.org/) 26 (see `frontend/.node-version`); its unit
tests need nothing else:

```bash
cd frontend
npm ci
npm test
```

The browser calls the API at `/api` on the page's own origin, so the API
needs no CORS settings. `npm run dev` serves the frontend on
`http://127.0.0.1:5173` and forwards `/api` to the API on
`http://127.0.0.1:8000`; set `API_URL` to use another one. `docker compose up`
also builds the frontend's container, where nginx serves it on
`http://127.0.0.1:8080` and forwards `/api/` to the API.

TypeScript checks use TypeScript 6, because the Vue type checker and the
ESLint TypeScript rules need its programming interface, which TypeScript 7
does not offer yet.

| Command (in `frontend/`) | What it checks |
| --- | --- |
| `npm run lint` | Lint (ESLint) and formatting (Prettier) |
| `npm run typecheck` | TypeScript and Vue templates, strict |
| `npm test` | Unit tests, with at least 80% on every coverage metric |
| `npm run build` | The production build |
| `npm run test:e2e` | Browser tests (Playwright) against the application running in Docker Compose |

For the browser tests, start the application with
`docker compose up --build --wait` from the project root and install the
browser once with `npx playwright install chromium`. CI runs every frontend
check on each pull request.
