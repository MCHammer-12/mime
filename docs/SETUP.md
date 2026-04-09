# Setup

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

## Open questions
- Redo repo access — `MCHammer-12` account is not a member of `redoapp` org. Need correct work GitHub account.
- Redo email forwarder location — likely `redo/merchant/marketing/server/` based on bazel error paths, but not confirmed.
