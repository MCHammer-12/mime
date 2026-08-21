/**
 * Post-parse transformation pass: substitutes Klaviyo template variables
 * with Redo equivalents, rewrites inline coupon sentences via LLM, and
 * inserts placeholder DiscountBlocks where inline coupons were.
 *
 * Runs on Section[] between parsing and export. Parser stays deterministic
 * (no API calls); all substitution + AI lives here.
 */

import type { KlaviyoAccount } from "./fetch-account.js";
import { formatAddress } from "./fetch-account.js";
import type {
  DiscountBlock,
  FooterBlock,
  Section,
  TextBlock,
} from "./renderer/types.js";
import {
  Alignment,
  EmailBlockType,
  EmailBuilderFontWeight,
  Size,
} from "./renderer/types.js";
import { nextId } from "./parser/helpers.js";
import { hasInlineCoupon, rewriteInlineCoupon } from "./ai-rewrite.js";

export interface TransformResult {
  sections: Section[];
  substitutions: string[];
  /** Data-loss warnings from transform pass (e.g. {% web_view %} dropped). */
  warnings: string[];
  aiRewrites: number;
  aiUsage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
  };
}

export interface TransformOptions {
  /** Skip AI rewrites (for dev/testing without an API key). */
  skipAi?: boolean;
  /**
   * The flow's trigger is Redo's `custom_event`. That schema exposes only
   * the customer fields plus `eventName` / `eventTimestamp` / `properties` —
   * it does NOT spread the shared email fields, so `{{ unsubscribe_link }}`
   * and `{{ view_in_browser_link }}` are rejected by createEmailTemplate
   * even though they render fine at send time. Set this so the transform
   * routes around the gap instead of shipping a template that 400s.
   */
  customEvent?: boolean;
}

export async function transformSections(
  sections: Section[],
  account: KlaviyoAccount | null,
  opts: TransformOptions = {},
): Promise<TransformResult> {
  const subs: string[] = [];
  const warnings: string[] = [];
  // When account fetch failed (bad/dummy Klaviyo key, network error) we
  // skip organization-variable substitution but STILL run coupon
  // detection and other section-level transforms — otherwise an export
  // with no key misses discount blocks entirely.
  const orgName = account?.organizationName ?? "";
  const orgAddress = account ? formatAddress(account) : "";
  const orgUrl = account?.websiteUrl ?? "";
  const usage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  };
  let aiRewrites = 0;

  // Use flatMap so one input block can emit multiple output blocks
  // (text block with inline coupon → [rewritten text, placeholder discount]).
  const out: Section[] = [];
  for (const s of sections) {
    const transformed = await transformBlock(s, {
      orgName,
      orgAddress,
      orgUrl,
      subs,
      warnings,
      skipAi: opts.skipAi === true,
      customEvent: opts.customEvent === true,
      canSwapFooter: true,
      usage,
      onRewrite: () => aiRewrites++,
    });
    out.push(...transformed);
  }

  return { sections: out, substitutions: subs, warnings, aiRewrites, aiUsage: usage };
}

interface Ctx {
  orgName: string;
  orgAddress: string;
  orgUrl: string;
  subs: string[];
  warnings: string[];
  skipAi: boolean;
  customEvent: boolean;
  /** False inside a column cell — a FooterBlock is top-level only. */
  canSwapFooter: boolean;
  usage: TransformResult["aiUsage"];
  onRewrite: () => void;
}

async function transformBlock(
  block: Section,
  ctx: Ctx,
): Promise<Section[]> {
  // Text blocks: variable substitution, then inline-coupon rewrite + discount insertion
  if (block.type === EmailBlockType.TEXT) {
    const tb = block as TextBlock;
    const substitutedText = substituteTextVars(tb.text, ctx);
    // Klaviyo's footer is a text block holding the unsubscribe sentence and
    // the postal address. Under custom_event neither can ship as-is: the
    // trigger schema doesn't expose {{ unsubscribe_link }} to the template
    // validator. Redo's FOOTER block is the native equivalent — it reads the
    // link off the schema instance (no Liquid, so nothing to validate) and
    // regenerates the address from the team record.
    if (
      ctx.customEvent &&
      ctx.canSwapFooter &&
      /\{\{\s*unsubscribe_link\s*\}\}/.test(substitutedText)
    ) {
      ctx.warnings.push(
        "replaced the Klaviyo unsubscribe/address text block with a Redo footer block (custom event trigger doesn't expose {{ unsubscribe_link }}); address now comes from the team record",
      );
      return [buildFooterFromTextBlock(tb)];
    }
    // Dropping the view-in-browser link leaves its lead-in behind
    // ("Can't see this email? "), which reads as broken copy without the
    // link it introduced. Only the lead-in is ever this short, so a text
    // block that held the link and has almost nothing else goes with it.
    if (
      ctx.customEvent &&
      hadViewInBrowserLink(tb.text) &&
      visibleTextLength(substitutedText) < 60
    ) {
      ctx.warnings.push(
        "dropped the view-in-browser text block (custom event trigger doesn't provide the link)",
      );
      return [];
    }
    // If the substitution stripped a {% web_view %} (or similar) and the
    // host text block has nothing else, drop the block entirely so we don't
    // emit an empty Text block in Redo.
    if (isEffectivelyEmpty(substitutedText)) {
      ctx.warnings.push("dropped empty text block (only contained unsupported Klaviyo tag)");
      return [];
    }
    const withSubs = { ...tb, text: substitutedText };

    if (hasInlineCoupon(withSubs.text)) {
      if (!ctx.skipAi) {
        const { text: rewritten, usage } = await rewriteInlineCoupon(
          withSubs.text,
        );
        ctx.usage.inputTokens += usage.inputTokens;
        ctx.usage.outputTokens += usage.outputTokens;
        ctx.usage.cacheReadTokens += usage.cacheReadTokens;
        ctx.usage.cacheCreationTokens += usage.cacheCreationTokens;
        ctx.onRewrite();
        const rewrittenBlock = { ...withSubs, text: rewritten };
        return [rewrittenBlock, buildDiscountFromTextBlock(rewrittenBlock)];
      }
      // AI-less fallback. Covers the common Klaviyo pattern:
      //   "USE CODE {% coupon_code 'X' %} FOR N% OFF ..."
      // which we can split deterministically into [stripped text,
      // discount block]. If the pattern doesn't match we still insert a
      // discount block after the text and leave the Jinja tag in place
      // (merchant can delete manually) — better than dropping the
      // coupon entirely.
      const stripped = ruleBasedStripInlineCoupon(withSubs.text);
      const textForRender = stripped ?? withSubs.text;
      ctx.subs.push(
        stripped
          ? "inline coupon stripped + discount block inserted (AI off)"
          : "inline coupon kept in text + discount block appended (AI off)",
      );
      const textBlock = { ...withSubs, text: textForRender };
      return [textBlock, buildDiscountFromTextBlock(textBlock)];
    }
    return [withSubs];
  }

  // Image blocks under custom_event: Klaviyo builds product-recommendation
  // and star-rating images out of `{{ product|lookup:'Image Url' }}` and
  // `{% with %}` locals, none of which the trigger provides. A liquid URL
  // that can't resolve renders as a broken image, so the block goes rather
  // than shipping empty — the merchant rebuilds it against Redo's own
  // product data.
  if (ctx.customEvent && block.type === EmailBlockType.IMAGE) {
    const img: any = { ...block };
    const urlRoots = unresolvableCustomEventRoots(String(img.imageUrl ?? ""));
    if (urlRoots.length > 0) {
      ctx.warnings.push(
        `dropped image block — its URL is built from {{ ${urlRoots.join(" }}, {{ ")} }}, which the custom event trigger doesn't provide`,
      );
      return [];
    }
    for (const field of ["altText", "clickthroughUrl"] as const) {
      if (typeof img[field] !== "string") continue;
      const roots = unresolvableCustomEventRoots(img[field]);
      if (roots.length === 0) continue;
      ctx.warnings.push(
        `cleared image ${field} — referenced {{ ${roots.join(" }}, {{ ")} }}, not provided by the custom event trigger`,
      );
      img[field] = "";
    }
    return [img];
  }

  // Button blocks: substitute {{ organization.url }} in link
  if (block.type === EmailBlockType.BUTTON) {
    const out: any = { ...block };
    if (typeof out.buttonLink === "string") {
      const newLink = substituteOrgUrl(out.buttonLink, ctx.orgUrl);
      if (newLink !== out.buttonLink) {
        ctx.subs.push(`button link: {{ organization.url }} → ${ctx.orgUrl}`);
        out.buttonLink = newLink;
      }
    }
    return [out];
  }

  // Column blocks: recurse into children. We don't insert discount blocks
  // inside columns (ColumnBlock.columns is a single slot per column, not
  // an array), so inline-coupon rewrite inside a column cell is a no-op
  // for the discount insertion. The AI rewrite still happens on the cell's
  // text but a warning is emitted.
  if (block.type === EmailBlockType.COLUMN) {
    const out: any = { ...block };
    if (Array.isArray(out.columns)) {
      const newCols: any[] = [];
      let hadContent = false;
      for (const col of out.columns) {
        if (!col) { newCols.push(null); continue; }
        hadContent = true;
        const transformed = await transformBlock(col, { ...ctx, canSwapFooter: false });
        // Column cells can't hold multiple blocks; keep the first (the rewritten
        // text) and drop any inserted discount block with a console warning.
        if (transformed.length > 1) {
          console.warn(
            "transform: inline coupon inside column cell — AI rewrote the text but discount block can't be inserted (column holds a single block per cell).",
          );
        }
        newCols.push(transformed[0] ?? null);
      }
      // Every cell dropped (Klaviyo's product-recommendation row under
      // custom_event) — the wrapper is an empty grid, not a layout.
      if (ctx.customEvent && hadContent && newCols.every((c) => c === null)) {
        ctx.warnings.push(
          "dropped a column block whose cells were all unresolvable under the custom event trigger",
        );
        return [];
      }
      out.columns = newCols;
    }
    return [out];
  }

  return [block];
}

// ─── Rule-based inline-coupon stripper (no AI) ───────────────────
//
// Handles the most common Klaviyo inline-coupon pattern:
//   "USE CODE {% coupon_code 'WELCOME15' %} FOR 15% OFF FIRST ORDER"
// Split into:
//   - standalone DiscountBlock (carries the code + discount visually)
//   - remaining text (everything that wasn't part of the coupon phrase)
//
// Returns the text with the coupon phrase removed, or null if the
// pattern didn't match cleanly. Aggressive HTML-aware regex handles
// wrapping <span>s that Klaviyo commonly inserts.

const INLINE_COUPON_PHRASE_RE =
  /(?:USE\s+(?:CODE|PROMO\s+CODE|DISCOUNT\s+CODE))?\s*(?:<[^>]+>\s*)*\{%\s*coupon_code\s*'[^']*'?\s*%\}(?:\s*<[^>]+>)*\s*(?:FOR\s+)?(?:\d+%?\s*(?:OFF|DISCOUNT)[\w\s]*?)?/i;

function ruleBasedStripInlineCoupon(html: string): string | null {
  // Build a regex that matches the coupon + its surrounding Klaviyo
  // spans + neighbouring upsell phrasing. If it matches, delete that
  // entire chunk from the html.
  const match = INLINE_COUPON_PHRASE_RE.exec(html);
  if (!match) return null;
  // Collapse consecutive whitespace / empty tags the removal leaves behind.
  let result = html.replace(INLINE_COUPON_PHRASE_RE, "");
  result = result
    .replace(/(<span[^>]*>)(\s|&nbsp;)*(<\/span>)/gi, "")
    .replace(/\s{2,}/g, " ")
    .replace(/>\s+</g, "><")
    .trim();
  return result;
}

// ─── Placeholder discount block (styled from text block) ────────────

function buildDiscountFromTextBlock(tb: TextBlock): DiscountBlock {
  return {
    type: EmailBlockType.DISCOUNT,
    blockId: nextId(),
    sectionPadding: tb.sectionPadding,
    sectionColor: tb.sectionColor,
    alignment: Alignment.CENTER,
    fontFamily: tb.fontFamily,
    fontWeight: EmailBuilderFontWeight.NORMAL,
    fontSize: 32,
    textColor: tb.textColor,
    blockBackgroundColor: tb.sectionColor,
  };
}

function buildFooterFromTextBlock(tb: TextBlock): FooterBlock {
  return {
    type: EmailBlockType.FOOTER,
    blockId: nextId(),
    sectionPadding: tb.sectionPadding,
    sectionColor: tb.sectionColor,
    horizontalPadding: Size.MEDIUM,
    verticalPadding: Size.MEDIUM,
    padding: tb.sectionPadding,
    textColor: tb.textColor,
    alignment: Alignment.CENTER,
    fontSize: tb.fontSize,
    fontFamily: tb.fontFamily,
    schemaFieldName: "unsubscribeLink",
  };
}

// ─── Text variable substitution (E1) ──────────────────────────────
//
// Order of operations matters:
//   1. Drop unsupported anchored links (manage_preferences, web_view_link, …)
//      WITH adjacent " | " / " or " separators, so the cleanup pass doesn't
//      have to guess where the separator belonged.
//   2. Drop unsupported standalone block tags ({% web_view %} inside spans).
//   3. Substitute unsubscribe forms (anchor href / bare tag / 'X' arg).
//   4. Substitute organization vars (existing).
//   5. Substitute shop.name / shop_name → orgName.
//   6. Map customer/profile vars ({{ first_name }} → {{ customer_first_name }}).
//   7. Cleanup empty inline tags + stranded separators left by drops.

// Klaviyo Liquid tags Redo can't render — anchor wrapping them is removed.
// (manage_preferences and email_preference_url have no Redo equivalent.)
const DROP_ANCHOR_PATTERNS = [
  { name: "manage_preferences_link", body: "\\{%\\s*manage_preferences_link\\s*%\\}" },
  { name: "manage_preferences",      body: "\\{%\\s*manage_preferences\\b[^%]*%\\}" },
  { name: "email_preference_url",    body: "\\{\\{\\s*email_preference_url\\s*\\}\\}" },
];

// Klaviyo block tags Redo doesn't support — strip the tag standalone; if
// the host text block has nothing else, transformBlock drops the block.
const DROP_BLOCK_TAGS = [
  { name: "manage_preferences", re: /\{%\s*manage_preferences(?:\s+'[^']*')?\s*%\}/gi },
];

// "View in browser" in each of the three forms Klaviyo emits it. Normally
// these rewrite to {{ view_in_browser_link }}, but the custom_event schema
// omits the shared email fields, so under that trigger the link is dropped
// outright rather than rewritten into a variable createEmailTemplate rejects.
const VIEW_IN_BROWSER_ANCHORS = [
  { name: "web_view_link", body: "\\{%\\s*web_view_link\\s*%\\}" },
  { name: "view_in_browser_link", body: "\\{\\{\\s*view_in_browser_link\\s*\\}\\}" },
];
const VIEW_IN_BROWSER_TAGS = [
  { name: "web_view", re: /\{%\s*web_view(?:\s+'[^']*')?\s*%\}/gi },
];

// Pipe / dot / "or" separators between footer links. After dropping a
// flanking link we strip ONE adjacent separator (prefer leading) so the
// remaining footer reads cleanly.
const SEP = "(?:&nbsp;|\\s)*[|·•](?:&nbsp;|\\s)*|(?:&nbsp;|\\s)+or(?:&nbsp;|\\s)+";

// Klaviyo profile-attribute → Redo schema-instance customer field.
// Mirrors flow/variable-mapping.ts but scoped to text-block usage:
// `person.X` flow attributes + the bare `first_name` shortcut Klaviyo
// permits in templates.
const TEXT_VAR_MAP: Record<string, string> = {
  "first_name":          "customer_first_name",
  "last_name":           "customer_last_name",
  "person.first_name":   "customer_first_name",
  "person.last_name":    "customer_last_name",
  "person.email":        "customer_email",
  "person.full_name":    "customer_full_name",
  "person.phone":        "customer_phone",
  "person.phone_number": "customer_phone",
  "person.id":           "redo_customer_id",
};

// The only roots Redo's custom_event trigger schema provides
// (redo/flows/common/src/schemas/custom-events/custom-event.ts). Anything
// else in a template body is a Klaviyo-only variable: left verbatim it
// doesn't just render empty, it fails createEmailTemplate and blanks the
// whole email — same failure mode as the `person.*` case below.
const CUSTOM_EVENT_ROOTS = new Set([
  "redo_customer_id",
  "customer_email",
  "customer_phone",
  "customer_first_name",
  "customer_last_name",
  "event_name",
  "event_timestamp",
  "properties",
  "cart_context",
]);

// Klaviyo event keys whose Redo property name isn't just the snake_case of
// the Klaviyo label. Redo's Okendo webhook writes an earning transaction's
// amount to `points` (the event name already carries the direction), so the
// obvious `points_earned` would silently render empty. `First Name` is on
// the schema proper, not in the properties bag.
const EVENT_KEY_OVERRIDES: Record<string, string> = {
  "points earned": "properties.points",
  "first name": "customer_first_name",
  "last name": "customer_last_name",
  "email": "customer_email",
};

// Collect the roots in `s` that the custom_event trigger can't provide.
// Used to decide whether an image URL / alt text is salvageable.
function unresolvableCustomEventRoots(s: string): string[] {
  const found = new Set<string>();
  for (const m of s.matchAll(
    /\{\{\s*([a-zA-Z_][a-zA-Z0-9_.]*)\s*(?:\|[^}]*)?\}\}/g,
  )) {
    const root = m[1]!.split(".")[0]!;
    if (!CUSTOM_EVENT_ROOTS.has(root)) found.add(root);
  }
  return [...found];
}

// Resolve one Liquid `{{ varPath|filters }}` token against TEXT_VAR_MAP.
// Returns a replacement `token`, a replacement `literal`, or null meaning
// "not ours — leave the source verbatim". Shared by the subject/preview path
// (substituteStringVars) and the HTML-body path (mapProfileVars).
function resolveTextVar(
  varPath: string,
  filters: string,
  customEvent = false,
): { token?: string; literal?: string; note: string } | null {
  // Klaviyo's older `{{ person|lookup:"first_name" }}` dialect is the same as
  // `{{ person.first_name }}` — normalize before the map lookup. The key can
  // be any Klaviyo property label, including one with spaces
  // (`{{ event|lookup:'Coupon Code' }}`), so match anything but the quote.
  let path = varPath;
  let rest = filters;
  let lookupKey: string | null = null;
  const lookup = /^\s*\|\s*lookup\s*:\s*["']\$?([^"']+)["']/.exec(filters);
  if (lookup && (varPath === "person" || varPath === "event")) {
    lookupKey = lookup[1]!;
    path = `${varPath}.${lookupKey}`;
    rest = filters.slice(lookup[0].length).trim();
  }

  const mapped = TEXT_VAR_MAP[path];
  if (mapped) {
    return {
      token: `{{ ${mapped}${rest ? " " + rest : ""} }}`,
      note: `{{ ${varPath} }} → {{ ${mapped} }}`,
    };
  }

  // Klaviyo event properties. Redo puts the whole event payload under
  // `properties`, addressed with dot notation, so `{{ event|lookup:'Points
  // Spent' }}` becomes `{{ properties.points_spent }}`. Only meaningful
  // under the custom_event trigger — every other schema exposes its event
  // data as first-class fields instead.
  if (customEvent && lookupKey && varPath === "event") {
    const key = lookupKey.trim().toLowerCase();
    const target =
      EVENT_KEY_OVERRIDES[key] ?? `properties.${key.replace(/\W+/g, "_")}`;
    return {
      token: `{{ ${target}${rest ? " " + rest : ""} }}`,
      note: `{{ event|lookup:'${lookupKey}' }} → {{ ${target} }}`,
    };
  }

  // An unmappable `person.*` is a Klaviyo-only profile attribute with no Redo
  // equivalent. Left verbatim it takes the whole template down, not just the
  // token: createEmailTemplate rejects any token whose root isn't a schema
  // field ("Text block uses {{ person }}, which the Order tracking trigger
  // doesn't provide"), so one stray attribute blanks the entire email. Resolve
  // it to its own `default:` value — what Klaviyo itself renders for a profile
  // that doesn't have the attribute set — or to empty when there is no default.
  if (path === "person" || path.startsWith("person.")) {
    const def = /\|\s*default\s*:\s*(['"])(.*?)\1/.exec(rest);
    const literal = def ? def[2]! : "";
    return {
      literal,
      note: `{{ ${varPath} }} → ${literal ? `"${literal}"` : "(empty)"} — no Redo equivalent`,
    };
  }

  // Same reasoning one schema wider: under custom_event anything outside
  // CUSTOM_EVENT_ROOTS fails createEmailTemplate, so resolve it to its own
  // `default:` value rather than losing the entire email over one token.
  // `unsubscribe_link` is the deliberate exception — transformBlock swaps
  // its host text block for a Redo FOOTER block, and needs the token intact
  // to find it.
  if (customEvent && varPath !== "unsubscribe_link") {
    const root = path.split(".")[0]!;
    if (!CUSTOM_EVENT_ROOTS.has(root)) {
      const def = /\|\s*default\s*:\s*(['"])(.*?)\1/.exec(rest);
      const literal = def ? def[2]! : "";
      return {
        literal,
        note: `{{ ${varPath} }} → ${literal ? `"${literal}"` : "(empty)"} — not provided by the custom event trigger`,
      };
    }
  }

  return null;
}

/**
 * Variable substitution for plain-text strings (subject lines, preview text).
 * Same org / shop / customer-profile substitutions as `substituteTextVars` but
 * skips the HTML anchor wrapping (no `<a>` to drop or rewrite). Returns the
 * substituted string and pushes a description to `subs`.
 */
export function substituteStringVars(
  text: string,
  ctx: {
    orgName: string;
    orgAddress: string;
    orgUrl: string;
    customEvent?: boolean;
  },
  subs?: string[],
): string {
  let result = text;
  const note = (s: string): void => {
    if (subs) subs.push(s);
  };

  if (ctx.orgName && /\{\{\s*organization\.name\s*\}\}/.test(result)) {
    result = result.replace(/\{\{\s*organization\.name\s*\}\}/g, ctx.orgName);
    note(`{{ organization.name }} → ${ctx.orgName}`);
  }
  if (ctx.orgAddress && /\{\{\s*organization\.full_address\s*\}\}/.test(result)) {
    result = result.replace(/\{\{\s*organization\.full_address\s*\}\}/g, ctx.orgAddress);
    note(`{{ organization.full_address }} → ${ctx.orgAddress}`);
  }
  if (ctx.orgName) {
    const shopRe = /\{\{\s*shop(?:\.name|_name)\s*\}\}/g;
    if (shopRe.test(result)) {
      result = result.replace(shopRe, ctx.orgName);
      note(`{{ shop.name|shop_name }} → ${ctx.orgName}`);
    }
  }
  // Customer profile shortcuts: {{ first_name }} / {{ person.X }} → Redo
  // equivalents. Preserve any Liquid filter (`{{ first_name|default:'' }}`)
  // so Redo's runtime can apply it at send time — mirrors mapProfileVars'
  // regex below. Without the filter group, subject lines like Klaviyo's
  // Post Purchase Email 1 ("Thank you {{ first_name|default:'' }} :)")
  // ship to Redo with the literal Klaviyo variable intact, and the
  // merchant sees the raw token in their email preview.
  result = result.replace(
    /\{\{\s*([a-zA-Z_][a-zA-Z0-9_.]*)\s*(\|[^}]*)?\}\}/g,
    (full, varPath: string, filters = "") => {
      const r = resolveTextVar(varPath, filters, ctx.customEvent === true);
      if (!r) return full;
      note(r.note);
      return r.token ?? r.literal ?? "";
    },
  );
  return result;
}

function substituteTextVars(html: string, ctx: Ctx): string {
  let result = html;

  result = dropUnsupportedAnchors(result, ctx);
  result = dropUnsupportedBlockTags(result, ctx);

  // {% unsubscribe_link %} / {% web_view_link %} as href value → Redo's
  // runtime variable. Both produce a URL when rendered by Klaviyo.
  if (/href="[^"]*\{%\s*unsubscribe_link\s*%\}[^"]*"/i.test(result)) {
    result = result.replace(
      /href="\{%\s*unsubscribe_link\s*%\}"/gi,
      'href="{{ unsubscribe_link }}"',
    );
    ctx.subs.push("href={% unsubscribe_link %} → {{ unsubscribe_link }}");
  }
  if (/href="[^"]*\{%\s*web_view_link\s*%\}[^"]*"/i.test(result)) {
    result = result.replace(
      /href="\{%\s*web_view_link\s*%\}"/gi,
      'href="{{ view_in_browser_link }}"',
    );
    ctx.subs.push("href={% web_view_link %} → {{ view_in_browser_link }}");
  }

  // {% web_view %} / {% web_view 'X' %} — Klaviyo block tag that renders a
  // full <a href="...view in browser url...">{label}</a>. Redo exposes the
  // same as {{ view_in_browser_link }}.
  const webViewArg = /\{%\s*web_view\s+'([^']+)'\s*%\}/g;
  if (webViewArg.test(result)) {
    result = result.replace(
      /\{%\s*web_view\s+'([^']+)'\s*%\}/g,
      (_m, label) => `<a href="{{ view_in_browser_link }}">${label}</a>`,
    );
    ctx.subs.push("{% web_view 'X' %} → <a>X</a> (view_in_browser_link)");
  }
  if (/\{%\s*web_view\s*%\}/.test(result)) {
    result = result.replace(
      /\{%\s*web_view\s*%\}/g,
      `<a href="{{ view_in_browser_link }}">View in browser</a>`,
    );
    ctx.subs.push("{% web_view %} → {{ view_in_browser_link }}");
  }

  // {% unsubscribe 'Custom Text' %} → anchor with that text.
  // Run before the bare-form replacement so the matched arg is preserved.
  const unsubArg = /\{%\s*unsubscribe\s+'([^']+)'\s*%\}/g;
  if (unsubArg.test(result)) {
    result = result.replace(
      /\{%\s*unsubscribe\s+'([^']+)'\s*%\}/g,
      (_m, label) => `<a href="{{ unsubscribe_link }}">${label}</a>`,
    );
    ctx.subs.push("{% unsubscribe 'X' %} → <a>X</a> (unsubscribe link)");
  }

  // {% unsubscribe %} wrapped in <a>: rewrite href, keep visible text.
  const wrappedUnsub = /<a\s[^>]*>([^<]*\{%\s*unsubscribe\s*%\}[^<]*)<\/a>/gi;
  if (wrappedUnsub.test(result)) {
    result = result.replace(
      /<a\s[^>]*>([^<]*)\{%\s*unsubscribe\s*%\}([^<]*)<\/a>/gi,
      (_match, before: string, after: string) => {
        const text = (before + after).trim() || "Unsubscribe";
        return `<a href="{{ unsubscribe_link }}">${text}</a>`;
      },
    );
    ctx.subs.push("{% unsubscribe %} → {{ unsubscribe_link }}");
  }
  // {% unsubscribe %} bare: wrap in default anchor.
  if (/\{%\s*unsubscribe\s*%\}/.test(result)) {
    result = result.replace(
      /\{%\s*unsubscribe\s*%\}/g,
      `<a href="{{ unsubscribe_link }}">Unsubscribe</a>`,
    );
    ctx.subs.push("{% unsubscribe %} (bare) → {{ unsubscribe_link }}");
  }

  if (ctx.orgName && /\{\{\s*organization\.name\s*\}\}/.test(result)) {
    result = result.replace(/\{\{\s*organization\.name\s*\}\}/g, ctx.orgName);
    ctx.subs.push(`{{ organization.name }} → ${ctx.orgName}`);
  }
  if (ctx.orgAddress && /\{\{\s*organization\.full_address\s*\}\}/.test(result)) {
    result = result.replace(
      /\{\{\s*organization\.full_address\s*\}\}/g,
      ctx.orgAddress,
    );
    ctx.subs.push(`{{ organization.full_address }} → ${ctx.orgAddress}`);
  }

  result = substituteOrgUrlInHtml(result, ctx);

  // Klaviyo Shopify integration: {{ shop.name }} / {{ shop_name }} → org.
  if (ctx.orgName) {
    const shopRe = /\{\{\s*shop(?:\.name|_name)\s*\}\}/g;
    if (shopRe.test(result)) {
      result = result.replace(shopRe, ctx.orgName);
      ctx.subs.push(`{{ shop.name|shop_name }} → ${ctx.orgName}`);
    }
  }

  result = mapProfileVars(result, ctx);
  result = cleanupAfterDrops(result);
  return result;
}

function dropUnsupportedAnchors(html: string, ctx: Ctx): string {
  let result = html;
  const patterns = ctx.customEvent
    ? [...DROP_ANCHOR_PATTERNS, ...VIEW_IN_BROWSER_ANCHORS]
    : DROP_ANCHOR_PATTERNS;
  for (const { name, body } of patterns) {
    const anchor = `<a\\s[^>]*href="[^"]*${body}[^"]*"[^>]*>[^<]*</a>`;
    let count = 0;
    // Leading separator + anchor (e.g. "Unsubscribe | Update Preferences")
    result = result.replace(
      new RegExp(`(?:${SEP})(?:${anchor})`, "gi"),
      () => {
        count++;
        return "";
      },
    );
    // Anchor + trailing separator (e.g. "Update Preferences | Unsubscribe")
    result = result.replace(
      new RegExp(`(?:${anchor})(?:${SEP})`, "gi"),
      () => {
        count++;
        return "";
      },
    );
    // Orphan anchor (no surrounding separator)
    result = result.replace(new RegExp(anchor, "gi"), () => {
      count++;
      return "";
    });
    if (count > 0) {
      ctx.warnings.push(
        `removed ${count} ${name} link${count > 1 ? "s" : ""} (not supported in Redo)`,
      );
    }
  }
  return result;
}

function dropUnsupportedBlockTags(html: string, ctx: Ctx): string {
  let result = html;
  const tags = ctx.customEvent
    ? [...DROP_BLOCK_TAGS, ...VIEW_IN_BROWSER_TAGS]
    : DROP_BLOCK_TAGS;
  for (const { name, re } of tags) {
    let count = 0;
    result = result.replace(re, () => {
      count++;
      return "";
    });
    if (count > 0) {
      ctx.warnings.push(
        `removed ${count} ${name} tag${count > 1 ? "s" : ""} (not supported in Redo)`,
      );
    }
  }
  return result;
}

function mapProfileVars(html: string, ctx: Ctx): string {
  return html.replace(
    /\{\{\s*([a-zA-Z_][a-zA-Z0-9_.]*)\s*(\|[^}]*)?\}\}/g,
    (full, varPath: string, filters = "") => {
      const r = resolveTextVar(varPath, filters, ctx.customEvent);
      if (!r) return full;
      ctx.subs.push(r.note);
      return r.token ?? r.literal ?? "";
    },
  );
}

function cleanupAfterDrops(html: string): string {
  return html
    // Empty inline elements left by tag drops. Match only truly-empty /
    // plain-whitespace content (`\s*`), NOT `&nbsp;`: a dropped Klaviyo tag
    // leaves `<span></span>` / `<span> </span>`, whereas `<strong>&nbsp;</strong>`
    // inside its own block is an intentional blank-line spacer the merchant
    // authored. Stripping the latter collapsed `<div><strong>&nbsp;</strong></div>`
    // spacers to empty `<div>`s that Redo then drops, silently deleting the
    // blank lines (Tiny Boat "Stay sharp, / Tiny Boat Nation" — 3 breaks lost).
    .replace(/<span[^>]*>\s*<\/span>/gi, "")
    .replace(/<em[^>]*>\s*<\/em>/gi, "")
    .replace(/<strong[^>]*>\s*<\/strong>/gi, "")
    // Two consecutive separators (e.g. "Terms | | Unsubscribe" left after
    // dropping the middle anchor that we couldn't bind a separator to)
    .replace(/([|·•])(?:\s|&nbsp;)+([|·•])/g, "$1");
}

function isEffectivelyEmpty(html: string): boolean {
  return visibleTextLength(html) === 0;
}

function visibleTextLength(html: string): number {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, "")
    .replace(/\s+/g, "")
    .trim().length;
}

function hadViewInBrowserLink(html: string): boolean {
  return (
    /\{%\s*web_view/i.test(html) ||
    /\{%\s*web_view_link\s*%\}/i.test(html) ||
    /\{\{\s*view_in_browser_link\s*\}\}/i.test(html)
  );
}

function substituteOrgUrlInHtml(html: string, ctx: Ctx): string {
  if (!ctx.orgUrl) return html;
  const pattern = /href="(\{\{\s*organization\.url\s*\}\})"/gi;
  if (pattern.test(html)) {
    ctx.subs.push(`{{ organization.url }} (in href) → ${ctx.orgUrl}`);
    return html.replace(
      /href="\{\{\s*organization\.url\s*\}\}"/gi,
      `href="${ctx.orgUrl}"`,
    );
  }
  return html;
}

function substituteOrgUrl(url: string, orgUrl: string): string {
  return url.replace(/^\s*\{\{\s*organization\.url\s*\}\}\s*$/, orgUrl);
}
