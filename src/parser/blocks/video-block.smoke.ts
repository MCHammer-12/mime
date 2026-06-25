/**
 * Smoke test for the kl-video → Image block conversion in klaviyo-specific.ts.
 *
 *   - A Klaviyo video block (thumbnail <img> inside <a class="kl-img-link">)
 *     becomes a Redo Image block: thumbnail src → imageUrl, video href →
 *     clickthroughUrl. The external video URL passes through untouched and the
 *     block is NOT added to skippedBlocks.
 *   - A degraded-mapping warning is recorded (static thumbnail, no play UI).
 *   - A kl-video with no thumbnail img falls back to the old skip behavior.
 *
 *   npx tsx src/parser/blocks/video-block.smoke.ts
 */
import * as cheerio from "cheerio";
import { tryParseKlaviyoSpecific } from "./klaviyo-specific.js";
import { EmailBlockType } from "../../renderer/types.js";
import type { $, El } from "../helpers.js";
import type { ParseContext } from "../index.js";

function emptyCtx(storeUrl: string | null = null): ParseContext {
  return {
    warnings: [],
    unsupportedFeatures: [],
    reviewItems: [],
    skippedBlocks: [],
    storeUrl,
  };
}

function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
}

// Minimal component-wrapper holding a kl-video block, mirroring the real
// Klaviyo structure (kl-video td → table → kl-img-base-auto-width td →
// a.kl-img-link → img).
function videoWrapper(opts: {
  href?: string;
  src?: string;
}): { $: $; $wrapper: cheerio.Cheerio<El> } {
  const link =
    opts.href === undefined
      ? ""
      : `<a class="kl-img-link" href="${opts.href}" style="display:block">`;
  const linkClose = opts.href === undefined ? "" : "</a>";
  const img =
    opts.src === undefined
      ? ""
      : `<img alt="AutoBoat In Action" src="${opts.src}" width="600"/>`;
  const html = `
    <div class="mj-column-per-100 component-wrapper" style="font-size:0px;">
      <table><tbody><tr>
        <td align="center" class="kl-video" style="font-size:0px;word-break:break-word;">
          <table><tbody><tr>
            <td class="kl-img-base-auto-width" style="padding:0px;width:600px;" valign="top">
              ${link}${img}${linkClose}
            </td>
          </tr></tbody></table>
        </td>
      </tr></tbody></table>
    </div>
  `;
  const $ = cheerio.load(html);
  const $wrapper = $(".component-wrapper").first();
  return { $, $wrapper };
}

// ─── Happy path: thumbnail + link → Image block ───────────────────────────
{
  const ctx = emptyCtx("https://autoboat.com");
  const { $, $wrapper } = videoWrapper({
    href: "https://youtu.be/dpJBQQ9fIi0?si=rhb8x2-p7RT9Sm6Y",
    src: "https://cdn.example.com/thumb.png",
  });
  const out = tryParseKlaviyoSpecific($, $wrapper, ctx, "#ffffff");

  assert(out !== null, "video block is matched (non-null return)");
  assert(out!.length === 1, `one block emitted, got ${out!.length}`);

  const block = out![0]!;
  assert(
    block.type === EmailBlockType.IMAGE,
    `emitted block is an Image, got ${block.type}`,
  );
  const img = block as { imageUrl: string; clickthroughUrl?: string };
  assert(
    img.imageUrl === "https://cdn.example.com/thumb.png",
    `imageUrl = thumbnail src, got ${img.imageUrl}`,
  );
  assert(
    img.clickthroughUrl === "https://youtu.be/dpJBQQ9fIi0?si=rhb8x2-p7RT9Sm6Y",
    `clickthroughUrl = video URL (untouched), got ${img.clickthroughUrl}`,
  );

  assert(
    ctx.skippedBlocks.length === 0,
    `video NOT skipped, got ${ctx.skippedBlocks.length} skipped`,
  );
  assert(
    ctx.warnings.some((w) => /video/i.test(w)),
    "degraded-mapping warning recorded",
  );
  assert(
    ctx.reviewItems.length === 0,
    `external video URL: no reviewItem, got ${ctx.reviewItems.length}`,
  );
}

// ─── Fallback: video with no thumbnail img → still skipped ─────────────────
{
  const ctx = emptyCtx("https://autoboat.com");
  const { $, $wrapper } = videoWrapper({ href: "https://youtu.be/abc" }); // no src
  const out = tryParseKlaviyoSpecific($, $wrapper, ctx, "#ffffff");

  assert(out !== null && out.length === 0, "no-thumbnail video emits nothing");
  assert(
    ctx.skippedBlocks.length === 1 &&
      ctx.skippedBlocks[0]!.blockType === "video",
    "no-thumbnail video falls back to skip",
  );
}

// ─── Fallback: thumbnail but no link → still skipped ───────────────────────
{
  const ctx = emptyCtx("https://autoboat.com");
  const { $, $wrapper } = videoWrapper({ src: "https://cdn.example.com/thumb.png" }); // no href
  const out = tryParseKlaviyoSpecific($, $wrapper, ctx, "#ffffff");

  assert(out !== null && out.length === 0, "no-link video emits nothing");
  assert(
    ctx.skippedBlocks.length === 1 &&
      ctx.skippedBlocks[0]!.blockType === "video",
    "no-link video falls back to skip",
  );
}

console.log("video-block.smoke.ts: all assertions passed");
