# Repository Guidelines

## Project Structure & Module Organization

This repository contains two independent Node.js applications:

- `frontend/` is a Vue 3 + TypeScript application built with Vite. Application code lives in `frontend/src/`; routes are in `src/router/`, Pinia stores in `src/stores/`, and static files in `frontend/public/`.
- `backend/` is a CommonJS Express 5 server with a WebSocket server. Its entry point is `backend/server.js`.
- Each application has its own `package.json`, lockfile, and `node_modules`; install and run dependencies from the relevant directory.

## Build, Test, and Development Commands

Run commands from the application directory:

```text
cd frontend; npm install; npm run dev       # Start the Vite development server
cd frontend; npm run build                  # Type-check and create a production build
cd frontend; npm run lint                   # Run Oxlint and ESLint autofixes
cd frontend; npm run format                 # Format files under src/
cd frontend; npm run preview                # Preview the production build
cd backend; npm run dev                     # Start the API with nodemon
cd backend; npm start                       # Start the API with Node.js
```

The backend currently has no automated tests; its `npm test` script is a placeholder and exits with an error.

## Coding Style & Naming Conventions

Use two-space indentation and single quotes in TypeScript/Vue code, matching the existing frontend style. Keep semicolons consistent with the surrounding file (frontend files omit them; backend files currently use them). Use PascalCase for Vue components, camelCase for functions and variables, and descriptive kebab-case route paths. Run `npm run lint` and `npm run format` in `frontend/` before submitting frontend changes.

## Testing Guidelines

No test framework or coverage threshold is configured yet. When adding tests, place them near the code under test or in a clearly named `tests/` directory, use descriptive names such as `router.spec.ts`, and document the new command in the relevant `package.json`.

## Commit & Pull Request Guidelines

No Git history is available in this checkout, so follow a clear imperative convention such as `Add WebSocket reconnect handling` or `Fix frontend route guard`. Keep commits focused. Pull requests should explain the change, list validation commands run, link related issues when applicable, and include screenshots or recordings for visible UI changes. Mention API, WebSocket, configuration, or breaking behavior explicitly.

## Security & Configuration Tips

Do not commit secrets or local environment files. Configure deployment-specific values through environment variables such as `PORT`; review CORS settings before exposing the backend beyond local development.
