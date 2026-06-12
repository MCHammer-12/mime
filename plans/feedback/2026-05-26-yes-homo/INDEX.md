# Yes Homo feedback — 2026-05-26

Source: troubleshoot bundle `troubleshoot-Yes Homo-2026-05-08T17-52-16-796Z.zip`
Job: `73f21fc9-708c-4a74-8138-56a8fb4d8c87` (storeId `mcht/68fb98ee47171974fb361999`)
Items: 7 flows flagged (14 emails total imported)

## Tasks (Yes Homo-specific)

| # | Status | Task | Branch | PR |
|---|--------|------|--------|----|
| 1 | done | [Klaviyo phone-country-code profile-property condition not mapped](phone-country-code-condition.md) | `fix/phone-country-code-condition` | [#93](https://github.com/MCHammer-12/mime/pull/93) |

## Collapsed into other batches

| Issue | Affected flows | Owning task |
|-------|---------------|-------------|
| "No images" / "None of the flows had images" — blank templates | XDaCGH (AC, 2 blank), SJeL9t (Checkout, 2 blank + 1 ok), T2KLNN (Back In Stock, 1 blank), VxF9bP (BA, 2 blank), TKvPGD (Welcome Series, 3 blank + 1 ok) | [Castle Task 1 (CODE editor_type)](../2026-05-26-castle-sports/eg-templates-blank-emails.md) — **blocked** pending CODE-parser-fidelity batch |
| "There was no email in both flows" — Customer Thank You | RiqkPL (2 created, 0 blank — placeholder/link bug) | [GPA Task 1 (customer-thank-you-no-emails)](../2026-05-26-gay-pride-apparel/customer-thank-you-no-emails.md) — 2nd merchant hitting this pattern |

**5 of Yes Homo's 6 email flows are blocked behind Castle Task 1.** The CODE-parser-fidelity batch is now blocking 2 merchants (Castle Sports, Yes Homo), accelerating its priority. Worth highlighting when scoping that batch.

## Cross-cutting notes

**GPA Task 1 is now 2-merchant (GPA + Yes Homo).** Customer Thank You / order-acknowledgment style flows hit a placeholder/link bug where templates are created (createdTemplateCount > 0) but the flow shows no email. Worth updating GPA Task 1's notes section when an executor picks it up.

**Klaviyo API key provided by Michael** (`pk_Yt3pY2_...`). Don't write into files/commits.

**Yes Homo contact info:**
- storeId: `mcht/68fb98ee47171974fb361999`

**Flow IDs:**
- XDaCGH — Abandoned Cart (blocked, Castle Task 1)
- SJeL9t — Abandoned Checkout (blocked, Castle Task 1)
- T2KLNN — Back In Stock Flow - Standard (blocked, Castle Task 1)
- VxF9bP — Browse Abandonment - Standard (blocked, Castle Task 1)
- RiqkPL — Customer Thank You - New vs. Returning (collapsed to GPA Task 1)
- TKvPGD — Email Welcome Series with Discount (blocked, Castle Task 1)
- XpzmZx — SMS Welcome Series Customer vs Non-Customer (Task 1 here)
