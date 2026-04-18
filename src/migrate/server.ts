/**
 * Local web UI for the Klaviyo → Redo migration pipeline.
 *
 * Usage:
 *   npx tsx src/migrate/server.ts [PORT]
 *
 * Then open http://localhost:PORT (default 8765) in your browser.
 *
 * Endpoints:
 *   GET  /                    HTML UI
 *   POST /api/templates       list Klaviyo templates (input: { klaviyoKey })
 *   POST /api/run             fetch + export + import (streams NDJSON progress)
 */

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { exportTemplate } from "../export-template.js";
import { fetchAccount } from "../fetch-account.js";
import { klaviyo, paginate, slug } from "../klaviyo.js";

const MIME_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../");
const DEFAULT_REDOAPP_DIR = join(homedir(), "code/redoapp");
const PORT = parseInt(process.argv[2] ?? "8765", 10);

// ─── helpers ───────────────────────────────────────────────────────────────

function readJsonBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function ndjsonStart(res: ServerResponse) {
  res.writeHead(200, {
    "content-type": "application/x-ndjson",
    "cache-control": "no-cache",
    "x-accel-buffering": "no",
  });
}

function emit(res: ServerResponse, event: Record<string, unknown>) {
  res.write(JSON.stringify(event) + "\n");
}

// ─── API: /api/templates ───────────────────────────────────────────────────

async function handleTemplates(req: IncomingMessage, res: ServerResponse) {
  const body = await readJsonBody(req);
  const key = body.klaviyoKey as string;
  if (!key) return json(res, 400, { error: "klaviyoKey required" });

  try {
    type T = {
      id: string;
      attributes: { name: string; editor_type: string; updated: string };
    };
    const all = await paginate<T>(
      "/templates/?fields[template]=name,editor_type,updated&sort=-updated",
      key,
    );
    const templates = all
      .filter((t) => t.attributes.editor_type !== "KLAVIYO")
      .map((t) => ({
        id: t.id,
        name: t.attributes.name,
        editorType: t.attributes.editor_type,
        updated: t.attributes.updated,
      }));

    let accountName: string | null = null;
    try {
      const acct = await fetchAccount(key);
      accountName = acct.organizationName;
    } catch (e) {
      // non-fatal
    }

    json(res, 200, { templates, accountName });
  } catch (e: any) {
    json(res, 500, { error: e.message ?? String(e) });
  }
}

// ─── API: /api/flows ───────────────────────────────────────────────────────
//
// Flow emails in Klaviyo live inside flow-action/flow-message relationships,
// not (reliably) in the user-facing /templates list. We walk the flow tree
// so the UI can show "Flow name → Email 1, Email 2, …" and the user can
// pick by flow email rather than scroll a flat 400-entry template list.

async function handleFlows(req: IncomingMessage, res: ServerResponse) {
  const body = await readJsonBody(req);
  const key = body.klaviyoKey as string;
  if (!key) return json(res, 400, { error: "klaviyoKey required" });

  try {
    type FlowMeta = {
      id: string;
      attributes: { name: string; status: string; trigger_type: string };
    };
    const flows = await paginate<FlowMeta>(
      "/flows/?fields[flow]=name,status,trigger_type&sort=-updated",
      key,
    );

    // For each flow, walk actions + messages to collect send-email steps.
    // Run in parallel across flows (bounded concurrency), serial per-flow.
    const LIMIT = 5;
    const out: Array<{
      flowId: string;
      flowName: string;
      flowStatus: string;
      triggerType: string;
      emails: Array<{
        templateId: string | null;
        messageId: string;
        actionId: string;
        name: string | null;
      }>;
    }> = [];

    let idx = 0;
    async function worker() {
      while (idx < flows.length) {
        const i = idx++;
        const f = flows[i]!;
        try {
          const actionsBody: any = await klaviyo(
            `/flows/${f.id}/flow-actions/`,
            key,
          );
          const emails: Array<{
            templateId: string | null;
            messageId: string;
            actionId: string;
            name: string | null;
          }> = [];
          const emailActions = (actionsBody.data ?? []).filter(
            (a: any) => a.attributes?.definition?.type === "send-email",
          );
          for (const a of emailActions) {
            try {
              const msgs: any = await klaviyo(
                `/flow-actions/${a.id}/flow-messages/`,
                key,
              );
              for (const m of msgs.data ?? []) {
                let tplId: string | null = null;
                try {
                  const rel: any = await klaviyo(
                    `/flow-messages/${m.id}/relationships/template/`,
                    key,
                  );
                  tplId = rel?.data?.id ?? null;
                } catch (e) {
                  // some messages may not have a template (e.g. smart-send)
                }
                emails.push({
                  templateId: tplId,
                  messageId: m.id,
                  actionId: a.id,
                  name: m.attributes?.name ?? null,
                });
              }
            } catch (e) {
              // skip silently; flow may have been partially deleted
            }
          }
          if (emails.length > 0) {
            out.push({
              flowId: f.id,
              flowName: f.attributes.name,
              flowStatus: f.attributes.status,
              triggerType: f.attributes.trigger_type,
              emails,
            });
          }
        } catch (e) {
          // skip bad flow
        }
      }
    }
    await Promise.all(Array.from({ length: LIMIT }, () => worker()));

    // Sort: live flows first, then by name
    out.sort((a, b) => {
      const rank = (s: string) =>
        s === "live" ? 0 : s === "manual" ? 1 : s === "draft" ? 2 : 3;
      return (
        rank(a.flowStatus) - rank(b.flowStatus) ||
        a.flowName.localeCompare(b.flowName)
      );
    });

    json(res, 200, { flows: out });
  } catch (e: any) {
    json(res, 500, { error: e.message ?? String(e) });
  }
}

// ─── API: /api/run (NDJSON stream) ─────────────────────────────────────────

async function handleRun(req: IncomingMessage, res: ServerResponse) {
  const body = await readJsonBody(req);
  const klaviyoKey = body.klaviyoKey as string;
  const storeId = body.storeId as string;
  const merchantSlug = body.merchantSlug as string;
  const templateIds = (body.templateIds ?? []) as string[];
  const skipAi = body.skipAi !== false; // default true for the web UI
  const runImport = body.runImport !== false;
  const anthropicKey = body.anthropicKey as string | undefined;
  const redoappDir =
    (body.redoappDir as string | undefined) || process.env.REDOAPP_DIR || DEFAULT_REDOAPP_DIR;

  if (!klaviyoKey || !storeId || !merchantSlug || templateIds.length === 0) {
    return json(res, 400, {
      error: "klaviyoKey, storeId, merchantSlug, and templateIds required",
    });
  }

  ndjsonStart(res);

  try {
    if (anthropicKey && !process.env.ANTHROPIC_API_KEY) {
      process.env.ANTHROPIC_API_KEY = anthropicKey;
    }

    // 1. Fetch account
    emit(res, { kind: "step", label: "Fetching Klaviyo account…" });
    let account = null;
    try {
      account = await fetchAccount(klaviyoKey);
      emit(res, { kind: "info", text: `Account: ${account.organizationName}` });
    } catch (e: any) {
      emit(res, { kind: "warn", text: `Could not fetch account (${e.message}). Variable substitution skipped.` });
    }

    // 2. Prepare output dir
    const templatesDir = join(MIME_ROOT, "migrations", merchantSlug, "templates");
    mkdirSync(templatesDir, { recursive: true });
    emit(res, { kind: "info", text: `Output: ${templatesDir}` });

    // 3. Download + export each template
    const exported: { id: string; name: string; path: string }[] = [];
    const failures: { id: string; name: string; error: string }[] = [];

    for (const tid of templateIds) {
      emit(res, { kind: "step", label: `Downloading ${tid}…` });
      try {
        const full: any = await klaviyo(`/templates/${tid}/`, klaviyoKey);
        const name = full.data?.attributes?.name ?? tid;
        const html = full.data?.attributes?.html ?? "";
        if (!html) {
          failures.push({
            id: tid,
            name,
            error: "template has no HTML (editor_type may not be supported)",
          });
          emit(res, { kind: "fail", id: tid, name, error: "no HTML" });
          continue;
        }
        const base = `${tid}-${slug(name, tid)}`;
        const htmlPath = join(templatesDir, `${base}.html`);
        writeFileSync(htmlPath, html, "utf8");
        writeFileSync(
          join(templatesDir, `${base}.json`),
          JSON.stringify(full.data, null, 2),
          "utf8",
        );

        emit(res, { kind: "step", label: `Exporting ${name}…` });
        const result = await exportTemplate(htmlPath, { account, skipAi });

        exported.push({ id: tid, name, path: result.outPath });
        emit(res, {
          kind: "exported",
          id: tid,
          name,
          sectionCount: result.sectionCount,
          warnings: result.warnings.length,
          unsupported: result.unsupportedFeatures.length,
          reviewItems: result.reviewItems.length,
          aiRewrites: result.aiRewrites,
          fontPlanEntries: result.fontPlan.entries.map((e: any) => ({
            family: e.family,
            available: e.resolution.available,
          })),
        });
      } catch (e: any) {
        const msg = e.message ?? String(e);
        failures.push({ id: tid, name: tid, error: msg });
        emit(res, { kind: "fail", id: tid, name: tid, error: msg });
      }
    }

    emit(res, { kind: "summary", exported: exported.length, failed: failures.length });

    if (exported.length === 0 || !runImport) {
      const cmd = `cd ${redoappDir} && bazel run //redo/manage:import-klaviyo-templates -- --team ${storeId} --account ${merchantSlug} --mime-dir ${MIME_ROOT}`;
      emit(res, { kind: "done", importSkipped: true, importCommand: cmd });
      res.end();
      return;
    }

    // 4. Hide other account dirs' exports so the import only sees these
    // (actually: the import reads ALL .redo-template.json in the dir, so the
    // exports we just wrote are what'll import. Fine.)

    // 5. Import via bazel
    emit(res, { kind: "step", label: "Importing into Redo (bazel)…" });

    const importArgs = [
      "run",
      "//redo/manage:import-klaviyo-templates",
      "--",
      "--team",
      storeId,
      "--account",
      merchantSlug,
      "--mime-dir",
      MIME_ROOT,
    ];

    const proc = spawn("bazel", importArgs, {
      cwd: redoappDir,
      env: process.env,
    });

    // Auto-confirm the manage script's "Import N template(s)? (y/n)" prompt
    proc.stdin.write("y\n");
    proc.stdin.end();

    proc.stdout.on("data", (buf) => {
      const lines = buf.toString().split("\n").filter(Boolean);
      for (const line of lines) emit(res, { kind: "log", source: "stdout", text: line });
    });
    proc.stderr.on("data", (buf) => {
      const lines = buf.toString().split("\n").filter(Boolean);
      for (const line of lines) emit(res, { kind: "log", source: "stderr", text: line });
    });

    await new Promise<void>((resolveProc) => {
      proc.on("close", (code) => {
        emit(res, { kind: "done", importExitCode: code });
        resolveProc();
      });
    });
  } catch (e: any) {
    emit(res, { kind: "error", text: e.message ?? String(e) });
  } finally {
    res.end();
  }
}

// ─── HTML ──────────────────────────────────────────────────────────────────

const HTML = /* html */ `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Klaviyo → Redo Migration</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font: 14px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: #0d1117; color: #e6edf3;
      min-height: 100vh; padding: 24px;
    }
    .wrap { max-width: 1100px; margin: 0 auto; }
    h1 { font-size: 20px; font-weight: 600; margin-bottom: 4px; }
    .subtitle { color: #8b949e; font-size: 12px; margin-bottom: 24px; }

    .card {
      background: #161b22; border: 1px solid #30363d; border-radius: 8px;
      padding: 20px; margin-bottom: 16px;
    }
    .card h2 {
      font-size: 13px; font-weight: 600; text-transform: uppercase;
      letter-spacing: 0.5px; color: #8b949e; margin-bottom: 16px;
    }

    .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    label { display: block; font-size: 12px; color: #8b949e; margin-bottom: 4px; }
    input[type=text], input[type=password] {
      width: 100%; padding: 8px 10px;
      background: #0d1117; border: 1px solid #30363d; border-radius: 6px;
      color: #e6edf3; font: 13px 'SF Mono', Menlo, monospace;
    }
    input:focus { outline: none; border-color: #388bfd; }

    button {
      padding: 8px 16px; border: 1px solid #30363d; background: #21262d;
      color: #e6edf3; font-size: 13px; border-radius: 6px; cursor: pointer;
    }
    button:hover:not(:disabled) { background: #30363d; }
    button.primary {
      background: #238636; border-color: #2ea043; color: #fff;
    }
    button.primary:hover:not(:disabled) { background: #2ea043; }
    button:disabled { opacity: 0.5; cursor: not-allowed; }

    .toolbar { display: flex; gap: 8px; margin-bottom: 12px; }
    .counter { color: #8b949e; font-size: 12px; align-self: center; }

    .template-list {
      max-height: 420px; overflow-y: auto;
      background: #0d1117; border: 1px solid #30363d; border-radius: 6px;
    }
    .template-row {
      display: grid; grid-template-columns: 24px 1fr auto auto auto;
      gap: 12px; padding: 8px 12px; border-bottom: 1px solid #21262d;
      font-size: 13px; align-items: center;
    }
    .template-row:last-child { border-bottom: none; }
    .template-row:hover { background: #161b22; }
    .template-row.selected { background: #1a2a3a; }
    .template-row input[type=checkbox] { cursor: pointer; }
    .template-row .name { color: #e6edf3; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .template-row .id { font-family: 'SF Mono', monospace; color: #6e7681; font-size: 11px; }
    .template-row .date { color: #8b949e; font-size: 11px; }
    .template-row .tag {
      padding: 2px 6px; border-radius: 10px; font-size: 10px;
      background: #30363d; color: #8b949e; font-weight: 600;
    }
    .template-row .tag.code { background: #3a1a2a; color: #da3633; }

    .flow-group { border-bottom: 1px solid #30363d; }
    .flow-group:last-child { border-bottom: none; }
    .flow-header {
      display: grid; grid-template-columns: 24px 1fr auto auto auto;
      gap: 12px; padding: 10px 12px; background: #161b22;
      font-size: 13px; align-items: center; cursor: pointer;
      user-select: none;
    }
    .flow-header:hover { background: #1a2030; }
    .flow-header .chevron { color: #8b949e; width: 14px; display: inline-block; transition: transform 0.15s; }
    .flow-header.collapsed .chevron { transform: rotate(-90deg); }
    .flow-header .flow-name { color: #e6edf3; font-weight: 600; }
    .flow-header .status-pill {
      padding: 2px 8px; border-radius: 10px; font-size: 10px; font-weight: 600;
    }
    .flow-header .status-pill.live { background: #1a3a2a; color: #3fb950; }
    .flow-header .status-pill.draft { background: #30363d; color: #8b949e; }
    .flow-header .status-pill.manual { background: #2a2a3a; color: #8b949e; }
    .flow-header .count { color: #8b949e; font-size: 11px; }
    .flow-emails { padding-left: 20px; }
    .flow-emails.collapsed { display: none; }
    .flow-emails .template-row { background: transparent; }

    .log {
      background: #0d1117; border: 1px solid #30363d; border-radius: 6px;
      padding: 12px; max-height: 400px; overflow-y: auto;
      font: 12px 'SF Mono', Menlo, monospace; color: #e6edf3;
      white-space: pre-wrap; line-height: 1.5;
    }
    .log .line { margin-bottom: 2px; }
    .log .step { color: #58a6ff; font-weight: 600; }
    .log .info { color: #8b949e; }
    .log .warn { color: #d29922; }
    .log .exported { color: #3fb950; }
    .log .fail { color: #f85149; }
    .log .done { color: #3fb950; font-weight: 600; }
    .log .error { color: #f85149; font-weight: 600; }
    .log .stdout { color: #e6edf3; }
    .log .stderr { color: #d29922; }
    .log .summary { color: #58a6ff; font-weight: 600; }

    .search {
      width: 100%; margin-bottom: 8px; padding: 6px 10px;
      background: #0d1117; border: 1px solid #30363d; border-radius: 6px;
      color: #e6edf3; font-size: 13px;
    }

    .pill {
      display: inline-block; padding: 1px 8px; border-radius: 10px;
      font-size: 11px; font-weight: 600;
    }
    .pill.ok { background: #1a3a2a; color: #3fb950; }
    .pill.warn { background: #3a2a1a; color: #d29922; }
    .pill.fail { background: #3a1a1a; color: #f85149; }

    details { margin-top: 8px; }
    details summary { cursor: pointer; color: #8b949e; font-size: 12px; }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>Klaviyo → Redo Migration</h1>
    <div class="subtitle">mime preview UI · localhost:${PORT}</div>

    <div class="card">
      <h2>1. Credentials</h2>
      <div class="grid2">
        <div>
          <label>Klaviyo API key</label>
          <input type="password" id="klaviyoKey" placeholder="pk_..." autocomplete="off" />
        </div>
        <div>
          <label>Redo store ID (team _id)</label>
          <input type="text" id="storeId" placeholder="69dff28302f64f42e6012a4d" />
        </div>
        <div>
          <label>Merchant slug (directory name under migrations/)</label>
          <input type="text" id="merchantSlug" placeholder="acme-brand" />
        </div>
        <div>
          <label>Anthropic key (optional — for coupon rewrites)</label>
          <input type="password" id="anthropicKey" placeholder="sk-ant-... (leave blank to skip AI)" autocomplete="off" />
        </div>
      </div>
      <div style="margin-top: 12px; display: flex; gap: 8px; align-items: center;">
        <button id="loadTemplatesBtn" class="primary">Load templates</button>
        <button id="loadFlowsBtn">Load flows</button>
        <span class="counter" id="accountInfo"></span>
      </div>
    </div>

    <div class="card" id="templatesCard" style="display: none;">
      <h2 id="listHeader">2. Select templates</h2>
      <input type="text" class="search" id="search" placeholder="Filter by name…" />
      <div class="toolbar">
        <button id="selectAll">Select all</button>
        <button id="selectNone">Select none</button>
        <button id="invertSel">Invert</button>
        <span class="counter"><span id="selectedCount">0</span> / <span id="totalCount">0</span> selected</span>
      </div>
      <div class="template-list" id="templateList"></div>
    </div>

    <div class="card" id="runCard" style="display: none;">
      <h2>3. Run migration</h2>
      <div style="display: flex; gap: 8px; align-items: center; margin-bottom: 12px;">
        <button id="runBtn" class="primary">Export + Import</button>
        <label style="display: flex; align-items: center; gap: 6px; color: #e6edf3;">
          <input type="checkbox" id="runImport" checked />
          <span>Also run bazel import (uncheck to export only)</span>
        </label>
      </div>
      <div class="log" id="log"></div>
    </div>
  </div>

  <script>
    const el = (id) => document.getElementById(id);
    let mode = 'templates'; // 'templates' | 'flows'
    let templates = [];     // used in 'templates' mode
    let flows = [];         // used in 'flows' mode
    let selected = new Set(); // template IDs

    // Local storage for convenience
    const SAVED_KEYS = ['klaviyoKey', 'storeId', 'merchantSlug', 'anthropicKey'];
    for (const k of SAVED_KEYS) {
      const saved = localStorage.getItem('mime.' + k);
      if (saved) el(k).value = saved;
    }
    for (const k of SAVED_KEYS) {
      el(k).addEventListener('change', () => localStorage.setItem('mime.' + k, el(k).value));
    }

    // ── Load (templates or flows) ───────────────────────────────────
    async function load(which) {
      const key = el('klaviyoKey').value.trim();
      if (!key) return alert('Klaviyo API key required');
      const btn = which === 'templates' ? el('loadTemplatesBtn') : el('loadFlowsBtn');
      const otherBtn = which === 'templates' ? el('loadFlowsBtn') : el('loadTemplatesBtn');
      btn.disabled = true; otherBtn.disabled = true;
      btn.textContent = 'Loading…';
      el('accountInfo').textContent = '';
      try {
        const path = which === 'templates' ? '/api/templates' : '/api/flows';
        const r = await fetch(path, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ klaviyoKey: key }),
        });
        if (!r.ok) {
          const err = await r.json();
          throw new Error(err.error || r.statusText);
        }
        const body = await r.json();
        mode = which;
        selected = new Set();
        if (which === 'templates') {
          templates = body.templates;
          el('accountInfo').textContent = \`\${body.accountName || ''} · \${templates.length} templates\`;
          el('totalCount').textContent = templates.length;
          el('listHeader').textContent = '2. Select templates';
          renderTemplatesList();
        } else {
          flows = body.flows;
          const emailCount = flows.reduce((acc, f) => acc + f.emails.filter(e => e.templateId).length, 0);
          el('accountInfo').textContent = \`\${flows.length} flows · \${emailCount} flow emails\`;
          el('totalCount').textContent = emailCount;
          el('listHeader').textContent = '2. Select flow emails';
          renderFlowsList();
        }
        el('templatesCard').style.display = 'block';
        el('runCard').style.display = 'block';
      } catch (e) {
        alert('Failed: ' + e.message);
      } finally {
        el('loadTemplatesBtn').disabled = false;
        el('loadFlowsBtn').disabled = false;
        el('loadTemplatesBtn').textContent = 'Load templates';
        el('loadFlowsBtn').textContent = 'Load flows';
      }
    }
    el('loadTemplatesBtn').addEventListener('click', () => load('templates'));
    el('loadFlowsBtn').addEventListener('click', () => load('flows'));

    function renderTemplatesList() {
      const filter = el('search').value.trim().toLowerCase();
      const list = el('templateList');
      list.innerHTML = '';
      const matches = templates.filter(t => !filter || t.name.toLowerCase().includes(filter));
      for (const t of matches) {
        list.appendChild(buildTemplateRow(t.id, t.name, t.editorType, (t.updated || '').slice(0, 10)));
      }
      updateCounter();
    }

    function renderFlowsList() {
      const filter = el('search').value.trim().toLowerCase();
      const list = el('templateList');
      list.innerHTML = '';
      for (const flow of flows) {
        // Filter: match on flow name or any email name
        const matchEmails = flow.emails.filter(e => {
          if (!e.templateId) return false;
          if (!filter) return true;
          return flow.flowName.toLowerCase().includes(filter) ||
                 (e.name || '').toLowerCase().includes(filter);
        });
        if (matchEmails.length === 0) continue;

        const group = document.createElement('div');
        group.className = 'flow-group';

        const header = document.createElement('div');
        header.className = 'flow-header';
        const allSelected = matchEmails.every(e => selected.has(e.templateId));
        header.innerHTML = \`
          <input type="checkbox" \${allSelected ? 'checked' : ''} />
          <div><span class="chevron">▼</span> <span class="flow-name">\${escapeHtml(flow.flowName)}</span></div>
          <span class="status-pill \${flow.flowStatus}">\${flow.flowStatus}</span>
          <span class="count">\${matchEmails.length} email\${matchEmails.length === 1 ? '' : 's'}</span>
          <span class="id">\${flow.triggerType || ''}</span>
        \`;
        const emailsContainer = document.createElement('div');
        emailsContainer.className = 'flow-emails';
        for (const e of matchEmails) {
          const emailName = e.name || \`Email (msg \${e.messageId})\`;
          emailsContainer.appendChild(buildTemplateRow(e.templateId, emailName, 'draggable', ''));
        }
        group.appendChild(header);
        group.appendChild(emailsContainer);

        const groupCb = header.querySelector('input');
        groupCb.addEventListener('change', (ev) => {
          ev.stopPropagation();
          const check = groupCb.checked;
          for (const e of matchEmails) {
            if (check) selected.add(e.templateId);
            else selected.delete(e.templateId);
          }
          renderFlowsList();
        });
        header.addEventListener('click', (ev) => {
          if (ev.target === groupCb) return;
          emailsContainer.classList.toggle('collapsed');
          header.classList.toggle('collapsed');
        });
        list.appendChild(group);
      }
      updateCounter();
    }

    function buildTemplateRow(templateId, name, editorType, date) {
      const row = document.createElement('div');
      row.className = 'template-row' + (selected.has(templateId) ? ' selected' : '');
      const tagCls = editorType === 'CODE' ? 'tag code' : 'tag';
      const tagText = editorType === 'CODE' ? 'code' : 'draggable';
      row.innerHTML = \`
        <input type="checkbox" \${selected.has(templateId) ? 'checked' : ''} />
        <div class="name">\${escapeHtml(name)}</div>
        <span class="\${tagCls}">\${tagText}</span>
        <span class="date">\${date}</span>
        <span class="id">\${templateId}</span>
      \`;
      const cb = row.querySelector('input');
      cb.addEventListener('change', () => {
        if (cb.checked) selected.add(templateId);
        else selected.delete(templateId);
        row.classList.toggle('selected', cb.checked);
        updateCounter();
      });
      row.addEventListener('click', (e) => {
        if (e.target !== cb && !e.target.classList.contains('flow-name')) {
          cb.checked = !cb.checked;
          cb.dispatchEvent(new Event('change'));
        }
      });
      return row;
    }

    function renderList() {
      if (mode === 'templates') renderTemplatesList();
      else renderFlowsList();
    }

    function updateCounter() {
      el('selectedCount').textContent = selected.size;
    }

    el('search').addEventListener('input', renderList);

    function currentVisibleTemplateIds() {
      const filter = el('search').value.trim().toLowerCase();
      const out = [];
      if (mode === 'templates') {
        for (const t of templates) {
          if (!filter || t.name.toLowerCase().includes(filter)) out.push(t.id);
        }
      } else {
        for (const f of flows) {
          const fmatch = !filter || f.flowName.toLowerCase().includes(filter);
          for (const e of f.emails) {
            if (!e.templateId) continue;
            if (fmatch || (filter && (e.name || '').toLowerCase().includes(filter))) {
              out.push(e.templateId);
            }
          }
        }
      }
      return out;
    }

    el('selectAll').addEventListener('click', () => {
      for (const id of currentVisibleTemplateIds()) selected.add(id);
      renderList();
    });
    el('selectNone').addEventListener('click', () => {
      selected.clear();
      renderList();
    });
    el('invertSel').addEventListener('click', () => {
      for (const id of currentVisibleTemplateIds()) {
        if (selected.has(id)) selected.delete(id);
        else selected.add(id);
      }
      renderList();
    });

    // ── Run ─────────────────────────────────────────────────────────
    el('runBtn').addEventListener('click', async () => {
      if (selected.size === 0) return alert('Select at least one template');
      const payload = {
        klaviyoKey: el('klaviyoKey').value.trim(),
        storeId: el('storeId').value.trim(),
        merchantSlug: el('merchantSlug').value.trim(),
        anthropicKey: el('anthropicKey').value.trim() || undefined,
        skipAi: !el('anthropicKey').value.trim(),
        runImport: el('runImport').checked,
        templateIds: [...selected],
      };
      if (!payload.storeId || !payload.merchantSlug) {
        return alert('Store ID and merchant slug are required');
      }

      el('runBtn').disabled = true;
      el('runBtn').textContent = 'Running…';
      el('log').innerHTML = '';

      try {
        const r = await fetch('/api/run', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (!r.ok) {
          const err = await r.json().catch(() => ({}));
          throw new Error(err.error || r.statusText);
        }
        const reader = r.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const parts = buffer.split('\\n');
          buffer = parts.pop() || '';
          for (const line of parts) {
            if (!line) continue;
            try { renderEvent(JSON.parse(line)); } catch (e) { renderEvent({ kind: 'info', text: line }); }
          }
        }
      } catch (e) {
        renderEvent({ kind: 'error', text: e.message });
      } finally {
        el('runBtn').disabled = false;
        el('runBtn').textContent = 'Export + Import';
      }
    });

    function renderEvent(ev) {
      const log = el('log');
      const div = document.createElement('div');
      div.className = 'line ' + ev.kind + (ev.source ? ' ' + ev.source : '');
      let text = '';
      switch (ev.kind) {
        case 'step': text = '▶ ' + ev.label; break;
        case 'info': text = ev.text; break;
        case 'warn': text = '⚠ ' + ev.text; break;
        case 'exported': {
          const flags = [];
          if (ev.warnings) flags.push(ev.warnings + 'w');
          if (ev.unsupported) flags.push(ev.unsupported + 'u');
          if (ev.reviewItems) flags.push(ev.reviewItems + 'r');
          if (ev.aiRewrites) flags.push(ev.aiRewrites + 'ai');
          const fonts = (ev.fontPlanEntries || []).map(f =>
            f.family + (f.available ? '' : ' ✗')
          ).join(', ');
          text = '✓ ' + ev.name + ' (' + ev.sectionCount + ' sections' +
            (flags.length ? ', ' + flags.join(' ') : '') +
            (fonts ? ', fonts: ' + fonts : '') + ')';
          break;
        }
        case 'fail': text = '✗ ' + ev.name + ': ' + ev.error; break;
        case 'summary':
          text = '— ' + ev.exported + ' exported, ' + ev.failed + ' failed';
          break;
        case 'log': text = ev.text; break;
        case 'done':
          if (ev.importSkipped) text = '■ Done. Import skipped. To run manually:\\n  ' + ev.importCommand;
          else if (ev.importExitCode === 0) text = '■ Done. Import succeeded.';
          else text = '■ Done. Import exited with code ' + ev.importExitCode + '.';
          break;
        case 'error': text = '✗ ERROR: ' + ev.text; break;
        default: text = JSON.stringify(ev);
      }
      div.textContent = text;
      log.appendChild(div);
      log.scrollTop = log.scrollHeight;
    }

    function escapeHtml(s) {
      return s.replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
      }[c]));
    }
  </script>
</body>
</html>`;

// ─── server ────────────────────────────────────────────────────────────────

const server = createServer(async (req, res) => {
  try {
    if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(HTML);
      return;
    }
    if (req.method === "POST" && req.url === "/api/templates") {
      return handleTemplates(req, res);
    }
    if (req.method === "POST" && req.url === "/api/flows") {
      return handleFlows(req, res);
    }
    if (req.method === "POST" && req.url === "/api/run") {
      return handleRun(req, res);
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  } catch (e: any) {
    console.error(e);
    res.writeHead(500, { "content-type": "text/plain" });
    res.end(e.message ?? "error");
  }
});

server.listen(PORT, () => {
  console.log(`Migration UI: http://localhost:${PORT}`);
  console.log(`(ctrl-c to stop)`);
});
