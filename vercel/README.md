# vercel/

External-facing assist surface, deployed on Vercel. Reads/writes the
same Postgres DB the Replit admin app uses, so notes and checkmarks
saved here surface in the Toby troubleshoot panel automatically.

## What's here

- `public/` — static SPA (assist UI, copied from `src/migrate/ui/`).
- `api/assist/` — 4 serverless functions (stores list, items list,
  note write, done toggle). SQL ported from
  `src/migrate/imported-items.ts`.
- `api/_lib/` — shared helpers: `auth` (token gate + ?as= reader),
  `db` (Neon serverless driver wrapper + note coercion).

## Auth

`?t=<ASSIST_TOKEN>` query param required on every request. The token
is a shared secret stored in Vercel env vars; rotate by changing the
env var. URL pattern shared with assistants:

```
https://<deploy>.vercel.app/?t=<token>&as=<assistant-name>
```

## Env vars on Vercel

- `DATABASE_URL` — Neon connection string (paste from Replit's
  DATABASE_URL secret).
- `ASSIST_TOKEN` — any unguessable string. Rotate to revoke access.

## Migrations

This deploy never runs migrations. Tables `imported_items`,
`assist_completions`, and `jobs` (with the `notes` JSONB column) are
created by the Replit app's boot-time `runMigrations()`. If a query
fails because a table is missing, the function returns 503.

## Deploy

```sh
# First time:
vercel login          # interactive — opens browser
vercel link           # link this directory to a Vercel project
vercel env add DATABASE_URL production
vercel env add ASSIST_TOKEN production
vercel --prod

# Subsequent deploys:
vercel --prod
```

## Local dev

```sh
cp .env.local.example .env.local   # fill in DATABASE_URL + ASSIST_TOKEN
vercel dev                         # starts on localhost:3000
```
