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
  Section,
  TextBlock,
} from "./renderer/types.js";
import {
  Alignment,
  EmailBlockType,
  EmailBuilderFontWeight,
} from "./renderer/types.js";
import { nextId } from "./parser/helpers.js";
import { hasInlineCoupon, rewriteInlineCoupon } from "./ai-rewrite.js";

export interface TransformResult {
  sections: Section[];
  substitutions: string[];
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
}

export async function transformSections(
  sections: Section[],
  account: KlaviyoAccount | null,
  opts: TransformOptions = {},
): Promise<TransformResult> {
  const subs: string[] = [];
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
      skipAi: opts.skipAi === true,
      usage,
      onRewrite: () => aiRewrites++,
    });
    out.push(...transformed);
  }

  return { sections: out, substitutions: subs, aiRewrites, aiUsage: usage };
}

interface Ctx {
  orgName: string;
  orgAddress: string;
  orgUrl: string;
  subs: string[];
  skipAi: boolean;
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
    const withSubs = { ...tb, text: substituteTextVars(tb.text, ctx) };

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
      for (const col of out.columns) {
        if (!col) { newCols.push(null); continue; }
        const transformed = await transformBlock(col, ctx);
        // Column cells can't hold multiple blocks; keep the first (the rewritten
        // text) and drop any inserted discount block with a console warning.
        if (transformed.length > 1) {
          console.warn(
            "transform: inline coupon inside column cell — AI rewrote the text but discount block can't be inserted (column holds a single block per cell).",
          );
        }
        newCols.push(transformed[0] ?? null);
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

// ─── Text variable substitution (E1) ──────────────────────────────

function substituteTextVars(html: string, ctx: Ctx): string {
  let result = html;

  // {% unsubscribe %} — two patterns:
  //   a) wrapped in <a>: <a ...>{% unsubscribe %}</a> → <a href="{{ unsubscribe_link }}">original text</a>
  //   b) bare: {% unsubscribe %} → <a href="{{ unsubscribe_link }}">Unsubscribe</a>
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
  return result;
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
