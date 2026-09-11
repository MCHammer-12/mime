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
import { ensureUnsubscribeLink, substituteStringVars, transformSections } from "./transform.js";
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

// ─── Image whose link is Klaviyo's unsubscribe tag ─────────────────────
// A footer drawn as a graphic (Jack Henry Espresso Shot): the image's href
// is `{% unsubscribe_link %}`, which Redo's LiquidJS has no tag for — the
// literal tag text shipped as the clickthrough.
const imageBase = {
  type: EmailBlockType.IMAGE,
  blockId: "img-1",
  sectionPadding: { top: 0, right: 0, bottom: 0, left: 0 },
  sectionColor: "#ffffff",
  imageUrl: "https://d3k81ch9hvuctc.cloudfront.net/company/x/images/footer.png",
  showCaption: false,
  padding: { top: 0, right: 0, bottom: 0, left: 0 },
};
{
  const res = await transformSections(
    [
      { ...imageBase, clickthroughUrl: "{% unsubscribe_link %}" } as any,
      { ...imageBase, blockId: "img-2", clickthroughUrl: "{% manage_preferences_link %}" } as any,
      { ...imageBase, blockId: "img-3", clickthroughUrl: "{% web_view_link %}" } as any,
      { ...imageBase, blockId: "img-4", clickthroughUrl: "https://example.com/shop" } as any,
    ],
    null,
    { skipAi: true },
  );
  const links = res.sections.map((b: any) => b.clickthroughUrl);
  assert(
    links[0] === "{{ unsubscribe_link }}" && links[1] === "{{ unsubscribe_link }}",
    `unsubscribe / manage-preferences image links → {{ unsubscribe_link }}, got: ${JSON.stringify(links)}`,
  );
  assert(
    links[2] === "{{ view_in_browser_link }}",
    `web_view_link image link → {{ view_in_browser_link }}, got: ${JSON.stringify(links)}`,
  );
  assert(links[3] === "https://example.com/shop", `static image link untouched, got: ${links[3]}`);
  assert(
    res.substitutions.filter((x) => x.includes("image link")).length === 3,
    `three rewrites noted, got: ${JSON.stringify(res.substitutions)}`,
  );
}

// ─── Under custom_event the rewritten link can't ship — cleared instead ──
{
  const res = await transformSections(
    [{ ...imageBase, clickthroughUrl: "{% unsubscribe_link %}" } as any],
    null,
    { skipAi: true, customEvent: true },
  );
  assert(
    (res.sections[0] as any).clickthroughUrl === "",
    `custom_event clears the unsubscribe image link, got: ${JSON.stringify((res.sections[0] as any).clickthroughUrl)}`,
  );
}

// ─── No unsubscribe anywhere → Redo's default footer block appended ─────
// Image-only Klaviyo emails (Jack Henry Win Back) rely on Klaviyo's send-time
// footer; Redo has no such thing, so the template must carry one.
{
  const warnings: string[] = [];
  const out = ensureUnsubscribeLink(
    [{ ...imageBase, sectionColor: "#111111", clickthroughUrl: "https://example.com" } as any],
    warnings,
  );
  const footer: any = out[out.length - 1];
  assert(out.length === 2 && footer.type === EmailBlockType.FOOTER, `footer appended, got: ${JSON.stringify(out.map((b: any) => b.type))}`);
  assert(
    footer.schemaFieldName === "unsubscribeLink" && footer.useTemplateAddress === false,
    `footer reads the schema's unsubscribe link, got: ${JSON.stringify(footer)}`,
  );
  assert(
    footer.sectionColor === "#111111" && footer.textColor === "#ffffff",
    `footer follows the preceding dark section, got: ${footer.sectionColor}/${footer.textColor}`,
  );
  assert(warnings.length === 1 && warnings[0]!.includes("appended Redo's default footer"), `warned, got: ${JSON.stringify(warnings)}`);
}

// ─── Any existing unsubscribe affordance suppresses the footer ──────────
{
  const text = {
    type: EmailBlockType.TEXT,
    blockId: "t-1",
    sectionPadding: { top: 0, right: 0, bottom: 0, left: 0 },
    sectionColor: "#ffffff",
    text: '<p><a href="{{ unsubscribe_link }}">Unsubscribe</a></p>',
  } as any;
  const imgUnsub = { ...imageBase, clickthroughUrl: "{{ unsubscribe_link }}" } as any;
  const inColumn = { type: EmailBlockType.COLUMN, blockId: "c-1", sectionPadding: {}, sectionColor: "#fff", columns: [null, text] } as any;
  for (const [label, sections] of [
    ["text link", [imageBase, text]],
    ["image link", [imgUnsub]],
    ["link inside a column", [inColumn]],
    ["existing footer block", [{ type: EmailBlockType.FOOTER, blockId: "f-1" }]],
    ["empty template", []],
  ] as [string, any[]][]) {
    const warnings: string[] = [];
    const out = ensureUnsubscribeLink(sections, warnings);
    assert(
      out.length === sections.length && warnings.length === 0,
      `${label}: no footer appended, got ${out.length} blocks / ${JSON.stringify(warnings)}`,
    );
  }
}

console.log("transform.smoke.ts: all assertions passed");
