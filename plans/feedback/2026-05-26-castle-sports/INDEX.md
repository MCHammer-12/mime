# Castle Sports feedback — 2026-05-26

Source: troubleshoot bundle `troubleshoot-Castle Sports-2026-05-20T19-48-35-359Z.zip`
Job: `135b2702-31ad-4423-8735-11a564aec222` (storeId `mcht/6862cce0bb280e7d064dc2f7`)
Items: 6 flows flagged (40 emails total imported)

## Tasks (Castle-specific)

| # | Status | Task | Branch | PR |
|---|--------|------|--------|----|
| 1 | blocked | [`[EG]` templates produce blank emails (3 flows, ~12 emails affected)](eg-templates-blank-emails.md) | `fix/eg-templates-blank-emails` | — |
| 2 | done | [Post Purchase Email 1: subject line + preview text wrong](post-purchase-subject-preview-wrong.md) | `fix/post-purchase-subject-preview-wrong` | [#89](https://github.com/MCHammer-12/mime/pull/89) |
| 3 | blocked | [Post Purchase Email 1 images wrong + Email 2-3 links wrong](post-purchase-images-and-links-wrong.md) | `fix/post-purchase-images-and-links-wrong` | — |
| 4 | unclaimed | [Funnest PE Games email — socials block dropped](socials-block-missing.md) | `fix/socials-block-dropped` | — |

## Collapsed into other batches

| Issue | Owning task |
|-------|-------------|
| `[Banner] Froggy Ball Welcome` — "text font were not indicated" | [Charlie Task 4](../2026-05-26-charlie-1-horse/first-text-font-styling.md) (done per git log) — verify resolves Castle |
| `[EG] Post Purchase` — fonts not accurate / size + family not selected | Same as above |

**Cross-merchant font pattern now spans 5 merchants** (Charlie, Blackline, GPA, Fairechild, Castle). The next executor on Blackline / GPA Task 2 should verify their fix against all 5.

## Cross-cutting notes

**Task 1 is HIGH PRIORITY.** Castle's 3 abandonment flows are effectively non-functional (no email content). The `[EG]` prefix on all 4 affected flow names ("[EG] Browse Abandonment", "[EG] Checkout Abandonment", "[EG] Checkout Abandonment [No Discount Code]", "[EG] Post Purchase") suggests these templates came from a Klaviyo template-pack — possibly Email Generator, Klaviyo Showcase, or a third-party template marketplace. mime's parser likely fails to recognize the template family's specific markup. Note: only 3 of the 4 `[EG]` flows have the blank-template bug; `[EG] Post Purchase` has content (different downstream issues — see Tasks 2 + 3). So the format may vary within the family OR `[EG]` is just a naming convention and these are unrelated.

**No Klaviyo API key provided this session.** Executors for Tasks 1-4 will need source HTML — either from the Replit deploy's `/api/debug/resolve-template` endpoint or by asking Michael for the Castle Sports Klaviyo key.

**Webhook drops (informational, not a task).** All 3 `[EG]` abandonment flows have `skipped-step` warnings about `send-webhook to https://prod.getzaymo.com/v4/integrations/klaviyo/checkout` being dropped due to 8 unmapped tokens. This is per memory `feedback_drop_unsupported_actions` — intended behavior. Not flagged by merchant in this bundle. If multiple merchants ever flag this, surface as separate task.

**Castle contact info:**
- `organization.name`: not explicit in parse-result (no substitutions emitted)
- storeId: `mcht/6862cce0bb280e7d064dc2f7`

**Flow IDs:**
- UQBMLU — [Banner] Froggy Ball Welcome (font issue — collapsed)
- WrazNX — [EG] Browse Abandonment Flow (Task 1 — blank emails)
- Xm2TP7 — [EG] Checkout Abandonment Flow (Task 1 — blank emails)
- R9iyHp — [EG] Checkout Abandonment Flow [No Discount Code] (Task 1 — blank emails)
- UQJH6z — [EG] Post Purchase Flow (Tasks 2 + 3 — content issues, NOT blank)
- TSJv4n — Funnest PE Games opt in (Task 4 — socials missing)
