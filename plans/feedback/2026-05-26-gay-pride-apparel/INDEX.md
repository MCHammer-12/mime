# Gay Pride Apparel feedback — 2026-05-26

Source: troubleshoot bundle `troubleshoot-Gay Pride Apparel-2026-05-08T17-36-37-655Z.zip`
Job: `e2223fd7-d23b-4d98-b41f-bdfa331fa90b` (storeId `mcht/68fb99110d340e99f9c2c617`)
Items: 3 flows flagged

## Tasks (GPA-specific)

| # | Status | Task | Branch | PR |
|---|--------|------|--------|----|
| 1 | unclaimed | [Customer Thank You flow has no email content](customer-thank-you-no-emails.md) | `fix/customer-thank-you-no-emails` | — |
| 2 | unclaimed | [Welcome Series Email 1 — image fonts inaccurate or missing](welcome-series-image-fonts.md) | `fix/welcome-series-image-fonts` | — |

## Collapsed into other batches

These issues are real, but the **same fix as an existing task** in another batch. Executors for those tasks should verify their fix against GPA's bundle too — no separate work needed here. Listed for traceability.

| Issue | Owning task |
|-------|-------------|
| Browse Abandonment (VMfMYa) — "Most of the images did not have a web link" | Charlie 1 Horse Task 6: [`image-clickthrough-links`](../2026-05-26-charlie-1-horse/image-clickthrough-links.md) |
| Browse Abandonment (VMfMYa) — "some product section were not added" | Charlie 1 Horse Task 7: [`browse-abandonment-dynamic-product`](../2026-05-26-charlie-1-horse/browse-abandonment-dynamic-product.md) |

When executors for those Charlie tasks pick them up, they should add GPA's source HTML to their verification set. The flow IDs they need from Klaviyo: `VMfMYa` (Browse Abandonment).

## Cross-cutting notes

**Klaviyo API key provided by Michael** for this session — executor can use it to fetch source HTML / template content directly via Klaviyo API. Don't write the key into any file or commit it; pull from operator at execution time.

**Task 2 may collapse into Blackline's font task.** [`Blackline font-rendering-inconsistent`](../2026-05-26-blackline-car-care/font-rendering-inconsistent.md) is about editor-side font rendering. GPA Task 2 is about "image that created did not have the accurate font" — same general font-handling area but possibly a different surface (image-with-text rendering, or hero image render). Executor should triage first; if it's the same root cause, merge with Blackline's task.

**GPA contact info** (substituted at parse time):
- `organization.name` → `Gay Pride Apparel`
- storeId: `mcht/68fb99110d340e99f9c2c617`

**Flow IDs and Klaviyo status:**
- VMfMYa — Browse Abandonment (Klaviyo: live)
- M2gVzK — Customer Thank You (Klaviyo: live) — Task 1
- LdZngk — Welcome Series (Klaviyo: live) — Task 2
