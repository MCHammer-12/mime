import type { SocialItem, SocialsBlock } from "../../renderer/types.js";
import {
  Alignment,
  EmailBlockType,
  SocialIconColor,
  SocialPlatform,
} from "../../renderer/types.js";
import {
  detectSocialIconColor,
  detectSocialPlatform,
  findAncestorBackgroundColor,
  parseInlineStyles,
  parsePadding,
  parsePx,
  pickContrastingColor,
} from "../style-utils.js";
import { type $, type El, nextId } from "../helpers.js";
import { classifyKlaviyoUrl } from "../url-mapping.js";
import type { ParseContext } from "../index.js";
import type * as cheerio from "cheerio";

const DEFAULT_ICON_PADDING = 10;

// Klaviyo stock-icon URL → platform name. The stock-icon path is shaped
// like `…/assets/email/buttons/<variant>/<platform>_<size>.png` where
// <variant> is one of subtle / subtleinverse / white / solid / default
// / original and <platform> is the platform slug. Used as a fallback
// for socials blocks where the merchant authored the row without any
// click links (Castle Sports Funnest PE Games template Wnzrvr) — the
// icons clearly mean "this is a Twitter / Facebook / Instagram row"
// even though there's no <a href>. We emit a placeholder SocialItem
// with the right platform and an empty url so the merchant gets a
// configurable block in Redo's editor instead of a missing chunk.
const STOCK_ICON_PLATFORM_RE =
  /\/buttons\/[^/]+\/([a-z0-9_-]+?)_\d+\.(?:png|gif|svg|jpe?g)\b/i;

export function detectSocialPlatformFromIconSrc(src: string): SocialPlatform | null {
  const m = STOCK_ICON_PLATFORM_RE.exec(src);
  if (!m) return null;
  const slug = m[1]!.toLowerCase();
  // Slug → SocialPlatform enum value. Mirrors the URL-based mapping in
  // SOCIAL_PATTERNS (style-utils.ts) — keep these two in sync.
  const map: Record<string, string> = {
    facebook: "facebook",
    instagram: "instagram",
    twitter: "twitter",
    x: "x",
    youtube: "youtube",
    tiktok: "tiktok",
    linkedin: "linkedin",
    pinterest: "pinterest",
    snapchat: "snapchat",
    whatsapp: "whatsapp",
    telegram: "telegram",
    discord: "discord",
    twitch: "twitch",
    reddit: "reddit",
    threads: "threads",
    bluesky: "bluesky",
    bsky: "bluesky",
  };
  const platform = map[slug];
  return platform ? (platform as SocialPlatform) : null;
}

// Redo's createEmailTemplate schema accepts only this social-platform enum
// (redoapp redo/model/src/brand-kit.ts `SocialPlatform`). mime's SocialPlatform
// is broader — x, threads, bluesky, twitch, telegram, whatsapp, website, email
// are NOT accepted. An unaccepted value 400s the ENTIRE template ("Received x")
// and the flow importer then saves a BLANK email, so one stray icon blanks the
// whole message for every affected merchant. Map known aliases to a Redo value;
// drop the rest (with a warning) so the email still imports with its content.
const REDO_SOCIAL_PLATFORMS = new Set<string>([
  "apple", "discord", "facebook", "github", "google", "instagram", "linkedin",
  "pinterest", "reddit", "snapchat", "tiktok", "twitter", "youtube",
]);
// Platforms Redo represents under a different key. Redo renders the X logo under
// "twitter" (its icon asset is literally named social-icon-x.png).
const SOCIAL_PLATFORM_ALIASES: Record<string, SocialPlatform> = {
  x: SocialPlatform.TWITTER,
};
export function mapPlatformToRedo(
  platform: SocialPlatform | string,
): SocialPlatform | null {
  const alias = SOCIAL_PLATFORM_ALIASES[platform as string];
  if (alias) return alias;
  return REDO_SOCIAL_PLATFORMS.has(platform as string)
    ? (platform as SocialPlatform)
    : null;
}

export function parseSocialsBlock(
  $: $,
  $wrapper: cheerio.Cheerio<El>,
  ctx: ParseContext,
): SocialsBlock | null {
  const socialLinks: SocialItem[] = [];
  let detectedColor: string | null = null;
  let iconPadding: number | null = null;
  // Klaviyo emits TWO anchors per platform — the icon (<a><img></a>) and a
  // text label (<a>Facebook</a>), same URL. The icon anchor comes first, so
  // dedup by platform with first-wins to keep one item (and its icon color).
  const seenPlatforms = new Set<string>();

  $wrapper.find("a").each((i, link) => {
    const $link = $(link);
    const href = $link.attr("href") || "";
    const platform = detectSocialPlatform(href);
    if (!platform) return;
    const redoPlatform = mapPlatformToRedo(platform);
    if (!redoPlatform) {
      ctx.warnings.push(
        `Socials block: dropped "${platform}" link — Redo's email social-platform set doesn't include it, and sending it would 400 (blank) the whole template.`,
      );
      return;
    }
    if (seenPlatforms.has(redoPlatform)) return;
    seenPlatforms.add(redoPlatform);
    if (href) classifyKlaviyoUrl(href, EmailBlockType.SOCIALS, ctx);

    const $img = $link.find("img").first();
    if ($img.length > 0) {
      const c = detectSocialIconColor($img.attr("src") || "");
      if (detectedColor === null) {
        detectedColor = c;
      }
    }

    if (iconPadding === null) {
      const $parentDiv = $link.closest("div[style*='inline-block']");
      const parentStyle = parseInlineStyles($parentDiv.attr("style"));
      const px = parsePx(parentStyle["padding-right"]);
      if (px !== undefined) iconPadding = px;
    }

    socialLinks.push({
      id: `social-${i}`,
      platform: redoPlatform,
      url: href,
    });
  });

  // Fallback: no <a href>s yielded a platform but the wrapper has stock
  // social icons. Infer platform from each img src and emit a placeholder
  // SocialItem with empty url. The merchant fills in URLs in the Redo
  // editor. Without this, a socials row with bare <img>s gets dropped
  // entirely.
  if (socialLinks.length === 0) {
    let dropped = 0;
    $wrapper.find("img").each((i, img) => {
      const src = $(img).attr("src") || "";
      const platform = detectSocialPlatformFromIconSrc(src);
      if (!platform) return;
      const redoPlatform = mapPlatformToRedo(platform);
      if (!redoPlatform) {
        ctx.warnings.push(
          `Socials block: dropped "${platform}" icon — not in Redo's email social-platform set (would 400 the template).`,
        );
        return;
      }
      if (detectedColor === null) {
        detectedColor = detectSocialIconColor(src);
      }
      socialLinks.push({ id: `social-${i}`, platform: redoPlatform, url: "" });
      dropped++;
    });
    if (dropped > 0) {
      ctx.warnings.push(
        `Socials block: ${dropped} icon(s) detected by image src but had no <a href> link in the Klaviyo source — emitted with empty URLs for the merchant to fill in.`,
      );
    }
  }

  if (socialLinks.length === 0) return null;

  const $td = $wrapper.find("td").first();
  const tdStyle = parseInlineStyles($td.attr("style"));
  const sectionColor =
    tdStyle["background-color"] ||
    findAncestorBackgroundColor($td.length ? $td : $wrapper) ||
    "#ffffff";

  const $alignDiv = $wrapper.find("div[style*='text-align']").first();
  const alignStyle = parseInlineStyles($alignDiv.attr("style"));
  const alignment = mapTextAlign(alignStyle["text-align"]);

  // Custom-uploaded icons have URLs that don't encode the variant color
  // (Klaviyo only encodes color in its stock /white/, /subtle/, /solid/
  // paths). For those, "original" is a guess that lands wrong on dark
  // backgrounds. Pick black/white based on section bg luminance instead.
  const iconColor =
    detectedColor === "original"
      ? pickContrastingColor(sectionColor, { dark: "black", light: "white" }) === "white"
        ? "white"
        : "black"
      : detectedColor;

  return {
    type: EmailBlockType.SOCIALS,
    blockId: nextId(),
    sectionPadding: parsePadding(tdStyle),
    sectionColor,
    socialLinks,
    iconColor: mapIconColor(iconColor),
    iconPadding: iconPadding ?? DEFAULT_ICON_PADDING,
    alignment,
  };
}

function mapIconColor(raw: string | null): SocialIconColor {
  // Prod SocialIconColor enum is black/white/gray only. Klaviyo /default/
  // colorful brand icons ("original") get mapped to BLACK since it's the
  // closest valid prod value for a solid-styled icon set.
  switch (raw) {
    case "white":
      return SocialIconColor.WHITE;
    case "gray":
      return SocialIconColor.GRAY;
    default:
      return SocialIconColor.BLACK;
  }
}

function mapTextAlign(value: string | undefined): Alignment {
  const v = (value || "").trim().toLowerCase();
  if (v === "left") return Alignment.LEFT;
  if (v === "right") return Alignment.RIGHT;
  return Alignment.CENTER;
}
