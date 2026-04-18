/**
 * Local email preview + comparison viewer.
 *
 * Usage:
 *   npx tsx src/viewer.ts <file>              — preview a single email
 *   npx tsx src/viewer.ts --compare <a> <b>   — side-by-side Klaviyo vs Redo
 *
 * Supported file types:
 *   .html  — renders directly (Klaviyo source)
 *   .json  — treats as Section[] JSON, renders through Redo pipeline
 */

import { writeFileSync, readFileSync, mkdirSync } from "fs";
import { execSync } from "child_process";
import { join } from "path";
import { renderSections } from "./renderer/index.js";
import { Section } from "./renderer/types.js";

const args = process.argv.slice(2);

if (args.length === 0) {
  console.error(
    "Usage:\n  npx tsx src/viewer.ts <file>\n  npx tsx src/viewer.ts --compare <klaviyo.html> <redo.json>",
  );
  process.exit(1);
}

const outDir = join(import.meta.dirname, "..", ".viewer");
mkdirSync(outDir, { recursive: true });

interface Resolved {
  html: string;
  /** Raw JSON source (pretty-printed) when the input was a .json file. */
  json?: string;
}

function resolveFile(filePath: string): Resolved {
  const raw = readFileSync(filePath, "utf-8");

  if (filePath.endsWith(".html")) {
    return { html: raw };
  }

  if (filePath.endsWith(".json")) {
    const parsed = JSON.parse(raw);
    const sections: Section[] = Array.isArray(parsed)
      ? parsed
      : parsed.sections;
    if (!Array.isArray(sections)) {
      throw new Error(
        `JSON file must be a Section[] array or { sections: Section[] }`,
      );
    }
    const bodyBackgroundColor = parsed.bodyBackgroundColor;
    return {
      html: renderSections(sections, { bodyBackgroundColor }),
      json: JSON.stringify(parsed, null, 2),
    };
  }

  throw new Error(`Unsupported file type: ${filePath}`);
}

function openInBrowser(htmlPath: string) {
  execSync(`open -a "Google Chrome" "${htmlPath}"`);
  console.log(`Opened: ${htmlPath}`);
}

function templateName(filePath: string): string {
  return filePath.split("/").pop()!.replace(/\.(html|json)$/, "");
}

function buildComparisonPage(
  htmlA: string,
  htmlB: string,
  labelA: string,
  labelB: string,
  jsonB?: string,
): string {
  return `<!DOCTYPE html>
<html>
<head>
  <title>Email Preview: ${labelA}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; background: #0d1117; color: #e6edf3; }

    /* Top toolbar */
    .toolbar {
      position: fixed; top: 0; left: 0; right: 0; z-index: 1000;
      display: flex; align-items: center; justify-content: space-between;
      padding: 10px 24px; background: #161b22; border-bottom: 1px solid #30363d;
    }
    .toolbar-left { display: flex; align-items: center; gap: 12px; }
    .toolbar-center { display: flex; gap: 4px; }
    .toolbar h1 { font-size: 14px; font-weight: 600; color: #e6edf3; }
    .toolbar .subtitle { font-size: 12px; color: #8b949e; font-family: 'SF Mono', monospace; }

    /* Viewport toggle buttons */
    .viewport-btn {
      padding: 6px 12px; border: 1px solid #30363d; background: #21262d;
      color: #8b949e; font-size: 12px; cursor: pointer; transition: all 0.15s;
    }
    .viewport-btn:first-child { border-radius: 6px 0 0 6px; }
    .viewport-btn:last-child { border-radius: 0 6px 6px 0; }
    .viewport-btn.active { background: #388bfd; color: #fff; border-color: #388bfd; }
    .viewport-btn:hover:not(.active) { background: #30363d; color: #e6edf3; }

    /* Main layout */
    .container {
      display: flex; margin-top: 52px; height: calc(100vh - 52px);
      gap: 1px; background: #30363d;
    }

    /* Each preview pane */
    .pane {
      flex: 1; display: flex; flex-direction: column;
      background: #0d1117; overflow: hidden;
    }
    .pane-header {
      display: flex; align-items: center; justify-content: center; gap: 8px;
      padding: 10px 16px; background: #161b22; border-bottom: 1px solid #30363d;
      flex-shrink: 0;
    }
    .pane-header .badge {
      padding: 2px 8px; border-radius: 10px; font-size: 11px;
      font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px;
    }
    .pane-header .badge.klaviyo { background: #1a3a2a; color: #3fb950; }
    .pane-header .badge.redo { background: #1a2a3a; color: #58a6ff; }
    .pane-header .filename { font-size: 12px; color: #8b949e; font-family: 'SF Mono', monospace; }

    /* Email preview area */
    .preview-area {
      flex: 1; overflow-y: scroll; overflow-x: hidden;
      padding: 24px; background: #161b22;
    }
    .email-frame {
      width: 600px; margin: 0 auto; background: #fff;
      border-radius: 8px; overflow: hidden;
      box-shadow: 0 4px 24px rgba(0,0,0,0.4), 0 0 0 1px rgba(255,255,255,0.05);
      transition: width 0.3s ease;
    }
    .email-frame.mobile { width: 375px; }
    .email-frame iframe {
      width: 100%; border: none; display: block;
    }

    /* Sync scroll indicator */
    .scroll-sync {
      position: fixed; bottom: 16px; right: 16px;
      padding: 6px 12px; background: #21262d; border: 1px solid #30363d;
      border-radius: 6px; font-size: 11px; color: #8b949e;
      cursor: pointer; user-select: none;
    }
    .scroll-sync.active { color: #58a6ff; border-color: #58a6ff; }

    /* Diff overlay when hovering */
    .pane:hover .email-frame { box-shadow: 0 4px 24px rgba(0,0,0,0.4), 0 0 0 2px #388bfd; }

    /* JSON drawer */
    .json-drawer {
      position: fixed; top: 52px; right: 0; bottom: 0;
      width: 560px; max-width: 80vw;
      background: #0d1117; border-left: 1px solid #30363d;
      display: flex; flex-direction: column;
      transform: translateX(100%); transition: transform 0.2s ease;
      z-index: 900;
    }
    .json-drawer.open { transform: translateX(0); }
    .json-drawer-header {
      display: flex; align-items: center; justify-content: space-between;
      padding: 10px 16px; background: #161b22; border-bottom: 1px solid #30363d;
      flex-shrink: 0;
    }
    .json-drawer-header h2 { font-size: 13px; font-weight: 600; color: #e6edf3; }
    .json-drawer-header .close {
      background: none; border: none; color: #8b949e; font-size: 18px;
      cursor: pointer; padding: 0 8px;
    }
    .json-drawer-header .close:hover { color: #e6edf3; }
    .block-index {
      padding: 8px 12px; background: #161b22; border-bottom: 1px solid #30363d;
      display: flex; flex-wrap: wrap; gap: 4px; flex-shrink: 0;
      max-height: 120px; overflow-y: auto;
    }
    .block-chip {
      padding: 3px 8px; border-radius: 10px; font-size: 11px;
      background: #21262d; border: 1px solid #30363d;
      color: #8b949e; cursor: pointer; font-family: 'SF Mono', monospace;
    }
    .block-chip:hover { background: #30363d; color: #e6edf3; }
    .block-chip.highlighted { background: #1a3a2a; color: #3fb950; border-color: #2ea043; }
    .json-pre {
      flex: 1; overflow: auto; padding: 12px 16px;
      font-family: 'SF Mono', Menlo, monospace; font-size: 11px;
      line-height: 1.5; color: #e6edf3;
      white-space: pre; tab-size: 2;
    }
    /* Very light JSON syntax colors */
    .json-pre .k { color: #79c0ff; }  /* keys */
    .json-pre .s { color: #a5d6ff; }  /* strings */
    .json-pre .n { color: #ffa657; }  /* numbers */
    .json-pre .b { color: #ff7b72; }  /* booleans/null */
    .json-pre mark { background: #3fb95033; color: inherit; border-radius: 2px; }

    .toolbar-btn {
      padding: 6px 12px; border: 1px solid #30363d; background: #21262d;
      color: #8b949e; font-size: 12px; cursor: pointer; border-radius: 6px;
    }
    .toolbar-btn:hover { background: #30363d; color: #e6edf3; }
    .toolbar-btn.active { background: #388bfd; color: #fff; border-color: #388bfd; }
  </style>
</head>
<body>
  <div class="toolbar">
    <div class="toolbar-left">
      <h1>Email Preview</h1>
      <span class="subtitle">${labelA}</span>
    </div>
    <div class="toolbar-center">
      <button class="viewport-btn active" onclick="setViewport('desktop')">Desktop</button>
      <button class="viewport-btn" onclick="setViewport('mobile')">Mobile</button>
    </div>
    <div style="width: 100px; display: flex; justify-content: flex-end;">
      ${jsonB ? `<button class="toolbar-btn" id="jsonBtn" onclick="toggleJson()">JSON</button>` : ""}
    </div>
  </div>

  ${jsonB ? `
  <div class="json-drawer" id="jsonDrawer">
    <div class="json-drawer-header">
      <h2>Redo template JSON</h2>
      <button class="close" onclick="toggleJson()">✕</button>
    </div>
    <div class="block-index" id="blockIndex"></div>
    <pre class="json-pre" id="jsonPre"></pre>
  </div>` : ""}

  <div class="container">
    <div class="pane">
      <div class="pane-header">
        <span class="badge klaviyo">Klaviyo</span>
        <span class="filename">Source HTML</span>
      </div>
      <div class="preview-area" id="areaA">
        <div class="email-frame" id="frameWrapA">
          <iframe id="frameA" onload="resizeFrame(this)"></iframe>
        </div>
      </div>
    </div>

    <div class="pane">
      <div class="pane-header">
        <span class="badge redo">Redo</span>
        <span class="filename">Rendered from Section[]</span>
      </div>
      <div class="preview-area" id="areaB">
        <div class="email-frame" id="frameWrapB">
          <iframe id="frameB" onload="resizeFrame(this)"></iframe>
        </div>
      </div>
    </div>
  </div>

  <div class="scroll-sync active" id="syncBtn" onclick="toggleSync()">Scroll sync: ON</div>

  <script>
    // Load email content into iframes
    document.getElementById('frameA').srcdoc = ${JSON.stringify(htmlA)};
    document.getElementById('frameB').srcdoc = ${JSON.stringify(htmlB)};

    // Auto-resize iframe to match its content height (no internal scroll)
    function resizeFrame(iframe) {
      try {
        // Small delay to let content render
        setTimeout(() => {
          const h = iframe.contentDocument.documentElement.scrollHeight;
          iframe.style.height = h + 'px';
        }, 100);
      } catch(e) {}
    }
    // Re-check heights after full load
    window.addEventListener('load', () => {
      resizeFrame(document.getElementById('frameA'));
      resizeFrame(document.getElementById('frameB'));
    });

    // Viewport toggle
    function setViewport(mode) {
      const frames = document.querySelectorAll('.email-frame');
      const buttons = document.querySelectorAll('.viewport-btn');
      buttons.forEach(b => b.classList.remove('active'));
      event.target.classList.add('active');
      frames.forEach(f => {
        if (mode === 'mobile') f.classList.add('mobile');
        else f.classList.remove('mobile');
      });
    }

    // Synchronized scrolling
    let syncEnabled = true;
    let scrolling = false;
    const areaA = document.getElementById('areaA');
    const areaB = document.getElementById('areaB');

    function syncScroll(source, target) {
      if (!syncEnabled || scrolling) return;
      scrolling = true;
      const pct = source.scrollTop / (source.scrollHeight - source.clientHeight || 1);
      target.scrollTop = pct * (target.scrollHeight - target.clientHeight || 1);
      requestAnimationFrame(() => { scrolling = false; });
    }

    areaA.addEventListener('scroll', () => syncScroll(areaA, areaB));
    areaB.addEventListener('scroll', () => syncScroll(areaB, areaA));

    function toggleSync() {
      syncEnabled = !syncEnabled;
      const btn = document.getElementById('syncBtn');
      btn.textContent = 'Scroll sync: ' + (syncEnabled ? 'ON' : 'OFF');
      btn.classList.toggle('active', syncEnabled);
    }

    // ── JSON drawer ───────────────────────────────────────────────
    const JSON_SRC = ${JSON.stringify(jsonB ?? "")};

    function highlightJson(src) {
      // Escape HTML, then add syntax spans for keys, strings, numbers, literals.
      let s = src
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
      // Keys: "foo":
      s = s.replace(/("[^"\\\\]*(?:\\\\.[^"\\\\]*)*")(\\s*:)/g, '<span class="k">$1</span>$2');
      // Strings (non-key): : "foo"
      s = s.replace(/(:\\s*)("[^"\\\\]*(?:\\\\.[^"\\\\]*)*")/g, '$1<span class="s">$2</span>');
      // Numbers
      s = s.replace(/(:\\s*)(-?\\d+(?:\\.\\d+)?)/g, '$1<span class="n">$2</span>');
      // true / false / null
      s = s.replace(/(:\\s*)(true|false|null)\\b/g, '$1<span class="b">$2</span>');
      return s;
    }

    function initJsonPanel() {
      if (!JSON_SRC) return;
      const pre = document.getElementById('jsonPre');
      pre.innerHTML = highlightJson(JSON_SRC);

      // Build block index from parsed JSON
      const parsed = JSON.parse(JSON_SRC);
      const sections = Array.isArray(parsed) ? parsed : (parsed.sections || []);
      const index = document.getElementById('blockIndex');
      sections.forEach((s, i) => {
        const chip = document.createElement('span');
        chip.className = 'block-chip';
        const id = (s.blockId || '').slice(0, 8);
        chip.textContent = (i + 1) + '. ' + s.type + (id ? ' · ' + id : '');
        chip.onclick = () => jumpToBlock(s.blockId, chip);
        index.appendChild(chip);
      });
    }

    function jumpToBlock(blockId, chipEl) {
      if (!blockId) return;
      const pre = document.getElementById('jsonPre');
      // Clear previous highlights / chips
      pre.innerHTML = highlightJson(JSON_SRC);
      document.querySelectorAll('.block-chip').forEach(c => c.classList.remove('highlighted'));
      chipEl && chipEl.classList.add('highlighted');

      // Wrap the blockId match in <mark> and scroll into view
      const needle = '"blockId": "' + blockId + '"';
      const html = pre.innerHTML;
      const idx = html.indexOf(needle);
      if (idx === -1) return;
      pre.innerHTML = html.slice(0, idx) +
        '<mark id="__jump">' + needle + '</mark>' +
        html.slice(idx + needle.length);
      const mark = document.getElementById('__jump');
      if (mark) mark.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    function toggleJson() {
      const drawer = document.getElementById('jsonDrawer');
      const btn = document.getElementById('jsonBtn');
      if (!drawer) return;
      const open = drawer.classList.toggle('open');
      btn && btn.classList.toggle('active', open);
    }

    initJsonPanel();

    // Keyboard shortcut: J to toggle
    document.addEventListener('keydown', (e) => {
      if (e.key === 'j' && !e.metaKey && !e.ctrlKey && document.activeElement === document.body) {
        toggleJson();
      }
    });
  </script>
</body>
</html>`;
}

function buildSinglePreview(html: string, label: string): string {
  return `<!DOCTYPE html>
<html>
<head>
  <title>Preview: ${label}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { background: #161b22; display: flex; justify-content: center; padding: 24px; }
    .email-frame {
      width: 600px; background: #fff; border-radius: 8px; overflow: hidden;
      box-shadow: 0 4px 24px rgba(0,0,0,0.4);
    }
    iframe { width: 100%; border: none; min-height: 100vh; }
  </style>
</head>
<body>
  <div class="email-frame">
    <iframe id="frame" onload="try{this.style.height=this.contentDocument.documentElement.scrollHeight+'px'}catch(e){}"></iframe>
  </div>
  <script>
    document.getElementById('frame').srcdoc = ${JSON.stringify(html)};
  </script>
</body>
</html>`;
}

// --- Main ---

if (args[0] === "--compare") {
  if (args.length < 3) {
    console.error(
      "Usage: npx tsx src/viewer.ts --compare <klaviyo.html> <redo.json>",
    );
    process.exit(1);
  }

  const a = resolveFile(args[1]);
  const b = resolveFile(args[2]);
  const label = templateName(args[1]);

  const page = buildComparisonPage(
    a.html,
    b.html,
    label,
    templateName(args[2]),
    b.json,
  );
  const outPath = join(outDir, "compare.html");
  writeFileSync(outPath, page);
  openInBrowser(outPath);
} else {
  const { html } = resolveFile(args[0]);
  const label = templateName(args[0]);
  const page = buildSinglePreview(html, label);
  const outPath = join(outDir, "view.html");
  writeFileSync(outPath, page);
  openInBrowser(outPath);
}
