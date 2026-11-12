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

## Stored body text

`emails.body_text` is what the sender typed, not the whole message as sent. `emailProcessor` drops
the signature always and, when the mailbox already holds a message of the same Gmail thread (inbox or
sent), the quoted history too (`extractNewContent`): that history duplicates rows the thread view
shows anyway. A thread new to us (started before the mailbox was connected, a reply-all that pulls us
in) and a forward keep their quoted text, since it is the only copy we have. The classifier reads the
same text. `body_html` and the `.eml` in S3 stay complete.

## Reading mail

| Route                                              | Does                                                                                                                                                                   |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/mailbox/emails`                           | list, newest first, cursor paged, `?label=inbox\|sent`; list fields only                                                                                               |
| `GET /v1/mailbox/emails/:emailId`                  | one mail: list fields plus `ccRecipients`, `rfcMessageId`, `bodyText`, `bodyHtml`, `classification` (newest row or null)                                               |
| `GET /v1/mailbox/threads/:gmailThreadId`           | `{ gmailThreadId, emails }`: every stored message of the thread in this mailbox, inbox and sent, oldest first, same shape                                              |
| `POST /v1/mailbox/emails/:emailId/classifications` | `{ label }`: operator correction, appends a `source = user` row; 201 with the new current classification; 409 `not_inbound` for sent mail (rules under Classification) |

All four are scoped to the session's mailbox and tenant; anything outside answers 404, as does a
malformed id. The thread view is built from rows, one per message, which is why `body_text` above
drops quoted history for known threads: the history is already on screen as its own messages.

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

Every inbound mail gets a label: `general`, `customer_request` (a shipper asking the desk to quote for
or move a new shipment, the RFQ entry point), `customer_reply` (a later inbound mail in a thread that
already holds a `customer_request`) or `rate_card` (an unsolicited vendor price list). Labels live in `classifications`,
append-only: a correction is a new row with `source = user`, and the current label is the newest row,
so who said what is kept. `sent` mail is never classified.

The thread decides first. When the mailbox already holds an earlier message of the same Gmail thread
whose current label is `customer_request`, the new inbound mail is `customer_reply` with
`source = thread`, before any rule or model runs: a follow-up in a quote conversation is never a fresh
request, whatever the sender's rule says. `customer_reply` is derived only; rules cannot assign it and
the model is not offered it. Only the request counts, not an earlier derived reply, so relabelling the
request stops the chain. "Earlier" means `received_at` before the new mail's own date: Gmail can
deliver two messages of a thread out of order, and the older one must not inherit from the newer.
Known gap: two mails of one thread processed at the same moment both see a thread without a
request and are both classified on their own merits; a per-thread lock inside the insert
transaction is a follow-up.

Tenant rules run next and need no LLM. A `classification_rules` row says "mail from this sender is
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

Operators correct a label with `POST /v1/mailbox/emails/:emailId/classifications` (table under
Reading mail). Any of the four labels is allowed, including `customer_reply`: the derived-only
restriction is on rules and the model, not on people. The row is appended even when the label is
unchanged, because a confirmation is worth recording. The effect on the thread is forward only: relabelling a mail to `customer_request` makes later inbound mails in
that thread derive `customer_reply`, relabelling the request to anything else stops the chain, and
rows already written are never rewritten.

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
Mail rows open a read-only conversation using the deployed detail and thread endpoints. Messages
are shown latest first, with the latest and selected messages expanded. Each expanded message shows
sender, recipients, message body and its current classification/source (model confidence when
present). All mail and Inbox rows show the current classification or an unclassified state, read
in the list request without fetching each message separately. Files load on demand and downloads
request a fresh signed link, download through the shared transport, recheck the session and save an in-memory file. Messages have one reading view: sanitized HTML when available, plain
text otherwise. The local prototype uses `react-letter` to preserve supported sender CSS.
Remote HTTP/HTTPS images and CSS backgrounds load automatically, including tracking pixels;
opening a message can notify its sender. Scripts, forms, SVG markup and nested frames remain removed.
Responsive `srcset` images support density/width candidates, `sizes`, and picture source media/type
selection. Each candidate uses the same remote-URL/CID validation and no-referrer policy as `src`.
Invalid candidates are dropped; mixed width/density lists are discarded, retaining a safe `src` fallback.
Duplicate descriptors keep the first candidate. Height-dependent stylesheet media queries and
responsive image media/sizes are removed to keep automatic frame sizing stable.
Email-supplied relative/data/blob image URLs remain unsupported. App-created raster data URLs are
permitted only through scoped CID substitution after a bounded, successful storage download. Browser mixed-content
rules can still prevent HTTP images on HTTPS pages. CSS imports, unsupported nested rules and
viewport-height sizing are removed to prevent active resources or auto-height feedback.
HTML remains in a borderless, opaque sandboxed iframe that grows with its contents, including image
loads and viewport changes. There is no inner scrolling, reading-mode toggle or expand control.
The frame cannot access the app origin or navigate the app; explicit HTTP/HTTPS/mailto links open
separately with no opener/referrer. An exact CSP hash permits only a fixed app-owned layout helper,
not email code or event handlers. The helper reports height and image-failure counts; the parent
checks the current frame source, opaque origin and bounded numeric payload. Image origins come from
validated remote URLs or the scoped attachment signer; image requests send no referrer.
Letter renders to a string, not into the app DOM; our frame retains CSP and auto-height controls.

Inline images resolve case-sensitive CID references against that message's attachment metadata.
Only unique inline PNG/JPEG/GIF/WebP parts, up to 10 MB each and 20 per message, are loaded. Unknown,
ambiguous, unsupported or failed parts remain placeholders. A Retry images action appears only for
loading failures and reloads the frame, signing fresh CID links when needed; successful images add no reader controls.
Signed URLs are not persisted, and pending image work is cancelled when the reader closes or the
session changes. Attachment metadata now includes nullable `contentId`; deploy the API first to
resolve images. Older API responses still parse, leaving CID images unresolved. No migration or
Lambda change is required. Full HTML retains quoted history; stored plain text can omit it.
Corrections, sending, search and RFQs are not part of this UI.
The query string retains folder, cursor and selected email for browser back/reload. No polling
or Gmail resync is triggered by the frontend; Refresh reads already-ingested rows.
The list response includes the cookie's mailboxId and tenantId. The browser rejects a response
for a different session before caching it, including when another tab switches the account.
Failed background refreshes keep cached mail visible with an inline warning.
Thread reads start with a globally unique email id, then verify that the thread includes that email
before caching it; a Gmail thread id alone can occur in more than one mailbox. Thread and file reads
also verify `/me` before returning data. Queries are scoped to the current identity and cancelled on
sign-out. Signed download requests are cancelled when their message leaves the view.

### Frontend request retries and storage deadlines

All application API calls share `frontendRequest.ts`: one initial attempt and at most **two retries**
for network failures and HTTP 408, 429, 500, 502, 503 or 504. Backoff is 500 ms then 1 second.
`Retry-After` is honoured up to 5 seconds; longer waits surface the response instead of retrying early.
Cancellation, other HTTP errors, invalid JSON/schema responses and session mismatches do not retry.
React Query retries stay disabled to prevent multiplying attempts. GET/HEAD are replayable; the current
login/logout and consent-URL POSTs explicitly opt in because they do not send mail or create business
records. Future non-idempotent writes must establish replay safety before opting in.

**Only presigned S3 GETs** get new deadlines: **5 seconds to response headers** and **20 seconds for the
entire transfer**, per attempt, including the body. Browser JavaScript cannot isolate TCP/TLS setup,
so the first deadline also includes browser queuing and server response time. Up to three 20-second
attempts plus backoff may elapse. Other API calls retain their existing timeout behavior (currently
no application deadline); a request that never settles will not trigger a retry without one.

Storage GETs use CORS, omit cookies and referrers, reject redirects, and enforce the API attachment
size while streaming. Inline images are downloaded and validated, then inserted as app-created raster data URLs,
so the opaque email frame does not make another unbounded S3 transfer. Email-supplied data URLs,
SVGs and executable content remain blocked. File downloads use a short-lived object URL and keep
the metadata filename; object URLs are revoked after saving or when the component closes. No bytes
or signed URLs are persisted in browser storage. Navigation/session cancellation stops transfer and
backoff. Third-party images/styles, navigation and the browser's initial app-asset loading remain
browser-managed; they do not pass through the application API/S3 request transport.

**Rollout dependency:** deploy bucket CORS before deploying this frontend. The staging bucket rule
allows GET only from the verified staging frontend and `http://localhost:5173` / `http://127.0.0.1:5173`.
It does not grant public access: signatures and the private, TLS-only bucket policy still apply.
Production has no guessed origin or wildcard; configure its verified exact frontend origin before
rolling out the frontend there. Set the stage-specific CDK context key `frontendOrigins:production`
(or `frontendOrigins:staging`) to a comma-separated list of exact origins, or a string array in
`infra/cdk.json`. An unkeyed `frontendOrigins` is rejected. An absent production key deliberately
leaves CORS disabled. Local synthetic tests supply CORS separately and need no AWS change.

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
accounts. The ops mailbox includes “Clearance charges - Mundra import (inline image sample)”,
parsed from the synthetic MIME fixture with a CID-linked PNG logo. The test API serves that
image over loopback HTTPS on port 4184 using a short-lived local certificate, so the opaque email
frame loads actual bytes. Other synthetic attachment URLs have no storage backing. Google connect
still needs Playwright interception to finish in this synthetic preview.
