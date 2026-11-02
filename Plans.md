# Multi-User Online Drawing Application — Development Plan

## Status and approval gate

Last progress review: **2026-11-02**. Local Studio, frontend Clerk sessions, 39 backend tests, Supabase schema bootstrap, and backend health/readiness were verified. The frontend now has a room-creation form wired to the authenticated API; build/type-check, targeted lint/format checks, and four drawing tests pass. Real Clerk/JWKS room creation, browser acceptance, and room listing remain pending.

Continue one requested step at a time. Draft backend/frontend modules require integrated verification before acceptance.

Checklist convention: `[ ]` means pending/unverified; `[x]` means verified. Update completed work in place with brief deliverables and test results; retain unfinished tasks and acceptance criteria in full.

### Current phase status

| Phase | Confirmed progress | Remaining work |
| --- | --- | --- |
| 1 — Environment | Runtime, configuration, dependencies, Supabase schema/TLS, and backend startup checked. | Deferred overall; address remaining setup/audit tasks and live Clerk integration. |
| 2 — Canvas foundation | Accepted: routes, local freehand drawing, logical coordinates, high-DPI rendering, resize replay, and pointer cancellation. | None within its accepted scope. |
| 3 — Tools/UI | Local Studio acceptance passed, including all tools, previews, undo/redo, responsive layout, feedback, and reset confirmation. | Shared-room details and connection indicators during Phase 4. |
| 4 — Authentication/rooms | Sessions, offline auth/room tests, and backend health pass; create-room UI/service implemented with passing frontend checks. | Verify creation with real Clerk/Supabase, add room listing, then invitation joining. |
| 5 — Synchronization | Draft WebSocket/queue/store logic exists. | Integrate room UI and verify ordering, isolation, previews, retries, and reconnection. |
| 6 — Persistence | Supabase migration applied; four tables/RLS, checksum, rerun, and repository readiness verified. | Verify durable operations, snapshots, ownership, and restart recovery. |
| 7 — Docker | No Docker packaging exists. | Complete packaging and container checks after the local MVP. |
| 8 — Integration | Local Studio works; frontend room creation is wired but not accepted end to end. | Complete authenticated room, collaboration, and save/reopen journeys. |
| 9 — Testing | Four drawing tests and 39 backend auth/room tests pass; frontend checks/browser evidence and backend syntax/imports are recorded. | Vitest/Vue Test Utils, live room/persistence integration tests, Playwright, CI, and failure/load testing. |
| 10 — Deployment | No deployment has been verified. | Hosting configuration and approved deployment after local acceptance. |
| 11 — Documentation | Contributor guide, phased plan, progress records, and Vietnamese function comments exist. | Reproducible setup guide, diagrams, report, and presentation materials. |

## Scope and chosen stack

Build a university demonstration for approximately **2–10 concurrent users**, with a working local MVP before Docker and deployment.

| Area | Technology |
| --- | --- |
| Frontend | Vue 3, TypeScript, Vite, HTML Canvas API |
| State and navigation | Pinia and Vue Router |
| Backend | Node.js, Express 5, CommonJS JavaScript |
| Real-time transport | Browser WebSocket client and backend `ws` |
| Authentication | Clerk |
| Database | Supabase PostgreSQL; backend-only `pg` access |
| Persistence management | Parameterized SQL and versioned migrations |
| Containers | Docker for the backend |
| Demo hosting | Vercel frontend and one Render Free backend instance |
| Testing | Vitest, Vue Test Utils, Node test runner, Playwright |

Clerk manages identity. Express enforces room membership and ownership. Supabase persists data. Drawing synchronization uses `ws`; Supabase Auth and Realtime are unnecessary for this architecture.

### MVP requirements

- Create shared rooms and join with an unguessable invitation link after signing in.
- Draw freehand strokes, lines, rectangles, and circles; choose color and brush size; erase.
- Share previews during drawing and converge on server-ordered completed operations.
- Persist completed operations before acknowledging them.
- Restore consistent state for late joiners and reconnecting clients.
- Show owned/joined rooms and private saved copies in a personal gallery.
- Allow only the room owner to save its shared checkpoint.
- Allow every participant to save an immutable private snapshot.
- Open snapshots or checkpoints into new rooms without overwriting an active shared board.

Defer shared-room undo/redo, layers, chat, public room discovery, offline editing, and horizontal backend scaling. Local Studio undo/redo is included in Phase 3.

## Workspace and prerequisites

Root: `C:\Users\LENOVO\Desktop\DACS4`, with independent `frontend/` and `backend/` applications. Assume Windows, PowerShell, VS Code, one backend process, and a single student developer. Gallery contains the new create-room form; room listing, room view, and invitation integration remain pending. Docker was unavailable on the last inspected PATH and no Dockerfile exists. Never copy secrets into this document.

## Architecture and behavior contracts

### Drawing document and rendering

Use a versioned vector document with logical dimensions **1600 × 900** and an ordered operation list. Scale its display with a preserved aspect ratio and account for device pixel ratio.

Each operation contains a UUID, tool type, geometry, width, and applicable color. Freehand/eraser operations contain point lists; shapes use start/end geometry. A circle uses the initial point as its center and drag distance as radius.

Keep gesture previews separate from committed operations. Render erasing with `destination-out` and a presentation-only white background. Reconstruct the board from operations after resizing or reconnecting.

Default limits: ten connections per room, 64 KiB inbound WebSocket messages, 2,048 points per operation, brush width 1–50 logical pixels, and a 5 MiB serialized room document. Simplify sampled paths to stay within limits and show actionable capacity errors.

### Data model

| Table | Responsibilities |
| --- | --- |
| `rooms` | UUID, title, owner Clerk ID, invitation-token hash, initial document, current sequence, latest shared checkpoint, timestamps |
| `room_members` | Unique room/user membership and join timestamp |
| `room_operations` | Room, operation UUID, server sequence, author Clerk ID, validated JSONB payload, timestamp |
| `saved_drawings` | Private owner Clerk ID, title, immutable document JSONB, timestamps |

Use unique constraints on `(room_id, operation_id)` and `(room_id, sequence)`. Allocate sequence and insert the operation in one transaction. Retries return the original operation result; a conflicting reuse of an ID is rejected.

Use a private application schema excluded from Supabase's exposed Data API schemas. Browser clients access application data through Express only. Use a small TLS-enabled `pg` pool and Supabase's session pooler where IPv4 connectivity is needed.

A room reopens from its initial document plus persisted operations. A shared checkpoint records a committed prefix. A personal snapshot is private and immutable. Opening either creates a new owned room with sequence zero and the snapshot as its initial document.

### HTTP endpoints

| Endpoint | Behavior |
| --- | --- |
| `GET /healthz`, `GET /readyz` | Process health and database readiness |
| `POST /api/rooms`, `GET /api/rooms` | Create a room; list owned/joined rooms |
| `POST /api/rooms/join` | Join idempotently with an invitation token |
| `GET /api/rooms/:id` | Retrieve member-only room metadata |
| `POST /api/rooms/:id/invitation` | Owner generates a replacement invitation; existing membership remains |
| `PUT /api/rooms/:id/checkpoint` | Owner saves the observed committed prefix |
| `POST /api/rooms/:id/checkpoint/open` | Owner opens the checkpoint as a new room |
| `POST /api/rooms/:id/copies` | Member saves a private snapshot |
| `GET /api/drawings` | List caller's private saved drawings |
| `POST /api/drawings/:id/open` | Owner opens a saved copy as a new room |

All application endpoints require authentication and authorization; health endpoints are public. Save requests contain a title and observed committed sequence; the server constructs the snapshot from persisted operations.

### WebSocket protocol and recovery

Use versioned JSON on `/ws` with authentication/refresh, room join, operation preview/commit, preview cancellation, committed acknowledgement, room state, presence, and structured error messages.

Require authentication within five seconds. Validate token signature, expiry, issuer, and allowed frontend origin; refresh before expiry. Never put session tokens in connection URLs. One connection subscribes to one authorized room at a time.

Serialize commits per room. Broadcast and acknowledge only after database commit. Supply a consistent state through sequence N before delivering newer operations. Throttle previews to at most twenty updates per second; do not persist previews.

Use server ping/pong heartbeats every thirty seconds. Reconnect with exponential backoff and jitter capped at thirty seconds, refresh authentication, restore state, and retry pending operations with their original UUIDs. Disable new drawing while disconnected. Pending changes remain in memory only while the page remains open; warn before navigation loses unacknowledged work.

## Phase 1 — Assessment, runtime, and configuration

**Objective:** Establish a reproducible foundation and review the interrupted changes.

**Prerequisites:** Existing workspace and local Windows tooling. Phase 1 remains deferred overall; completed setup is summarized below.

**Implementation checklist, in order:**

- [ ] Review partial source changes against this plan and identify unfinished integration.
- [x] Node 24.22.2/npm 11.19.1, version pins, engines (`^24.15.0`), imports, lockfiles, and 333 dependency engine ranges checked; Git initialized and generated/local files ignored.
- [x] Clerk secret replacement reported by the user; local environment files ignored and backend example uses placeholders. Clerk-side revocation was not independently checked.
- [ ] Review Git history for credentials before publishing; never commit replacement keys.
- [x] Backend entry is `server.js`; configuration loads system variables → `.env.local` → `.env` and rejects missing/blank/template values without revealing secrets.
- [ ] Review environment examples and read-only check scripts.
- [x] Install and check `@clerk/vue@2.5.16`, `pg@8.23.1`, and `@clerk/backend@3.26.5` with matching manifests/lockfiles.
- [ ] Resolve the existing development-only `nodemon → minimatch` audit findings (2 moderate entries; [GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249)).
- [x] Verify live Supabase Session Pooler connectivity through `pg`: login, encrypted TLS with certificate verification, and read-only `SELECT 1` pass.
- [ ] Finish live Clerk backend integration; keep credentials in ignored local/runtime configuration. Supabase schema setup is verified in Phase 6.

**Verified setup:** READMEs cover runtime and configuration; frontend checks and backend syntax/imports passed. Production audit reported zero findings; two existing dev-only moderate entries remain. Supabase tables, repository readiness, real backend startup on port 3000, and graceful shutdown now pass.

**Deliverables:** Reviewed baseline, runtime requirements, environment examples, scripts, and reproducible dependency manifests/lockfiles.

**Acceptance checklist:**

- [x] Start the backend with real configuration/Supabase; `/healthz` and `/readyz` return HTTP 200, and shutdown completes cleanly.
- [ ] Recheck frontend/backend together during authenticated room integration.
- [x] Updated build/type-check/lint and backend syntax checks pass on Node 24.22.2.
- [x] Missing configuration reports variable names without revealing values.

**Risk → response:** Environment setup can expand; defer Docker troubleshooting until the local MVP.

## Phase 2 — Frontend foundation and canvas

**Status:** Accepted. Phase 1 was deferred by the user; implementation used the available local tooling.

- [x] Routes/placeholders, drawing types/renderer, Pinia state, and local freehand canvas with logical coordinates, high-DPI rendering, resize replay, pointer capture, and cancellation.

**Deliverables:** `DrawingCanvas.vue`, `drawing/model.ts`, `drawing/renderer.ts`, stores, and views under `frontend/src/`.

**Verified:** Build/type-check, read-only lint, tests, and browser checks passed: resize preserves proportions, DPR 2 is sharp, outside release ends drawing, and cancellation leaves no operation.

## Phase 3 — Drawing tools and interface

**Objective:** Complete a usable single-user studio.

**Depends on:** Phase 2.

**Implementation checklist, in order:**

- [x] Five tools, separate previews, color/width controls (1–50 px), and independent brush/eraser sizes.
- [x] P/L/R/C/E shortcuts and local undo/redo with Ctrl+Z, Ctrl+Y, and Ctrl+Shift+Z.
- [x] Responsive Studio, accessible controls/status, action feedback, and styled reset confirmation protecting drawing/redo history.
- [ ] Add room information and connection indicators when shared-room flows are integrated.

**Deliverables:** Tool toolbar, preview layer, studio layout, and tool-state controls.

**Verified local acceptance:** Checks and four drawing tests passed. Chrome/Edge verified all tools/drag directions, geometry, eraser replay, previews/cancellation, shortcuts, undo/redo, action accessibility, and reset behavior. Emulated 320–1280 px layouts, DPR 2, and touch passed; physical-phone testing is not recorded.

**Risk → response:** Preview artifacts can alter committed content; isolate preview rendering.

**Milestone:** Working local drawing application.

## Phase 4 — Clerk, rooms, and backend foundation

**Objective:** Establish authenticated room access and communication.

**Depends on:** Accepted frontend foundations, configured Clerk, and the early database bootstrap described in Phase 6. Other Phase 1 work remains deferred overall.

**Implementation checklist, in order:**

- [ ] Review server startup, HTTP, authentication, room, and WebSocket module boundaries.
- [x] Clerk plugin, local configuration, header account controls, and SDK `getToken` adapter integrated; real sign-in/reload/sign-out confirmed by the user.
- [x] Shared backend token verifier checks signature, issuer, expiry, origin, and session claims with real SDK/offline RSA fixtures.
- [x] Development/test `MemoryRepository` create/list/metadata ownership checks pass; normal `server.js` startup uses `PostgresRepository`.
- [x] Start the PostgreSQL-backed backend after bootstrap; health/readiness return 200 and unauthenticated `GET /api/rooms` returns 401 (`AUTH_REQUIRED`).
- [x] Add `CreateRoomForm.vue` to Gallery, typed `services/rooms.ts`, and structured `ApiError` codes; send only the trimmed title through the existing Clerk-token API helper. Frontend build/type-check, targeted lint/formatting, and four drawing tests pass.
- [ ] Verify real account tokens and Clerk JWKS retrieval during authenticated room integration.
- [ ] Accept the create-room form in a browser: signed-out/loading states, name validation, duplicate-submit prevention, success/error feedback, responsive layout, and clearing stale results on sign-out/account changes.
- [ ] Verify actual room creation with Clerk/Supabase: server-assigned ownership, first membership, visible success only after persistence, and no false success on failure.
- [ ] Add frontend room listing; verify only the signed-in user's memberships appear and created rooms remain available after reload.
- [ ] Integrate invitation joining, member-only room metadata, and owner-only invitation replacement; test two real accounts.
- [ ] Keep repositories injectable and memory storage limited to isolated development/tests; a separate memory runner is no longer a prerequisite.
- [ ] Review/complete health checks, exact origin restrictions, request/message validation, and structured errors.
- [ ] Complete and verify WebSocket authentication, expiry handling, heartbeat, and disconnect cleanup.

**Deliverables:** Clerk UI integration, protected routes, room service, and protocol documentation.

**Verified progress:** 39 earlier backend tests cover offline auth/in-memory rooms; live backend health/readiness, unauthenticated rejection, and shutdown pass. Creation UI/API wiring and Vietnamese function comments are present; frontend checks pass. Browser smoke checking did not complete in this pass, and no real authenticated room write has been verified. Listing/joining are not implemented in the UI yet.

**Acceptance checklist:**

- [ ] Two signed-in users join a room through an invitation.
- [ ] Unauthorized requests/subscriptions fail.
- [ ] Traffic never leaks between rooms.

**Risk → response:** HTTP CORS does not protect WebSockets; validate upgrade origins separately.

## Phase 5 — Real-time synchronization and reconnection

**Objective:** Keep all participants' drawing state consistent.

**Depends on:** Phase 4.

**Implementation checklist, in order:**

- [ ] Add throttled remote gesture previews and cancellation.
- [ ] Implement ordered commits, acknowledgements, and duplicate suppression.
- [ ] Reconcile optimistic local drawing with authoritative server order.
- [ ] Implement consistent late-join synchronization.
- [ ] Add reconnect/backoff, authentication refresh, pending retries, and sign-out cleanup.
- [ ] Add connection feedback and navigation warnings for unacknowledged work.

**Deliverables:** Integrated WebSocket client/store, ordered room state, recovery UI, and concurrency tests.

**Existing draft:** `frontend/src/stores/board.ts` contains connection, token refresh, pending operation, and retry logic; `backend/src/application.js` and `queue.js` contain room messaging and serialized work. These paths have not been verified through authenticated multi-user workflows. Preview throttling and client/UI wiring still require review.

**Acceptance checklist:**

- [ ] Concurrent drawings converge, including overlapping erasing.
- [ ] Late joiners receive the complete board.
- [ ] Reconnect/retry does not duplicate operations.
- [ ] New drawing is disabled while disconnected.

**Risk → response:** Erasing is order-sensitive; replay server-ordered operations.

**Verification limit:** Database bootstrap does not prove operation durability; transactional persistence and restart recovery are accepted in Phase 6.

## Phase 6 — Supabase persistence and snapshots

**Objective:** Persist completed drawing operations and provide the personal gallery.

**Depends on:** Supabase credentials and the agreed development target for database bootstrap; Phase 5 for full operation/snapshot acceptance. Run bootstrap before Phase 4 live backend integration because `server.js` already requires PostgreSQL tables.

**Implementation checklist, in order:**

- [x] Live connection through `pg@8.23.1`, TLS certificate verification, and read-only `SELECT 1` pass against Supabase Session Pooler (port 5432).
- [x] Review/apply `001_initial.sql` using `scripts/migrate.js`; migration record/checksum match and rerunning leaves one migration record.
- [x] Verify `drawing.rooms`, `drawing.room_members`, `drawing.room_operations`, and `drawing.saved_drawings` exist with RLS enabled; repository readiness passes.
- [ ] Verify bounded pooling, timeouts, and PostgreSQL room/membership/operation repositories under real queries and failures.
- [ ] Commit operation insertion and sequence allocation atomically before acknowledgement.
- [ ] Add owner-only shared checkpoints and member-created private snapshots.
- [ ] Add owned/joined rooms and private copies to the gallery, with vector-generated thumbnails.
- [ ] Open saved snapshots into independent rooms and restore live rooms after restart.
- [ ] Document database backup and restore procedures.

**Deliverables:** Migrations, repositories, save/open endpoints, gallery, and persistence tests.

**Confirmed boundary:** Migration created the four application tables and `drawing.schema_migrations`; only schema/metadata and readiness were checked. Authenticated room writes, operation persistence, save/load, ownership, and durability remain unverified. Database bootstrap alone does not complete Phase 6.

**Acceptance checklist:**

- [ ] Acknowledged operations survive process restart.
- [ ] Lost acknowledgements and retries create no duplicates.
- [ ] Private copies remain owner-only; nonowners cannot save shared checkpoints.
- [ ] Opening saved work preserves the original board.
- [ ] Database failure never produces a false successful acknowledgement/save.

**Risk → response:** Connectivity and quotas affect writes; use timeouts, bounded pooling, visible errors, and idempotent retries.

**Milestone:** Functional local collaborative MVP.

## Phase 7 — Docker packaging and local container testing

**Objective:** Package the proven backend with minimal infrastructure.

**Depends on:** Phase 6; Docker Desktop/WSL2 available and running.

**Implementation checklist, in order:**

- [ ] Verify Docker Desktop and WSL2 prerequisites.
- [ ] Add a backend Dockerfile and `.dockerignore`.
- [ ] Use supported Node 24 Debian slim, production dependencies, and a non-root process.
- [ ] Pass secrets at runtime; exclude local dependencies and environment files from layers.
- [ ] Test HTTP, WebSocket upgrades, Supabase connectivity, and graceful shutdown.

**Deliverables:** Backend image, build/run instructions, and container smoke-test results.

**Acceptance checklist:**

- [ ] Containerized backend passes the local application workflows.
- [ ] Restart restores persisted drawing state.
- [ ] Secrets are absent from image layers.

**Risk → response:** Windows/Docker setup can delay progress; schedule it after the MVP. No Kubernetes or frontend container is required.

## Phase 8 — Full integration and failure handling

**Objective:** Finish coherent user journeys against the containerized backend.

**Depends on:** Phase 7.

**Implementation checklist, in order:**

- [ ] Configure frontend API/WS URLs and exact backend origins.
- [ ] Connect sign-in → gallery → create/join → draw → save → reopen.
- [ ] Block snapshot saving until local operations are acknowledged.
- [ ] Handle expired sessions, invalid invitations, missing rooms, limits, and database outages.
- [ ] Handle service wake-up delays and unexpected non-JSON responses.

**Deliverables:** Integrated interface, environment matrix, and documented error behavior.

**Acceptance checklist:**

- [ ] Two accounts complete the full collaboration/save/reopen journey.
- [ ] Failures display useful next actions.
- [ ] Unpersisted work is never described as successfully saved.

**Risk → response:** Cold starts resemble failures; show a retryable connecting state.

## Phase 9 — Automated and manual verification

**Objective:** Produce repeatable evidence that the MVP works.

**Depends on:** Phase 8 for the final suite; tests are added throughout earlier phases.

**Implementation checklist, in order:**

- [x] Four drawing tests and 39 offline backend tests (28 auth/HTTP/WS and 11 repository/HTTP room cases) pass; a separate read-only live Supabase connection check also passes.
- [x] Live database bootstrap/startup smoke check: migration checksum/rerun, four tables/RLS, repository readiness, HTTP health/readiness, unauthenticated API rejection, and graceful shutdown pass.
- [x] Create-room frontend changes pass production build/type-check, targeted Oxlint/ESLint, formatting, and the four existing drawing tests.
- [ ] Add Vitest/Vue Test Utils coverage for geometry, renderer behavior, and UI state.
- [ ] Test HTTP/WS authorization, ordering, retries, and persistence with Node's test runner.
- [ ] Isolate database tests from development/demo data.
- [ ] Add Playwright journeys using two independently authenticated browser contexts.
- [ ] Add CI for read-only checks, tests, and the production build.
- [ ] Test ten clients, network interruptions, expired tokens, database outages, and restarts.
- [ ] Record browser compatibility, latency, and known limitations.

**Deliverables:** Test suites, CI workflow, acceptance matrix, and measured results.

**Commands/evidence:** `node --test frontend/tests/drawing.test.mjs` from the root; `npm test` from `backend/`. Frontend build/type-check, targeted lint/formatting, and four drawing tests were rerun for room creation and pass; 39 backend tests remain the prior verified result. Live database bootstrap/startup checks are separate smoke checks. Browser creation acceptance, Vitest, Vue Test Utils, Playwright, CI, and authenticated room/persistence suites remain pending.

**Acceptance checklist:**

- [ ] Core workflows pass automated tests.
- [ ] Restart between commit and acknowledgement creates no duplicate.
- [ ] Room isolation, checkpoint ownership, and private-copy access tests pass.
- [ ] Ten-client demo remains usable.
- [ ] Measure previews against a 250 ms local-network target; report actual observations.

**Risk → response:** Pixel comparisons are sensitive to antialiasing; prioritize operation/geometry assertions and use tolerant visual checks.

## Phase 10 — Free-tier deployment and final verification

**Objective:** Publish the small demonstration only after local acceptance and deployment approval.

**Depends on:** Phase 9 passing; hosting accounts, secrets, and explicit deployment approval.

**Implementation checklist, in order:**

- [ ] Prepare separate demonstration database configuration and apply reviewed migrations.
- [ ] Deploy one Render Free Docker backend instance.
- [ ] Configure Vercel: root `frontend`, build `npm run build`, output `dist`, and SPA fallback.
- [ ] Configure HTTPS/WSS, exact origins, and Clerk demonstration keys.
- [ ] Verify separate accounts/devices, direct links, token renewal, cold starts, and restarts.
- [ ] Export a database backup and document application rollback.
- [ ] Rehearse a local fallback before the university presentation.

**Deliverables:** Demo URLs, deployment runbook, backup, verification evidence, and local fallback.

**Acceptance checklist:**

- [ ] Direct room links and authentication work on the deployed frontend.
- [ ] Two devices collaborate over WSS.
- [ ] Drawings survive backend redeployment.
- [ ] Service availability and free-tier usage are checked before presentation.

**Risk → response:** Free hosting may sleep, pause, restart, or reach quotas; verify services ahead of the demo and retain the local fallback.

Recheck current limits before deployment: [Supabase pricing](https://supabase.com/pricing), [Render Free restrictions](https://render.com/docs/free), [Clerk environments](https://clerk.com/docs/guides/development/managing-environments), and [Vercel Hobby](https://vercel.com/docs/plans/hobby). Use Clerk development keys only for the agreed test/demo environment; a production launch requires its own configuration review.

## Phase 11 — Documentation and university report

**Objective:** Make the project reproducible and explain the engineering decisions.

**Depends on:** Phase 10 for final deployment evidence; document each earlier milestone as it is completed.

**Implementation checklist, in order:**

- [x] Contributor guide, phased progress plan, and Vietnamese function comments maintained in implemented frontend/backend modules.
- [ ] Replace starter documentation with Windows/PowerShell setup and troubleshooting.
- [ ] Document environment variables, scripts, migrations, backups, and Docker commands.
- [ ] Produce architecture, ER, and synchronization diagrams.
- [ ] Explain coordinate conversion, server ordering, idempotency, reconnection, and snapshot semantics.
- [ ] Record test evidence, performance observations, free-tier constraints, and future work.
- [ ] Prepare report, slides, screenshots, demonstration script, and recording.

**Deliverables:** README, technical documentation, university report, and presentation materials.

**Acceptance checklist:**

- [ ] Another student can reproduce setup from the documentation.
- [ ] Report claims match implemented and verified behavior.
- [ ] The demo covers tools, collaboration, recovery, and saved copies.

**Risk → response:** Documentation can accumulate; update it alongside each phase.

## Configuration and sequencing

Frontend public build-time variables: `VITE_API_BASE_URL`, `VITE_WS_URL`, and `VITE_CLERK_PUBLISHABLE_KEY`.

Backend runtime variables: `PORT`, `NODE_ENV`, `ALLOWED_ORIGINS`, `DATABASE_URL`, database TLS/CA settings, `CLERK_PUBLISHABLE_KEY`, and `CLERK_SECRET_KEY`. Never put database credentials or secret keys in `VITE_*` variables. Separate test/development/demo database targets.

Current sequence: **Phase 4 room UI/live Clerk → Phase 5 synchronization → remaining Phase 6 persistence/snapshots → Phases 7–11**. Phases 2–3 local acceptance and early Phase 6 database bootstrap/backend health checks are complete; remaining Phase 1 tasks stay tracked. Testing and documentation continue throughout.

Assume **8–10 weeks at 12–15 hours/week**: weeks 1–2 for foundations/tools, 3–4 for rooms/synchronization, 5–6 for persistence/gallery, week 7 for Docker/integration, week 8 for testing/deployment, and weeks 9–10 for documentation and contingency.

## Next step and final completion gate

**Next small step:** Verify the existing create-room form at `/gallery` with a real signed-in Clerk account and the PostgreSQL-backed API. Check token/JWKS handling, successful room/member insertion, server-assigned ownership, browser behavior, and useful error states. The frontend is wired; this acceptance is still pending.

After creation is accepted, implement the room list and reload persistence/ownership checks. Invitation joining with two accounts follows afterward; do not start collaboration or snapshot features in this step.

Database bootstrap and live backend health checks are complete. The temporary backend process was stopped after verification; run `npm start` from `backend/` for local development. Keep the memory repository for isolated tests. Continue one requested step at a time.

The project is complete only when all requested tools, authenticated rooms, real-time collaboration, consistent reconnection, durable operations, shared checkpoints, private snapshots, and reopen workflows pass locally and on the approved demo deployment, with reproducible documentation and test evidence.
