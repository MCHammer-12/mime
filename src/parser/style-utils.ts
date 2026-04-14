/**
 * Utilities for parsing inline CSS styles from Klaviyo HTML elements.
 */

import { Padding } from "../renderer/types.js";

export function parseInlineStyles(
  style: string | undefined,
): Record<string, string> {
  if (!style) return {};
  const result: Record<string, string> = {};
  for (const part of style.split(";")) {
    const colon = part.indexOf(":");
    if (colon === -1) continue;
    const key = part.slice(0, colon).trim().toLowerCase();
    const value = part.slice(colon + 1).trim();
    if (key) result[key] = value;
  }
  return result;
}

export function parsePadding(style: Record<string, string>): Padding {
  let top = 0,
    right = 0,
    bottom = 0,
    left = 0;

  if (style["padding"]) {
    const parts = style["padding"]
      .replace(/px/g, "")
      .trim()
      .split(/\s+/)
      .map(Number);
    if (parts.length === 1) {
      top = right = bottom = left = parts[0]!;
    } else if (parts.length === 2) {
      top = bottom = parts[0]!;
      right = left = parts[1]!;
    } else if (parts.length === 3) {
      top = parts[0]!;
      right = left = parts[1]!;
      bottom = parts[2]!;
    } else {
      top = parts[0]!;
      right = parts[1]!;
      bottom = parts[2]!;
      left = parts[3]!;
    }
  }

  const pt = parsePx(style["padding-top"]);
  const pr = parsePx(style["padding-right"]);
  const pb = parsePx(style["padding-bottom"]);
  const pl = parsePx(style["padding-left"]);
  if (pt !== undefined) top = pt;
  if (pr !== undefined) right = pr;
  if (pb !== undefined) bottom = pb;
  if (pl !== undefined) left = pl;

  return { top, right, bottom, left };
}

export function parsePx(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const num = parseFloat(value);
  return isNaN(num) ? undefined : num;
}

export function parseColor(value: string | undefined): string {
  if (!value) return "#000000";
  return value.trim();
}

export function parseFontFamily(value: string | undefined): string {
  if (!value) return "Arial";
  return value.replace(/['"]/g, "").split(",")[0].trim();
}

export function parseFontSize(value: string | undefined): number {
  return parsePx(value) ?? 14;
}

export function parseBorderTop(
  style: string | undefined,
): { width: number; color: string } | null {
  if (!style) return null;
  const styles = parseInlineStyles(style);
  const bt = styles["border-top"];
  if (!bt) return null;
  // "solid 4px #3d3935"
  const match = bt.match(
    /(?:solid|dashed|dotted)?\s*(\d+(?:\.\d+)?)\s*px\s*(#[0-9a-fA-F]{3,8}|\w+)/,
  );
  if (!match) return null;
  return { width: parseFloat(match[1]), color: match[2] };
}

const SOCIAL_PATTERNS: [RegExp, string][] = [
  [/facebook\.com/i, "facebook"],
  [/instagram\.com/i, "instagram"],
  [/twitter\.com/i, "twitter"],
  [/x\.com/i, "x"],
  [/youtube\.com/i, "youtube"],
  [/tiktok\.com/i, "tiktok"],
  [/linkedin\.com/i, "linkedin"],
  [/pinterest\.com/i, "pinterest"],
  [/snapchat\.com/i, "snapchat"],
  [/whatsapp\.com/i, "whatsapp"],
  [/telegram\.(me|org)/i, "telegram"],
  [/discord\.(gg|com)/i, "discord"],
  [/twitch\.tv/i, "twitch"],
  [/reddit\.com/i, "reddit"],
  [/threads\.net/i, "threads"],
  [/bsky\.app/i, "bluesky"],
];

export function detectSocialPlatform(url: string): string | null {
  for (const [pattern, platform] of SOCIAL_PATTERNS) {
    if (pattern.test(url)) return platform;
  }
  return null;
}

export function detectSocialIconColor(imgSrc: string): string {
  if (imgSrc.includes("/subtle/")) return "gray";
  if (imgSrc.includes("/solid/")) return "black";
  if (imgSrc.includes("/white/")) return "white";
  return "original";
}
