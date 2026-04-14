/**
 * Element-isolation viewer.
 *
 * Parses Klaviyo templates, filters to blocks of a specific type,
 * and opens a viewer showing only the Redo-rendered versions.
 * Compare against the real Klaviyo app to spot discrepancies.
 *
 * Usage:
 *   npx tsx src/element-viewer.ts <block-type> <template.html> [template2.html] [template3.html]
 *
 * Block types: text, image, button, line, spacer, header, menu, socials, column, discount, product
 */

import { writeFileSync, readFileSync, mkdirSync } from "fs";
import { execSync } from "child_process";
import { join, basename } from "path";
import { parseKlaviyoHtml } from "./parser/index.js";
import { renderSections } from "./renderer/index.js";
import { EmailBlockType } from "./renderer/types.js";

const args = process.argv.slice(2);

if (args.length < 2) {
  console.error(
    "Usage: npx tsx src/element-viewer.ts <block-type> <template.html> [template2.html] ...",
  );
  console.error(
    "\nBlock types: text, image, button, line, spacer, header, menu, socials, column, discount, product",
  );
  process.exit(1);
}

const blockType = args[0];
const templatePaths = args.slice(1);

const outDir = join(import.meta.dirname, "..", ".viewer");
mkdirSync(outDir, { recursive: true });

const typeMap: Record<string, string> = {
  text: EmailBlockType.TEXT,
  image: EmailBlockType.IMAGE,
  button: EmailBlockType.BUTTON,
  line: EmailBlockType.LINE,
  spacer: EmailBlockType.SPACER,
  header: EmailBlockType.HEADER,
  menu: EmailBlockType.MENU,
  socials: EmailBlockType.SOCIALS,
  column: EmailBlockType.COLUMN,
  discount: EmailBlockType.DISCOUNT,
  product: "interactive-cart",
};

const targetType = typeMap[blockType];
if (!targetType) {
  console.error(`Unknown block type: ${blockType}`);
  console.error(`Valid types: ${Object.keys(typeMap).join(", ")}`);
  process.exit(1);
}

interface RenderedBlock {
  templateName: string;
  blockIndex: number;
  redoRenderedHtml: string;
  parsedJson: string;
}

const blocks: RenderedBlock[] = [];

for (const templatePath of templatePaths) {
  const html = readFileSync(templatePath, "utf-8");
  const { sections, bodyBackgroundColor } = parseKlaviyoHtml(html);
  const name = basename(templatePath, ".html");

  const matching = sections.filter((s) => s.type === targetType);

  for (let i = 0; i < matching.length; i++) {
    const block = matching[i];
    const redoHtml = renderSections([block], { bodyBackgroundColor });

    blocks.push({
      templateName: name,
      blockIndex: i,
      redoRenderedHtml: redoHtml,
      parsedJson: JSON.stringify(block, null, 2),
    });
  }

  if (matching.length === 0) {
    console.log(`  ${name}: no ${blockType} blocks found`);
  } else {
    console.log(`  ${name}: ${matching.length} ${blockType} block(s)`);
  }
}

if (blocks.length === 0) {
  console.error(`\nNo ${blockType} blocks found in any of the provided templates.`);
  process.exit(1);
}

console.log(`\nTotal: ${blocks.length} ${blockType} block(s) across ${templatePaths.length} template(s)`);

const page = buildPage(blocks, blockType);
const outPath = join(outDir, `element-${blockType}.html`);
writeFileSync(outPath, page);
execSync(`open -a "Google Chrome" "${outPath}"`);
console.log(`Opened: ${outPath}`);

// ─── Build page ───────────────────────────────────────────────────

function buildPage(blocks: RenderedBlock[], type: string): string {
  const cards = blocks
    .map((b, i) => {
      const cardId = `card-${i}`;
      return `
      <div class="card" id="${cardId}">
        <div class="card-header">
          <span class="card-title">${escapeHtml(b.templateName)}</span>
          <span class="card-badge">${type} #${b.blockIndex + 1}</span>
          <button class="json-toggle" onclick="toggleJson('${cardId}')">Show JSON</button>
        </div>
        <div class="card-body">
          <div class="frame-wrap">
            <iframe class="block-frame" onload="resizeFrame(this)" srcdoc="${escapeAttr(b.redoRenderedHtml)}"></iframe>
          </div>
        </div>
        <div class="json-panel" style="display:none">
          <pre>${escapeHtml(b.parsedJson)}</pre>
        </div>
      </div>`;
    })
    .join("\n");

  return `<!DOCTYPE html>
<html>
<head>
  <title>Element Viewer: ${type}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; background: #0d1117; color: #e6edf3; padding: 20px; }
    h1 { font-size: 20px; margin-bottom: 4px; }
    .subtitle { font-size: 13px; color: #8b949e; margin-bottom: 20px; }
    .toolbar { display: flex; align-items: center; gap: 8px; margin-bottom: 16px; }
    .viewport-btn {
      padding: 6px 12px; border: 1px solid #30363d; background: #21262d;
      color: #8b949e; font-size: 12px; cursor: pointer; border-radius: 6px;
    }
    .viewport-btn.active { background: #388bfd; color: #fff; border-color: #388bfd; }

    .card { background: #161b22; border: 1px solid #30363d; border-radius: 8px; margin-bottom: 20px; overflow: hidden; }
    .card-header {
      display: flex; align-items: center; gap: 12px;
      padding: 12px 16px; background: #1c2128; border-bottom: 1px solid #30363d;
    }
    .card-title { font-size: 13px; font-weight: 600; font-family: 'SF Mono', monospace; }
    .card-badge { font-size: 11px; padding: 2px 8px; background: #21262d; border-radius: 10px; color: #8b949e; }
    .json-toggle {
      margin-left: auto; padding: 4px 10px; border: 1px solid #30363d;
      background: #21262d; color: #8b949e; font-size: 11px; cursor: pointer; border-radius: 4px;
    }
    .json-toggle:hover { background: #30363d; color: #e6edf3; }

    .card-body { padding: 16px; background: #0d1117; }
    .frame-wrap { max-width: 620px; margin: 0 auto; }
    .block-frame { width: 100%; border: none; display: block; background: #fff; border-radius: 4px; }
    .block-frame.mobile { max-width: 375px; }

    .json-panel { padding: 12px 16px; border-top: 1px solid #30363d; background: #1c2128; }
    .json-panel pre { font-size: 11px; color: #8b949e; font-family: 'SF Mono', monospace; white-space: pre-wrap; max-height: 400px; overflow-y: auto; }
  </style>
</head>
<body>
  <h1>Element Viewer: ${type}</h1>
  <p class="subtitle">${blocks.length} block(s) from ${new Set(blocks.map((b) => b.templateName)).size} template(s)</p>

  <div class="toolbar">
    <button class="viewport-btn active" onclick="setViewport('desktop', this)">Desktop</button>
    <button class="viewport-btn" onclick="setViewport('mobile', this)">Mobile</button>
  </div>

  ${cards}

  <script>
    function resizeFrame(iframe) {
      setTimeout(() => {
        try { iframe.style.height = iframe.contentDocument.documentElement.scrollHeight + 'px'; } catch(e) {}
      }, 150);
    }
    window.addEventListener('load', () => {
      document.querySelectorAll('.block-frame').forEach(f => resizeFrame(f));
    });

    function setViewport(mode, btn) {
      document.querySelectorAll('.viewport-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      document.querySelectorAll('.block-frame').forEach(f => {
        if (mode === 'mobile') f.classList.add('mobile');
        else f.classList.remove('mobile');
      });
    }

    function toggleJson(cardId) {
      const card = document.getElementById(cardId);
      const panel = card.querySelector('.json-panel');
      const btn = card.querySelector('.json-toggle');
      if (panel.style.display === 'none') {
        panel.style.display = 'block';
        btn.textContent = 'Hide JSON';
      } else {
        panel.style.display = 'none';
        btn.textContent = 'Show JSON';
      }
    }
  </script>
</body>
</html>`;
}

function escapeAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
