# Multi-User Online Drawing Application — Development Plan

## Status and approval gate

Current progress: Phase 2 frontend foundation and local freehand canvas have been implemented and accepted. Later phases have not been started. Continue only within the phase the user has requested.

Earlier implementation created partial backend modules, a SQL migration, environment examples, frontend drawing utilities, an authentication adapter, and a board store. These changes remain in the workspace and have not been accepted as a completed application. Review and verify them before continuing; do not assume any phase is complete.

Checklist convention: `[ ]` means pending or unverified; mark `[x]` only after the stated acceptance criteria pass. Phase 2 implementation and acceptance checks are complete.

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

Defer undo/redo, layers, chat, public room discovery, offline editing, and horizontal backend scaling.

## Confirmed findings and remaining prerequisites

- Project root: `C:\Users\LENOVO\Desktop\DACS4`; applications are in `frontend/` and `backend/`.
- The original frontend is a Vue starter; its routes and UI still need application integration.
- The original backend exposes HTTP and WebSocket welcome behavior; partial replacement modules now require review and integration.
- Existing frontend scripts include development, type-check, build, preview, lint, and formatting. The original backend test script is a placeholder.
- Baseline starter build/type-check, read-only lint, and backend syntax checks passed before implementation. They do not validate the newer partial changes.
- The inspected Node version, 24.11.1, does not satisfy the frontend's declared Node 24 requirement of at least 24.12.0.
- Docker was unavailable on the inspected shell's PATH; no root Git repository was detected.
- New dependency downloads failed in the restricted environment; an elevated installation request was declined. Do not treat those packages as installed.
- No working Clerk credentials, Supabase connection, database migrations, Docker runtime, or deployed application have been verified.

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
- [ ] Upgrade/align local Node to a supported Node 24 release satisfying `>=24.12.0`.
- [ ] Review root ignore rules before initializing Git; exclude secrets and generated files.
- [ ] Correct backend package metadata, load environment configuration, and validate required variables.
- [ ] Review environment examples and read-only check scripts.
- [ ] Install approved dependencies and update lockfiles consistently.
- [ ] Prepare Clerk development settings and a Supabase development database without exposing credentials.

**Deliverables:** Reviewed baseline, runtime requirements, environment examples, scripts, and reproducible dependency manifests/lockfiles.

**Acceptance checklist:**

- [ ] Frontend and backend start independently with valid configuration.
- [ ] Updated build/type-check/lint and backend syntax checks pass.
- [ ] Missing configuration reports variable names without revealing values.

**Risk → response:** Environment setup can expand; defer Docker troubleshooting until the local MVP.

## Phase 2 — Frontend foundation and canvas

**Objective:** Deliver reliable local freehand drawing.

**Planned dependency:** Phase 1. The user deferred Phase 1, and Phase 2 was completed with the available local tooling.

**Implementation checklist, in order:**

- [x] Create home/local studio, gallery, invitation, and room navigation (gallery, room, and invitation routes are placeholders until later phases).
- [x] Review drawing types and implement a reusable renderer.
- [x] Establish Pinia tool, document, and connection state for local drawing.
- [x] Implement logical coordinates, high-DPI rendering, pointer capture, and cancellation in the canvas component.
- [x] Replay the document on resize and complete local freehand drawing.

**Deliverables:** Canvas component, renderer/composable, drawing types, and room/local views.

**Acceptance checklist:**

- [x] Drawing position and proportions survive resizing.
- [x] Pointer release outside the canvas ends the gesture.
- [x] High-DPI displays remain sharp; canceled gestures leave no operation.

**Verified:** Frontend production build and type-check, read-only lint, three drawing model/replay tests, and HTTP route smoke checks passed. Chrome browser checks confirmed pointer release outside the canvas, vector replay after resize, a 2× backing store at DPR 2, and cancellation without a new operation. The browser check exposed and prompted a fix for lost pointer capture. Phase 2 is accepted. The current canvas supports freehand drawing only; other tools and controls belong to Phase 3.

**Risk → response:** Resizing clears pixels; redraw from document operations.

## Phase 3 — Drawing tools and interface

**Objective:** Complete a usable single-user studio.

**Depends on:** Phase 2.

**Implementation checklist, in order:**

- [ ] Add line, rectangle, circle, and eraser tools.
- [ ] Add color selection and brush-size controls.
- [ ] Separate temporary gesture previews from committed drawing state.
- [ ] Add accessible toolbar labels, keyboard focus, room information, and connection indicators.
- [ ] Make the layout responsive and implement clear feedback for unavailable actions.

**Deliverables:** Tool toolbar, preview layer, studio layout, and tool-state controls.

**Acceptance checklist:**

- [ ] Tools work in all drag directions; circles follow the defined geometry.
- [ ] Erasing remains correct after replay.
- [ ] Selected tools and disabled actions are clear.

**Risk → response:** Preview artifacts can alter committed content; isolate preview rendering.

**Milestone:** Working local drawing application.

## Phase 4 — Clerk, rooms, and backend foundation

**Objective:** Establish authenticated room access and communication.

**Depends on:** Phases 1–3; configured Clerk development instance.

**Implementation checklist, in order:**

- [ ] Review server startup, HTTP, authentication, room, and WebSocket module boundaries.
- [ ] Consolidate the partial authentication adapter into the official Clerk Vue integration and backend verification.
- [ ] Implement create/join/list room flows with server-side membership checks.
- [ ] Use a replaceable repository interface; any interim in-memory storage remains test/development-only.
- [ ] Add health checks, exact origin restrictions, request/message validation, and structured errors.
- [ ] Implement WebSocket authentication, expiry handling, heartbeat, and disconnect cleanup.

**Deliverables:** Clerk UI integration, protected routes, room service, and protocol documentation.

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

- [ ] Add Vitest/Vue Test Utils coverage for geometry, renderer behavior, and UI state.
- [ ] Test HTTP/WS authorization, ordering, retries, and persistence with Node's test runner.
- [ ] Isolate database tests from development/demo data.
- [ ] Add Playwright journeys using two independently authenticated browser contexts.
- [ ] Add CI for read-only checks, tests, and the production build.
- [ ] Test ten clients, network interruptions, expired tokens, database outages, and restarts.
- [ ] Record browser compatibility, latency, and known limitations.

**Deliverables:** Test suites, CI workflow, acceptance matrix, and measured results.

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

Phase 1 remains deferred at the user's request. Phase 2 is complete; continue with Phase 3 one step at a time when requested. Phase 1's runtime and configuration prerequisites must be resolved before backend integration.

The project is complete only when all requested tools, authenticated rooms, real-time collaboration, consistent reconnection, durable operations, shared checkpoints, private snapshots, and reopen workflows pass locally and on the approved demo deployment, with reproducible documentation and test evidence.

**Current scope:** Phase 2 is accepted. Do not treat later phases as implemented; follow the user's requested phase and step before continuing.
