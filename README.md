# Logistics Copilot v2

Mailbox copilot for a logistics desk: Gmail push ingestion, classification, RFQ fan-out to vendors,
reply linking, and an AI agent that drafts (never sends) replies.

Public repository: no real mail, vendor or customer data is ever committed; fixtures are synthetic.

## Layout

| Path         | What                                                |
| ------------ | --------------------------------------------------- |
| `packages/*` | Shared libraries (`core` lands first)               |
| `apps/*`     | Deployables: Express API (Railway), Lambda handlers |
| `infra`      | CDK                                                 |

## Getting started

```sh
npm install
npm run lint && npm run typecheck && npm test && npm run build
```

## `packages/core` layout

```
src/
  config.ts        loadConfig(env): zod-validated Config. Pure; called once per process
  connectors/      talks to the outside world and owns credentials: gmail/ (client, token refresh, GmailSender),
                   google-pubsub/ (push OIDC check), openai/ (LLM client, prompts)
  db/              Prisma client and generated types
  domain/          business rules with no I/O: rfq, sent-mail state machine, reply linking
  telemetry/       withSpan() and the span-name constants for Gmail, OpenAI and the agent
  utils/           pure functions with fixture tests, no network: mime/ (parse, quoted-text stripping), crypto/
```

`connectors` and `utils` never import each other; `domain` imports neither. Apps compose the three.

### Composition rules

- **Singletons by construction, not by module state.** Each process has one composition root
  (`apps/api/src/index.ts`, each Lambda's module scope). It calls `loadConfig(process.env)` once,
  builds one Prisma client and the connectors, and passes them down as arguments. No module in
  `packages/core` reads `process.env` or keeps a module-level instance.
- **Telemetry is the exception, by design.** OpenTelemetry registers one global tracer/meter
  provider per process before application code loads; `packages/core` depends only on
  `@opentelemetry/api` and reaches that global through `withSpan()` or `trace.getTracer()`.

## Telemetry

OpenTelemetry end to end, exported over OTLP/HTTP to **Grafana Cloud** (spans to Tempo, metrics to
Mimir). Same two env vars everywhere: `OTEL_EXPORTER_OTLP_ENDPOINT` and `OTEL_EXPORTER_OTLP_HEADERS`
(basic auth, instance id + token). Unset locally, nothing is exported and `withSpan()` is a no-op.

|                  | API (Railway)                                                                                     | Lambdas                                                                |
| ---------------- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| SDK start        | `apps/api/src/instrumentation.ts` (`sdk-node`), loaded with `node --import` **before** `index.js` | OTel Lambda layer + `AWS_LAMBDA_EXEC_WRAPPER=/opt/otel-handler`        |
| Instrumentations | listed in `instrumentation.ts`: http, undici, express, pg                                         | `OTEL_NODE_ENABLED_INSTRUMENTATIONS=aws-lambda,aws-sdk,http,undici,pg` |
| Flush            | `sdk.shutdown()` on SIGTERM                                                                       | layer, at the end of every invocation                                  |
| Bundling         | n/a                                                                                               | `nodeModules: ['googleapis','openai','pg']` so they stay patchable     |

Rules:

- **Auto-instrumentation records the wire.** Inbound requests carry `http.route`; outbound calls
  carry `server.address` (`gmail.googleapis.com`, `api.openai.com`). No code needed.
- **`withSpan()` records the business operation** around each outbound call so the wire span has a
  parent that says what it was for: `openai.classify` vs `openai.extract`, `gmail.send` vs
  `gmail.messages.get`. Names live in `telemetry/span-names.ts` (`GMAIL_SPAN`, `OPENAI_SPAN`,
  `AGENT_SPAN`); add there first, then use in the connector. Attribute keys in `SPAN_ATTR`; keep the
  list short, every key is a filter in Grafana.
- **No custom request metrics.** Average and p95 time per route come from the auto-emitted
  `http.server.request.duration` histogram (and from request span durations in Tempo). Do not add a
  metrics middleware.
- **Manual tracer/meter only for the agent**: `agent.run` with one `agent.tool` child per tool call,
  acquired via `trace.getTracer(INSTRUMENTATION_SCOPE)` / `metrics.getMeter(INSTRUMENTATION_SCOPE)`.
- Nothing is emitted per mailbox, vendor or model as a metric label; those are span attributes only.
- Infra metrics AWS produces itself (SQS depth, DLQ, Lambda errors) stay as CloudWatch alarms in the
  CDK stack.

## Contributing

Small PRs, one concern each. `main` is protected: every change goes through a pull request and must
pass CI; merges are squash-only. A local `pre-push` hook refuses direct pushes to `main`.
