# Multi-User Online Drawing Application — Development Plan

## Status and approval gate

Last progress review: **2026-10-30**. Phase 2 and local Phase 3 criteria are accepted. Clerk SDK/plugin registration, account controls, and the live sign-in modal are verified. Real authenticated sessions and shared-room indicators remain pending in Phase 4. Continue one requested step at a time.

Earlier implementation created partial backend modules, a SQL migration, environment examples, frontend drawing utilities, an authentication adapter, and a board store. These changes remain in the workspace and have not been accepted as a completed application. Review and verify them before continuing; do not assume any phase is complete.

Checklist convention: `[ ]` means pending/unverified; `[x]` means verified. Update completed work in place with brief deliverables and test results; retain unfinished tasks and acceptance criteria in full.

### Current phase status

| Phase | Confirmed progress | Remaining work |
| --- | --- | --- |
| 1 — Environment | Root Git repository and ignore rules exist; environment examples and configuration code exist. | Deferred overall; align Node, correct backend metadata, install backend dependencies, and verify credentials/startup. |
| 2 — Canvas foundation | Accepted: routes, local freehand drawing, logical coordinates, high-DPI rendering, resize replay, and pointer cancellation. | None within its accepted scope. |
| 3 — Tools/UI | Local Studio acceptance passed, including all tools, previews, undo/redo, responsive layout, feedback, and reset confirmation. | Shared-room details and connection indicators during Phase 4. |
| 4 — Authentication/rooms | SDK/plugin, local publishable key, header account controls, and live sign-in modal verified. | Consolidate the auth adapter; verify real sign-in/out, restored sessions, and protected room workflows. |
| 5 — Synchronization | Draft WebSocket/queue/store logic exists. | Integrate room UI and verify ordering, isolation, previews, retries, and reconnection. |
| 6 — Persistence | SQL migration and PostgreSQL repository source exist. | Apply migrations to an approved Supabase target and verify saves, snapshots, ownership, and restart recovery. |
| 7 — Docker | No Docker packaging exists. | Complete packaging and container checks after the local MVP. |
| 8 — Integration | Local Studio works independently. | Complete authenticated collaboration and save/reopen journeys. |
| 9 — Testing | Four initial drawing tests pass; frontend build/type-check/lint and browser checks have passed. Backend syntax checks pass. | Vitest/Vue Test Utils, backend integration tests, Playwright, CI, and failure/load testing. |
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

## Confirmed findings and remaining prerequisites

- Project root: `C:\Users\LENOVO\Desktop\DACS4`; applications are in `frontend/` and `backend/`.
- The frontend now contains a working personal Studio. Gallery, room, and invitation views remain placeholders.
- The backend now contains startup/configuration, HTTP/WebSocket, validation, queue, and PostgreSQL repository modules; these remain unverified as a running integrated service.
- Existing frontend scripts include development, type-check, build, preview, lint, and formatting. The original backend test script is a placeholder.
- Verified: frontend build/type-check/lint, drawing tests, Studio browser checks, and backend syntax. Backend runtime behavior remains unverified.
- The inspected Node version is still 24.11.1. The frontend declares at least 24.12.0 for Node 24; some currently locked development tools require at least 24.15.0. Align Node with the installed toolchain before backend integration.
- Git is initialized; ignore rules were verified for local environment files, dependencies, builds, and temporary artifacts.
- Docker remains unavailable on the inspected shell's PATH; no Dockerfile exists.
- `@clerk/vue@2.5.16` is installed in `frontend/` and recorded in its manifest and lockfile. `pg` and `@clerk/backend`, which are imported by backend startup, are neither declared nor installed in `backend/`.
- Backend dotenv loading and configuration validation already exist in `backend/src/config.js`; `backend/package.json` still points `main` to nonexistent `index.js`.
- The Clerk development publishable key is configured in ignored `frontend/.env.local`; the live signed-out state and sign-in modal work. Authenticated sessions, Supabase connectivity/migrations, Docker runtime, and deployment remain unverified.

Assume Windows, PowerShell, VS Code, internet access for Clerk/Supabase, one backend process, and a single student developer. Never copy secrets into this document.

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

**Prerequisites:** Explicit approval to resume implementation; access to the existing workspace.

**Implementation checklist, in order:**

- [ ] Review partial source changes against this plan and identify unfinished integration.
- [ ] Upgrade/align local Node to a supported Node 24 release satisfying the locked toolchain requirements (currently `>=24.15.0`).
- [x] Git initialized; local environment, dependency, and build paths are ignored and untracked.
- [ ] Correct backend package metadata, load environment configuration, and validate required variables.
- [ ] Review environment examples and read-only check scripts.
- [ ] Install approved dependencies and update lockfiles consistently.
- [ ] Prepare Clerk development settings and a Supabase development database without exposing credentials.

**Existing artifacts:** Dotenv loading, configuration validation, and environment examples are present. The approved frontend Clerk SDK installation is complete; the broader dependency/setup task remains open because backend `pg` and `@clerk/backend`, runtime alignment, and service configuration are pending. Phase 1 remains deferred overall.

**Deliverables:** Reviewed baseline, runtime requirements, environment examples, scripts, and reproducible dependency manifests/lockfiles.

**Acceptance checklist:**

- [ ] Frontend and backend start independently with valid configuration.
- [ ] Updated build/type-check/lint and backend syntax checks pass.
- [ ] Missing configuration reports variable names without revealing values.

**Risk → response:** Environment setup can expand; defer Docker troubleshooting until the local MVP.

## Phase 2 — Frontend foundation and canvas

**Status:** Accepted. Phase 1 was deferred by the user; implementation used the available local tooling.

- [x] Home/Studio navigation and placeholder gallery, room, and invitation routes.
- [x] Drawing types, reusable renderer, Pinia state, and local freehand canvas.
- [x] Logical coordinates, high-DPI rendering, resize replay, pointer capture, and cancellation.

**Deliverables:** `DrawingCanvas.vue`, `drawing/model.ts`, `drawing/renderer.ts`, stores, and views under `frontend/src/`.

**Verified:** Build/type-check, read-only lint, drawing tests, and browser checks passed. Drawing proportions survive resize; the canvas uses a 2× backing store at DPR 2; releasing outside ends a gesture; cancellation leaves no operation.

## Phase 3 — Drawing tools and interface

**Objective:** Complete a usable single-user studio.

**Depends on:** Phase 2.

**Implementation checklist, in order:**

- [x] Freehand, line, rectangle, circle, and eraser tools with separate previews and commits on release.
- [x] Color and width controls (1–50 px), with independent brush and eraser sizes.
- [x] P/L/R/C/E tool shortcuts and local undo/redo with Ctrl+Z, Ctrl+Y, and Ctrl+Shift+Z.
- [x] Accessible labels/focus, live tool/count status, disabled-action hints, and temporary action feedback.
- [x] Responsive Studio layout and styled new-page confirmation protecting drawing and redo history.
- [ ] Add room information and connection indicators when shared-room flows are integrated.

**Deliverables:** Tool toolbar, preview layer, studio layout, and tool-state controls.

**Acceptance checklist:**

- [x] Tools work in all drag directions; circles follow the defined geometry.
- [x] Erasing remains correct after replay.
- [x] Selected tools are clear to keyboard and screen-reader users.
- [x] Disabled Studio actions are clear.

**Verified:** Build/type-check, read-only lint, and four drawing tests passed. Chrome/Edge checks covered 20 gestures across five tools/four directions, previews before commit, degenerate shape rejection, cancellation, color/width, eraser replay, keyboard guards, undo/redo, feedback, and reset cancellation/confirmation. Emulated widths of 320–1280 px preserved the 16:9 canvas without horizontal overflow; DPR 2 and simulated touch were checked. Physical-phone testing has not been recorded.

**Risk → response:** Preview artifacts can alter committed content; isolate preview rendering.

**Milestone:** Working local drawing application.

## Phase 4 — Clerk, rooms, and backend foundation

**Objective:** Establish authenticated room access and communication.

**Depends on:** Phases 1–3; configured Clerk development instance.

**Implementation checklist, in order:**

- [ ] Review server startup, HTTP, authentication, room, and WebSocket module boundaries.
- [x] Install `@clerk/vue@2.5.16` and update the npm manifest/lockfile.
- [x] Register conditional `clerkPlugin` in `main.ts`; document `.env.local` setup and use SDK-compatible types.
- [x] Configure the development publishable key in ignored `.env.local`; keep `.env.example` blank.
- [x] Add header loading/delayed, signed-out, and signed-in controls using `SignInButton`, `UserButton`, and `useUser`; share configuration with plugin startup.
- [ ] Verify real sign-in, sign-out, and session restoration with an account.
- [ ] Consolidate the partial authentication adapter into the official Clerk Vue integration and backend verification.
- [ ] Implement create/join/list room flows with server-side membership checks.
- [ ] Use a replaceable repository interface; any interim in-memory storage remains test/development-only.
- [ ] Add health checks, exact origin restrictions, request/message validation, and structured errors.
- [ ] Implement WebSocket authentication, expiry handling, heartbeat, and disconnect cleanup.

**Deliverables:** Clerk UI integration, protected routes, room service, and protocol documentation.

**Verified progress:** Build/type-check and read-only lint pass. Edge loaded the live signed-out state and opened Clerk's sign-in modal. Header layouts at 320–1280 px and blank-key local drawing passed. SDK-boundary simulations covered loading, signed-in name/menu, and sign-out UI; real account authentication/restoration remains unverified. `services/auth.ts` still manually loads Clerk scripts and needs consolidation before room integration. No room acceptance criterion is complete.

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

**Interim limit:** Durable restart recovery is completed in Phase 6.

## Phase 6 — Supabase persistence and snapshots

**Objective:** Persist completed drawing operations and provide the personal gallery.

**Depends on:** Phase 5; Supabase credentials and approved migration target.

**Implementation checklist, in order:**

- [ ] Review/apply versioned migrations for the private application schema.
- [ ] Configure TLS, bounded connection pool, and operation repositories.
- [ ] Replace interim storage with Supabase-backed room/membership/operation persistence.
- [ ] Commit operation insertion and sequence allocation atomically before acknowledgement.
- [ ] Add owner-only shared checkpoints and member-created private snapshots.
- [ ] Add owned/joined rooms and private copies to the gallery, with vector-generated thumbnails.
- [ ] Open saved snapshots into independent rooms and restore live rooms after restart.
- [ ] Document database backup and restore procedures.

**Deliverables:** Migrations, repositories, save/open endpoints, gallery, and persistence tests.

**Existing draft:** `backend/migrations/001_initial.sql`, `scripts/migrate.js`, and `src/repository.js` define schema/migration and room/operation/snapshot persistence code. Their presence is not evidence of a migration applied to Supabase or a successful save. The gallery remains a placeholder; all persistence acceptance criteria remain open.

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

- [x] Four Node drawing tests: coordinate clamping, point limits, ordered replay, and circle geometry.
- [ ] Add Vitest/Vue Test Utils coverage for geometry, renderer behavior, and UI state.
- [ ] Test HTTP/WS authorization, ordering, retries, and persistence with Node's test runner.
- [ ] Isolate database tests from development/demo data.
- [ ] Add Playwright journeys using two independently authenticated browser contexts.
- [ ] Add CI for read-only checks, tests, and the production build.
- [ ] Test ten clients, network interruptions, expired tokens, database outages, and restarts.
- [ ] Record browser compatibility, latency, and known limitations.

**Deliverables:** Test suites, CI workflow, acceptance matrix, and measured results.

**Current verification:** `node --test frontend/tests/drawing.test.mjs` passes all four tests; backend syntax checks pass. Frontend build/type-check/lint and browser evidence are summarized in Phases 2–4. Backend `npm test` is still a placeholder; Vitest, Vue Test Utils, Playwright, and CI are not configured.

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

- [x] Maintain `AGENTS.md`, the phased plan, and verified progress records.
- [x] Vietnamese function comments in frontend drawing/Studio/stores and backend startup, validation, and persistence modules.
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

Sequence: **1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10 → 11**. Testing and documentation begin early; their final phases consolidate evidence.

Assume **8–10 weeks at 12–15 hours/week**: weeks 1–2 for foundations/tools, 3–4 for rooms/synchronization, 5–6 for persistence/gallery, week 7 for Docker/integration, week 8 for testing/deployment, and weeks 9–10 for documentation and contingency.

## First phase and final completion gate

Phase 1 remains deferred overall at the user's request. Phase 2 and local Phase 3 acceptance have passed; shared-room indicators wait for Phase 4. Next, consolidate the partial authentication adapter with the SDK, then verify real sign-in/out and restored sessions before room integration. Resolve Phase 1's Node, backend dependency, and configuration prerequisites before backend integration.

The project is complete only when all requested tools, authenticated rooms, real-time collaboration, consistent reconnection, durable operations, shared checkpoints, private snapshots, and reopen workflows pass locally and on the approved demo deployment, with reproducible documentation and test evidence.

**Current scope:** Personal drawing, Clerk setup, header controls, and the live sign-in modal are verified. Real authenticated sessions, shared rooms, real-time collaboration, Supabase saves/copies, Docker, and deployment remain pending integration and acceptance. Continue one requested step at a time.
