/**
 * Shared helpers for parser block modules.
 */

import * as cheerio from "cheerio";

export type $ = cheerio.CheerioAPI;
export type El = cheerio.Element;

let blockCounter = 0;
export function resetBlockCounter(): void {
  blockCounter = 0;
}
export function nextId(): string {
  return `block-${++blockCounter}`;
}

/** Select by class, matching both kl- and gxp-kl- variants */
export function sel(base: string): string {
  return `.${base}, .gxp-${base}`;
}

export function hasClass($el: cheerio.Cheerio<El>, base: string): boolean {
  return $el.hasClass(base) || $el.hasClass(`gxp-${base}`);
}

export function findCls(
  $parent: cheerio.Cheerio<El>,
  base: string,
): cheerio.Cheerio<El> {
  return $parent.find(sel(base));
}

export function wrapInParagraphs(html: string): string {
  if (html.includes("<p")) return html;
  return `<p>${html}</p>`;
}
