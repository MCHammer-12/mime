/**
 * Smoke test for substituteStringVars (used on subject lines + preview
 * text in flow-attached templates).
 *
 *   npx tsx src/transform.smoke.ts
 *
 * Locks in the post-2026-05-26 behavior: customer-profile variable
 * substitution preserves any Liquid filter on the source variable.
 * Without filter support, Klaviyo subjects like "Thank you
 * {{ first_name|default:'' }} :)" shipped to Redo with the raw
 * template variable intact, and the merchant saw it literal in
 * their email preview (Castle Sports Post Purchase Email 1).
 *
 * Also covers the coupon-pill button conversion: a ButtonBlock whose label
 * is a {% coupon_code %} tag is Klaviyo's coupon pill, not a CTA, and must
 * become a DiscountBlock (White Elm welcome heroes shipped the raw tag as
 * button text).
 */
import { substituteStringVars, transformSections } from "./transform.js";
import { Alignment, ButtonLinkType, EmailBlockType } from "./renderer/types.js";

const orgCtx = {
  orgName: "Castle Sports",
  orgAddress: "1 Castle St, Townsville",
  orgUrl: "https://castlesports.com",
};

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
}

// ─── Bare {{ first_name }} → customer_first_name ────────────────────────
{
  const out = substituteStringVars("Hi {{ first_name }}!", orgCtx);
  assert(
    out === "Hi {{ customer_first_name }}!",
    `bare first_name rewritten, got: ${JSON.stringify(out)}`,
  );
}

// ─── {{ first_name|default:'' }} preserves filter — the Castle case ────
{
  const subs: string[] = [];
  const out = substituteStringVars(
    "Thank you {{ first_name|default:'' }} :)",
    orgCtx,
    subs,
  );
  assert(
    out.includes("customer_first_name") &&
      out.includes("|default:''") &&
      !out.includes("first_name|"),
    `filter preserved + var rewritten, got: ${JSON.stringify(out)}`,
  );
  assert(
    subs.some((s) => s.includes("first_name") && s.includes("customer_first_name")),
    `substitution noted in subs, got: ${JSON.stringify(subs)}`,
  );
}

// ─── {{ first_name|capitalize }} preserves a different filter ───────────
{
  const out = substituteStringVars("Hi {{ first_name|capitalize }}!", orgCtx);
  assert(
    out.includes("customer_first_name") && out.includes("|capitalize"),
    `non-default filter preserved, got: ${JSON.stringify(out)}`,
  );
}

// ─── {{ person.first_name }} also rewrites via dotted path ──────────────
{
  const out = substituteStringVars("Welcome, {{ person.first_name }}", orgCtx);
  assert(
    out === "Welcome, {{ customer_first_name }}",
    `person.first_name rewrites, got: ${JSON.stringify(out)}`,
  );
}

// ─── {{ person|lookup:"first_name" }} legacy dialect rewrites too ───────
{
  const out = substituteStringVars(`Welcome, {{ person|lookup:"first_name" }}`, orgCtx);
  assert(
    out === "Welcome, {{ customer_first_name }}",
    `person|lookup rewrites, got: ${JSON.stringify(out)}`,
  );
}

// ─── Unmappable person.X collapses to its default, not verbatim ─────────
// Verbatim it would 400 the whole createEmailTemplate call and blank the email.
{
  const out = substituteStringVars("Hi {{ person.organization|default:'' }}there", orgCtx);
  assert(out === "Hi there", `unmappable person.X → default, got: ${JSON.stringify(out)}`);

  const withDefault = substituteStringVars("Hi {{ person.nickname|default:'friend' }}", orgCtx);
  assert(
    withDefault === "Hi friend",
    `unmappable person.X keeps its default text, got: ${JSON.stringify(withDefault)}`,
  );
}

// ─── Unknown variable left unchanged (no map entry) ─────────────────────
{
  const out = substituteStringVars("Hi {{ unknown_var }}!", orgCtx);
  assert(
    out === "Hi {{ unknown_var }}!",
    `unknown var unchanged, got: ${JSON.stringify(out)}`,
  );
}

// ─── Unknown variable with filter also left unchanged ──────────────────
{
  const out = substituteStringVars("Hi {{ unknown_var|default:'' }}!", orgCtx);
  assert(
    out === "Hi {{ unknown_var|default:'' }}!",
    `unknown var w/ filter unchanged, got: ${JSON.stringify(out)}`,
  );
}

// ─── organization.name still substitutes (regression check) ─────────────
{
  const out = substituteStringVars("From {{ organization.name }}", orgCtx);
  assert(
    out === "From Castle Sports",
    `org.name still substitutes, got: ${JSON.stringify(out)}`,
  );
}

// ─── shop.name still substitutes (regression check) ─────────────────────
{
  const out = substituteStringVars("Visit {{ shop.name }}!", orgCtx);
  assert(
    out === "Visit Castle Sports!",
    `shop.name still substitutes, got: ${JSON.stringify(out)}`,
  );
}

// ─── Mixed: org + customer + filter, all together ──────────────────────
{
  const out = substituteStringVars(
    "Hi {{ first_name|default:'friend' }}, welcome to {{ organization.name }}",
    orgCtx,
  );
  assert(
    out.includes("customer_first_name") &&
      out.includes("|default:'friend'") &&
      out.includes("Castle Sports"),
    `mixed substitution, got: ${JSON.stringify(out)}`,
  );
}

// ─── Coupon-pill button → discount chip ────────────────────────────────
{
  const pill: any = {
    type: EmailBlockType.BUTTON,
    blockId: "pill-1",
    sectionPadding: { top: 10, right: 18, bottom: 10, left: 18 },
    sectionColor: "#F5F1EA",
    alignment: Alignment.LEFT,
    cornerRadius: 4,
    buttonText: "{% coupon_code 'WELCOME10' %}",
    padding: { top: 12, right: 24, bottom: 12, left: 24 },
    buttonLink: "https://example.com/redeem",
    fillColor: "#8A9B6E",
    strokeColor: "transparent",
    textColor: "#ffffff",
    strokeWeight: 0,
    fontFamily: "Arial",
    fontSize: 20,
    linkType: ButtonLinkType.WEB_PAGE,
  };
  const res = await transformSections([pill], null, { skipAi: true });
  assert(res.sections.length === 1, `pill → 1 block, got ${res.sections.length}`);
  const chip: any = res.sections[0];
  assert(
    chip.type === EmailBlockType.DISCOUNT,
    `pill converts to discount chip, got: ${chip.type}`,
  );
  assert(
    chip._pendingDiscount?.couponName === "WELCOME10",
    `chip carries the coupon name, got: ${JSON.stringify(chip._pendingDiscount)}`,
  );
  assert(
    chip.blockBackgroundColor === "#8A9B6E" &&
      chip.alignment === Alignment.LEFT &&
      chip.textColor === "#ffffff" &&
      chip.fontSize === 20,
    `chip inherits the pill's fill/alignment/label styling, got: ${JSON.stringify(chip)}`,
  );
  assert(
    res.substitutions.some((s) => s.includes("coupon-pill button")),
    `conversion noted in substitutions, got: ${JSON.stringify(res.substitutions)}`,
  );
}

// ─── Plain CTA button passes through untouched ─────────────────────────
{
  const cta: any = {
    type: EmailBlockType.BUTTON,
    blockId: "cta-1",
    sectionPadding: { top: 10, right: 18, bottom: 10, left: 18 },
    sectionColor: "#ffffff",
    alignment: Alignment.CENTER,
    cornerRadius: 0,
    buttonText: "SHOP NOW",
    padding: { top: 12, right: 24, bottom: 12, left: 24 },
    buttonLink: "https://example.com/collections",
    fillColor: "#000000",
    strokeColor: "transparent",
    textColor: "#ffffff",
    strokeWeight: 0,
    fontFamily: "Arial",
    fontSize: 16,
    linkType: ButtonLinkType.WEB_PAGE,
  };
  const res = await transformSections([cta], null, { skipAi: true });
  const outBtn: any = res.sections[0];
  assert(
    res.sections.length === 1 && outBtn.type === EmailBlockType.BUTTON,
    `plain CTA stays a button, got: ${JSON.stringify(res.sections.map((s) => s.type))}`,
  );
  assert(outBtn.buttonText === "SHOP NOW", `CTA label untouched, got: ${outBtn.buttonText}`);
}

// ─── org/shop tokens tolerate a Liquid filter — the Invader case ───────
// `{{ organization.name|title }}` in preview text used to slip past the
// bare-token regex and reach Redo, where createEmailTemplate rejects the
// whole template on the unknown `organization` root. One filter cost the
// entire "GD Post Purchase" flow import.
{
  const subs: string[] = [];
  const out = substituteStringVars(
    "An official welcome to the {{ organization.name|title }} Family!",
    orgCtx,
    subs,
  );
  assert(
    out === "An official welcome to the Castle Sports Family!",
    `filtered organization.name substituted, got: ${JSON.stringify(out)}`,
  );
  assert(
    !/\{\{/.test(out),
    `no Liquid token survives, got: ${JSON.stringify(out)}`,
  );
}

// ─── |upper and |lower actually apply to the literal ───────────────────
{
  const up = substituteStringVars("{{ organization.name|upper }}", orgCtx);
  assert(up === "CASTLE SPORTS", `|upper applied, got: ${JSON.stringify(up)}`);
  const lo = substituteStringVars("{{ shop.name|lower }}", orgCtx);
  assert(lo === "castle sports", `|lower applied to shop.name, got: ${JSON.stringify(lo)}`);
  const bare = substituteStringVars("{{ organization.name }}", orgCtx);
  assert(bare === "Castle Sports", `unfiltered still works, got: ${JSON.stringify(bare)}`);
  const addr = substituteStringVars("{{ organization.full_address|upper }}", orgCtx);
  assert(
    addr === "1 CASTLE ST, TOWNSVILLE",
    `filtered full_address substituted, got: ${JSON.stringify(addr)}`,
  );
}

// ─── {% unsubscribe %} as an href value — the Invader sunset case ──────
//
// Klaviyo has two idioms for the tag. Bare in text it renders a whole anchor,
// so mime wraps it in one. As an attribute value — `href="http://{% unsubscribe %}"`,
// which is what Invader Concepts' sunset series ships — it renders just the URL.
// With no rule for the second form the bare rule fired *inside* the attribute
// and injected an <a> element into the href: a dead link, garbled markup, and
// an unsubscribe check that still passed because the marker text was present.
{
  const src =
    `<a href="http://{% unsubscribe %}" style="color:#49A0E7; text-decoration:underline">` +
    `unsubscribe</a>`;
  const { sections } = await transformSections(
    [{ type: EmailBlockType.TEXT, text: src } as never],
    null,
    { skipAi: true },
  );
  const out = (sections[0] as { text: string }).text;
  assert(!out.includes("{% unsubscribe %}"), `token survives, got: ${out}`);
  assert(out.includes('href="{{ unsubscribe_link }}"'), `href not rewritten, got: ${out}`);
  assert(/>unsubscribe</.test(out), `visible text lost, got: ${out}`);
  assert(!/href="[^"]*<a\s/i.test(out), `anchor injected inside the href, got: ${out}`);
  assert((out.match(/<a\s/gi) ?? []).length === 1, `expected one anchor, got: ${out}`);
}

// ─── The bare-in-text and already-wrapped forms keep working ───────────
{
  for (const [src, want] of [
    ["<p>To stop these, {% unsubscribe %} any time.</p>", "Unsubscribe"],
    ['<a href="#" style="color:#000">{% unsubscribe %}</a>', "Unsubscribe"],
  ] as const) {
    const { sections } = await transformSections(
      [{ type: EmailBlockType.TEXT, text: src } as never],
      null,
      { skipAi: true },
    );
    const out = (sections[0] as { text: string }).text;
    assert(!out.includes("{% unsubscribe %}"), `token survives for ${src}, got: ${out}`);
    assert(
      out.includes('href="{{ unsubscribe_link }}"') && out.includes(want),
      `anchor form lost for ${src}, got: ${out}`,
    );
    assert((out.match(/<a\s/gi) ?? []).length === 1, `expected one anchor for ${src}, got: ${out}`);
  }
}

console.log("transform.smoke.ts: all assertions passed");
