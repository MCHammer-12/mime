# Setup

New operator? Start with [ONBOARDING.md](ONBOARDING.md) — clone, jwt-bandit,
admin token, first migration. This page is the env-var / script reference.

## Env vars
- `KLAVIYO_API_KEY` — Klaviyo private API key (read-only is fine for extractors)
- `MERCHANT` — merchant slug used as dir name under `migrations/`

## Install
```
npm install
```

## Run an extractor
```
KLAVIYO_API_KEY=pk_... MERCHANT=<slug> npx tsx src/extract-templates.ts
KLAVIYO_API_KEY=pk_... MERCHANT=<slug> npx tsx src/extract-flows.ts
KLAVIYO_API_KEY=pk_... MERCHANT=<slug> npx tsx src/extract-campaigns.ts
MERCHANT=<slug> npx tsx src/extract-images.ts   # needs templates extracted first
```

## Visualize a flow
```
npx tsx src/visualize-flow.ts migrations/<slug>/flows/<file>.json
open migrations/<slug>/flows/<file>.html
```
