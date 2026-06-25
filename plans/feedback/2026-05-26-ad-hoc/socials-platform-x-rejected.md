---
status: unclaimed
branch: fix/socials-platform-x-rejected
pr: null
priority: URGENT — SYSTEMIC. Blanks flow emails for EVERY merchant whose templates have an X/Twitter social
---

# Social platform "x" rejected by Redo createEmailTemplate → entire template blanks

## THE ROOT CAUSE (proven 2026-06-25 with live Klaviyo key + Redo JWT)

This is the real cause of the "flow emails are blank" reports (Jack Henry +
other merchants). NOT a resolve failure, NOT the SIMPLE-editor gap, NOT #135's
orphaning. Those were all wrong/incomplete.

**mime emits `platform: "x"` for the X (Twitter) social icon. Redo's
`createEmailTemplate` schema's social-platform enum does NOT accept `"x"`.**
A single invalid enum value 400s the **entire template**, so the importer's
catch falls back to a blank ([import-rpc.ts](../../../src/migrate/import-rpc.ts)
create loop) → the email imports with no content.

### Exact error (live POST, Jack Henry template S3qazv)
```
POST /marketing-rpc/createEmailTemplate 400: Input validation:
{"sections":{"13":{"socialLinks":{"2":{"platform":{"_errors":["Received x"]}}}}}}
```

### Proof of fix
Re-ran the identical create with `platform:"x"` rewritten to `"twitter"`:
**SUCCESS** — template created (`6a3d9bdf1672b501d551f4c7`). One-value change,
nothing else touched. The 400 is solely the `x` enum value.

### Why it looked like "2 created / 6 blank" and "every merchant"
- The 6 large SYSTEM_DRAGGABLE templates all share a footer socials row with an
  X link → all 6 fail createEmailTemplate → 6 blank.
- The 2 SIMPLE (plain-text) templates have no socials block → create fine → 2
  created.
- Any merchant whose migrated templates include an X/Twitter social hits this.
  It is **systemic**, not Jack-Henry-specific (Michael confirmed other merchants
  affected).

## The fix (mime side)
Map mime's social `platform` values to **Redo's accepted enum** before emission,
mirroring how `mapIconColor` already clamps to Redo's limited color enum
([socials.ts](../../../src/parser/blocks/socials.ts)).

1. **Confirmed now:** `x` → `twitter`.
2. **Audit the rest.** mime's slug map emits: facebook, instagram, twitter, x,
   youtube, tiktok, linkedin, pinterest, snapchat, whatsapp, telegram, discord,
   twitch, reddit, threads, bluesky
   ([socials.ts:43-61](../../../src/parser/blocks/socials.ts) +
   `SOCIAL_PATTERNS` in style-utils). **Get Redo's real `SocialPlatform` enum
   from redoapp** (the EmailTemplate `socialLinks[].platform` schema) and map or
   safely drop every mime value Redo doesn't accept. `x`, `threads`, `bluesky`,
   and possibly others are likely rejected — verify against the schema, don't
   guess.
3. Apply the mapping where `socialLinks` are built in `parseSocialsBlock`
   (both the `<a href>` path ~line 103 and the icon-src fallback ~line 124), so
   the emitted template JSON only ever carries Redo-valid platforms.

## Verify
- Re-create Jack Henry S3qazv (and the other 5 SYSTEM_DRAGGABLE) → all succeed,
  full content. (Confirmed for S3qazv already.)
- A template with X/threads/bluesky socials → createEmailTemplate 200, platforms
  mapped to Redo-valid values (icon still renders).
- batch-test green; socials smoke covers x→twitter (and any other remapping).
- End-to-end: re-import a flow that was blanking → emails arrive WITH content.

## Cleanup note
The diagnosis created one stray test template in Jack Henry's Redo account:
**`6a3d9bdf1672b501d551f4c7`** — name `[mime-diag] WC | Abandoned Checkout — S3qazv`.
Safe to delete.

## Supersedes / re-scopes
- Task 8 (`flow-email-templateid-orphaned`): the Jack Henry symptom is THIS, not
  the resolve path. #135 (orphaning) + #140 (resolve-reason) + #141 (SIMPLE) are
  all still valid fixes for their own cases, but none fixed the blank emails.
- The bundle-reason gap ([bundle-missing-blank-reasons.md](bundle-missing-blank-reasons.md))
  is still real and still worth shipping — it would have surfaced this 400 in the
  bundle immediately (the create-fail reason IS recorded in `blankedTemplates`,
  just not serialized into the troubleshoot export). Had it shipped, this was a
  one-look diagnosis instead of a multi-round hunt.

## Done
(filled by executor)
