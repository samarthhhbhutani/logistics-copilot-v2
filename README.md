# Logistics Copilot v2

Mailbox copilot for a logistics desk: Gmail push ingestion, classification, RFQ fan-out to vendors,
reply linking, and an AI agent that drafts (never sends) replies.

Public repository: no real mail, vendor or customer data is ever committed; fixtures are synthetic.

## Layout

| Path                | What                                                                                 |
| ------------------- | ------------------------------------------------------------------------------------ |
| `packages/*`        | Shared libraries (`core` lands first)                                                |
| `apps/api`          | Express API (Railway): `createAppInstance({ config })` + `index.ts` composition root |
| `apps/frontend`     | React/Vite mailbox frontend (local development first)                                |
| `packages/contract` | Browser-safe API schemas shared with the frontend                                    |
| `apps/*`            | Other deployables: Lambda handlers                                                   |
| `infra`             | CDK                                                                                  |

## Getting started

```sh
npm install
npm run lint && npm run typecheck && npm test && npm run build
npm run dev -w @lc/api      # http://localhost:8080/health, reads ../../.env
```

`packages/core`'s `typecheck` emits `dist/` on purpose: `apps/*` type-check and test against
`@lc/core`'s built declarations, so core must be built before anything that imports it.

## `packages/core` layout

```
src/
  config.ts        loadConfig(env): zod-validated Config. Pure; called once per process
  connectors/      talks to the outside world and owns credentials: gmail/ (client, token refresh, GmailSender),
                   google-pubsub/ (push OIDC check), openai/ (LLM client, prompts)
  db/              Prisma client and generated types
  domain/          business rules with no I/O: rfq, sent-mail state machine, reply linking
  telemetry/       runInsideSpan(): a business-named parent span around each outbound call
  utils/           pure functions with fixture tests, no network: mime/ (parse, quoted-text stripping), crypto/
```

`connectors` and `utils` never import each other; `domain` imports neither. Apps compose the three.

File names are camelCase and match their main export (`runInsideSpan.ts`, `createAppInstance.ts`);
tests sit next to the code as `<name>.test.ts`. Tool-owned names (`package-lock.json`, workflows,
Prisma migrations) keep their own conventions.

### Composition rules

- **Singletons by construction, not by module state.** Each process has one composition root
  (`apps/api/src/index.ts`, each Lambda's module scope). It calls `loadConfig(process.env)` once,
  builds one Prisma client and the connectors, and passes them down as arguments. No module in
  `packages/core` reads `process.env` or keeps a module-level instance.
- **Two deliberate process-wide globals.** OpenTelemetry registers one global tracer/meter
  provider per process before application code loads; `packages/core` depends only on
  `@opentelemetry/api` and reaches that global through `runInsideSpan()` or `trace.getTracer()`.

## Telemetry

OpenTelemetry end to end, exported over OTLP/HTTP to **Grafana Cloud** (spans to Tempo, metrics to
Mimir). Same two env vars everywhere: `OTEL_EXPORTER_OTLP_ENDPOINT` and `OTEL_EXPORTER_OTLP_HEADERS`
(basic auth, instance id + token). Unset locally, nothing is exported and `runInsideSpan()` is a no-op.
Our stack is `bouncypillow586` in `prod-ap-south-1`. `=` padding in the base64 header must be written
`%3D` (see `.env.example`).

|                  | API (Railway)                                                                                                                           | Lambdas                                                                |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| SDK start        | `apps/api/src/instrumentation.ts` (`sdk-node`), loaded with `node --import` **before** `index.js`                                       | OTel Lambda layer + `AWS_LAMBDA_EXEC_WRAPPER=/opt/otel-handler`        |
| Instrumentations | listed in `instrumentation.ts`: http, undici, express, pg                                                                               | `OTEL_NODE_ENABLED_INSTRUMENTATIONS=aws-lambda,aws-sdk,http,undici,pg` |
| Flush            | `sdk.shutdown()` on SIGTERM                                                                                                             | layer, at the end of every invocation                                  |
| ESM              | `instrumentation.ts` registers `@opentelemetry/instrumentation/hook.mjs`; without it only `http` is patched and `http.route` is missing | bundled CJS, no hook needed                                            |
| Bundling         | n/a                                                                                                                                     | `nodeModules: ['googleapis','openai','pg']` so they stay patchable     |

Rules:

- **Auto-instrumentation records the wire.** Inbound requests carry `http.route`; outbound calls
  carry `server.address` (`gmail.googleapis.com`, `api.openai.com`). No code needed.
- **`runInsideSpan()` records the business operation** around each outbound call so the wire span has a
  parent that says what it was for: `openai.classify` vs `openai.extract`, `gmail.send` vs
  `gmail.messages.get`. Convention `<system>.<operation>`, lowercase, dots; each connector defines
  its own names as constants next to its code. Keep span attributes few: every key is a filter in
  Grafana.
- **No custom request metrics.** Average and p95 time per route come from the auto-emitted
  `http.server.request.duration` histogram (and from request span durations in Tempo). Do not add a
  metrics middleware.
- **Manual tracer/meter only for the agent**: `agent.run` with one `agent.tool` child per tool call,
  acquired via `trace.getTracer(CORE_INSTRUMENTATION_SCOPE)` / `metrics.getMeter(CORE_INSTRUMENTATION_SCOPE)`.
- Nothing is emitted per mailbox, vendor or model as a metric label; those are span attributes only.
- Infra metrics AWS produces itself (SQS depth, DLQ, Lambda errors) stay as CloudWatch alarms in the
  CDK stack.

## Tenants, mailboxes and auth

The identity is the **mailbox**: one Gmail inbox, one login, one person. `mailboxes.email_address`
is the only place the address lives and doubles as the login name; `mailbox_logins` holds only the
argon2id password hash. A tenant (one logistics desk) exists before its mailboxes.

| Route                                  | Who      | Does                                                               |
| -------------------------------------- | -------- | ------------------------------------------------------------------ |
| `POST /v1/tenants`                     | operator | creates a tenant -> `{ tenantId }`                                 |
| `POST /v1/tenants/:tenantId/mailboxes` | operator | creates a mailbox (Gmail connected later) + credentials; no cookie |
| `POST /v1/auth/login`                  | owner    | verifies the password, sets `lc_session`                           |
| `POST /v1/auth/logout`                 | owner    | clears the cookie                                                  |
| `GET /v1/me`                           | owner    | `{ mailboxId, tenantId }` from the session                         |

The operator routes are open for now and **must be gated by an operator token before the API is
public**. `lc_session` is an httpOnly `SameSite=Lax` (Secure outside dev) cookie holding an HS256 JWT
(`sub` = mailbox id, `tenantId`; 7 days) signed with `SESSION_SECRET`. Stateless: logout clears the
cookie, a token stays valid until expiry (add `mailbox_logins.token_version` if instant revocation is
ever needed). `requireSession` guards every session-scoped route and exposes the claims through
`getSession(response)`. Persistence goes through `TenantRepository` and `MailboxCredentialsRepository`
(`packages/core/src/{tenants,auth}`), so route tests run in memory and `index.ts` wires Prisma.

## Attachments

`emailProcessor` stores every MIME part of a message as a file: bytes go to the raw-mail bucket under
`<tenantId>/attachments/<sha256>` (content-addressed, so a rate card sent ten times is one object; per
tenant, so tenants never share or probe each other's objects) and one `attachments` row per email
records name, type, size, hash, key, `content_id` and `is_inline`. Inline means part of the body: a
`multipart/related` part or a `cid:` image the HTML references (logos, signatures). It is flagged so a
thread view can render it and a file list can hide it; `Content-Disposition: inline` alone does not
count, because some mail clients send real PDFs that way. Malformed Content-Types become
`application/octet-stream` so one odd part cannot send the whole mail to the dead-letter queue. The
email and its attachment rows are inserted in one transaction, so a duplicate delivery adds nothing.

| Route                                                                    | Does                                                                                 |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| `GET /v1/mailbox/emails/:emailId/attachments`                            | metadata, inline included; 404 unless the email is the session mailbox's             |
| `GET /v1/mailbox/emails/:emailId/attachments/:attachmentId/download-url` | `{ url, expiresAt }`: presigned S3 GET, 5 minutes, `Content-Disposition: attachment` |

The API presigns with the standard `AWS_*` credentials of the infra `RailwayApiUser` (read on the
bucket) and `RAW_MAIL_BUCKET_NAME`. Without the bucket variable, listing works and download links
answer `503 attachments_unavailable`; local dev and tests need no AWS. Attachments are not sent to
the LLM for classification (token cost); when that changes it will be a config switch, off by default.

## Classification

Every inbound mail gets a label: `general`, `customer_request` (a shipper asking for a quote, the RFQ
entry point) or `rate_card` (an unsolicited vendor price list). Labels live in `classifications`,
append-only: a correction is a new row with `source = user`, and the current label is the newest row,
so who said what is kept. `sent` mail is never classified.

Tenant rules run first and need no LLM. A `classification_rules` row says "mail from this sender is
this label": `sender_pattern` is compared case-insensitively against the sender address; a value with
an `@` must equal the whole address (`ravi@acme.com`), anything else must equal the domain after the
`@` (`acme.com`; subdomains do not match). Lowest `priority` value wins, disabled rules are kept so
`classifications.rule_id` stays meaningful. `emailProcessor` loads the tenant's enabled rules per
mail, matches on the parsed `From` address and writes the classification in the same transaction as
the email.

When no rule matches, the model decides. `emailProcessor` sends the mail (sender, subject, attachment
names, body truncated to 6000 characters) wrapped in `<email>` tags as untrusted data to OpenAI's
Responses API (`MODEL_CLASSIFY`, structured output: label, confidence, one-line reason) and stores
`source = llm` with `llm_model`, `prompt_version` (`classify-email-v1`) and `confidence`. The call
runs before the attachment uploads; a 429, 5xx, timeout or connection failure returns the SQS record
to the queue (three attempts, then the dead-letter queue), any other error stores the mail
unclassified and logs, because a broken prompt must never lose mail. Without `OPENAI_API_KEY` the
Lambda logs one warning at startup and stores unmatched mail unclassified.

`LLM_CLASSIFY_INCLUDE_ATTACHMENTS` (default `false`) decides what the model sees. Off: the mail
text only, attachments by name. On: PDF attachments go along as files and PNG/JPEG/GIF/WEBP ones as
low-detail images, at most 5 files and 8 MiB per mail; inline images (`cid:` body decoration) and
other types are still named only. The service never extracts attachment text itself. Both settings
live in the `logistics-copilot/<stage>/lambda-env` secret or the Lambda environment.

Rules are tenant-wide; until admin gating lands, any signed-in mailbox of the tenant manages them. A
tenant has at most one rule per pattern (409 `rule_exists`) and at most 200 rules (409 `too_many_rules`):

| Route                                   | Does                                                                                                   |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `GET /v1/mailbox/classification-rules`  | every rule of the session tenant, disabled included, priority ascending                                |
| `POST /v1/mailbox/classification-rules` | `{ senderPattern, label, priority? }` (priority defaults to 100); 201 with the stored, normalised rule |

## Database

Supabase Postgres via Prisma 7 (engine-less client + `@prisma/adapter-pg`). Two projects,
`logistics-copilot-staging` and `logistics-copilot-prod`, both in Mumbai (`ap-south-1`) beside the Lambdas; local development points at staging. Free-tier
direct hosts are IPv6-only, so every URL goes through the pooler: `DATABASE_URL` = transaction pooler
(6543, the only URL the app opens), `DIRECT_URL` = session pooler (5432, Prisma CLI only). Tables are
added one at a time as features need them, in `packages/core/prisma/schema.prisma`. Nothing is ever run
by hand in the Supabase SQL editor.

Migrations run automatically: `.github/workflows/migrate-staging.yml` applies pending migrations to
staging on every merge to `main` that touches `packages/core/prisma/**`, using the `DIRECT_URL` secret of
the `staging` environment. Production migrations arrive with `deploy.yml`, behind its approval gate.

```sh
npm run db:migrate -- --name add_messages   # diff schema -> prisma/migrations/<ts>_add_messages/migration.sql, apply, regenerate (uses DIRECT_URL)
npm run db:deploy                           # apply pending migrations (CI / Railway pre-deploy)
npm run db:status                           # what is pending
```

Prisma is pinned to 7.10.1 with a root `overrides` entry: npm's `latest` tag for `prisma` currently points
at an 8.0 release candidate that does not match `@prisma/client`.

## Contributing

Small PRs, one concern each. `main` is protected: every change goes through a pull request and must
pass CI; merges are squash-only. A local `pre-push` hook refuses direct pushes to `main`.

## Frontend (1.5b)

The frontend reads only `/v1` endpoints. Mail data comes from Postgres through the API, never
from Gmail or Supabase directly in the browser. Browser code imports `@lc/contract`, not
`@lc/core` (which contains Prisma and token decryption). No credentials are in a `VITE_*` variable;
`lc_session` remains httpOnly and no mail/session data is written to localStorage.

From the repository root, with Node 22 on PATH:

```sh
npm ci
npm run build
# Terminal 1: real API, local .env points to staging. No automatic migrations or seeds.
FRONTEND_URL=http://localhost:5173 npm run dev -w @lc/api
# Terminal 2: frontend proxies /v1 to localhost:8080.
npm run dev -w @lc/frontend
```

Open `http://localhost:5173` and sign in with your existing mailbox credentials. Use `localhost`
consistently for API callback and frontend so the host-only session cookie is shared. Keep the
existing registered `GOOGLE_REDIRECT_URI=http://localhost:8080/v1/mailbox/gmail/callback`.
Google returns to that API callback; `FRONTEND_URL` sends the browser back to the frontend's
success/failure screen. Do not register/change Google clients to run UI tests.

For an API on another **local** port, start Vite with
`FRONTEND_API_TARGET=http://127.0.0.1:8089 npm run dev -w @lc/frontend`. This is a server-only
Vite proxy setting, not bundled frontend configuration. `FRONTEND_URL` belongs on the API process.
Production hosting must serve SPA paths (including `/mailbox`) and proxy `/v1` or configure
same-site API hosting with a matching frontend base URL; that deployment and the admin gate are 1.7, not part of this change.

Implemented: password login/logout, All mail / Inbox / Sent, 30-row cursor pages, refresh,
empty/loading/error states, Gmail connect/reconnect, and explicit success/failure screens.
Mail rows are summaries, not clickable: message bodies, search, RFQs and classification need
later endpoints. The query string retains folder and cursor for browser back/reload. No polling
or Gmail resync is triggered by the frontend; Refresh reads already-ingested rows.
The list response includes the cookie's mailboxId and tenantId. The browser rejects a response
for a different session before caching it, including when another tab switches the account.
Failed background refreshes keep cached mail visible with an inline warning.

### Browser tests and synthetic preview

```sh
npm exec -w @lc/frontend -- playwright install chromium
npm run build # Required first: the synthetic API imports built workspace packages.
npm run test:e2e
```

Playwright starts the real Express app with in-memory repositories and fake Google on
`127.0.0.1:4181`, plus Vite on `127.0.0.1:4180`. Tests run desktop and mobile viewports,
including cookie auth, account isolation, pagination, connection callbacks, errors and axe
accessibility checks. No staging DB, Google or AWS calls. Only the Google navigation is
intercepted; callback verification and cookie auth are the real API code. Error-state tests
also intercept selected HTTP failures. CI runs this suite after build.

For an isolated visual preview using the same synthetic data:

```sh
# Terminal 1
npm run test:serve -w @lc/frontend
# Terminal 2
FRONTEND_API_TARGET=http://127.0.0.1:4181 npm run dev -w @lc/frontend -- --port 4180
```

Open `http://127.0.0.1:4180`. Synthetic accounts: `ops@example.com`, `sales@example.com`,
`new@example.com`; password `frontend-test-password`. These are in-memory fixtures, never real
accounts. Google connect needs the Playwright interception to finish in this synthetic preview.
