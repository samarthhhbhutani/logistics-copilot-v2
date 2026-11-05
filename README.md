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
  metrics/         telemetry facade (next PR)
  utils/           pure functions with fixture tests, no network: mime/ (parse, quoted-text stripping), crypto/
```

`connectors` and `utils` never import each other; `domain` imports neither. Apps compose the three.

### Composition rules

- **Singletons by construction, not by module state.** Each process has one composition root
  (`apps/api/src/index.ts`, each Lambda's module scope). It calls `loadConfig(process.env)` once,
  builds one Prisma client and the connectors, and passes them down as arguments. No module in
  `packages/core` reads `process.env` or keeps a module-level instance.

## Contributing

Small PRs, one concern each. `main` is protected: every change goes through a pull request and must
pass CI; merges are squash-only. A local `pre-push` hook refuses direct pushes to `main`.
