## What

<!-- One or two sentences. Link the design doc section if it changes behaviour. -->

## Why

## Checklist

- [ ] `npm run lint && npm run typecheck && npm test` pass locally
- [ ] New table or column: migration created with `npm run db:migrate -- --name <name>` and committed
- [ ] New step emits `Count/Error/Fault/Latency` via `step()`
- [ ] Nothing in this PR lets the agent send mail
