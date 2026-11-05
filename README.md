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

## Contributing

Small PRs, one concern each. `main` is protected: every change goes through a pull request and must
pass CI; merges are squash-only. A local `pre-push` hook refuses direct pushes to `main`.
