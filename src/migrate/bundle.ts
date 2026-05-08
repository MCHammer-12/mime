/**
 * Troubleshoot bundle: zip up everything Claude needs to debug a single
 * template/flow within an import job. Streams a zip directly to res.
 *
 * Per selected item the bundle includes:
 *   - Klaviyo source (HTML + JSON metadata)
 *   - Redo output (.redo-template.json)
 *   - Parse result (warnings, substitutions, review items, skipped blocks)
 *   - The user's free-text note for the item
 *
 * Top-level: manifest.json (job metadata + selected items) + a README.md
 * with a paste-ready summary you can drop into chat as a quick orientation.
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { ServerResponse } from "node:http";
import archiver from "archiver";
import { coerceNote, type JobState } from "./jobs.js";

const MIGRATIONS_DIR = "migrations";

export interface BundleItemRequest {
  /** Klaviyo template id or flow id. */
  id: string;
  /** What kind of item this is. */
  type: "template" | "flow";
}

interface ExportedEventPayload {
  id?: string;
  name?: string;
  sectionCount?: number;
  warningList?: string[];
  unsupportedList?: unknown[];
  reviewItemList?: unknown[];
  skippedList?: unknown[];
  substitutions?: string[];
  fontPlanEntries?: unknown[];
  outputPath?: string;
}

interface FlowImportedEventPayload {
  id?: string;
  name?: string;
  flowId?: string;
  createdTemplateCount?: number;
  blankTemplateCount?: number;
  warningCount?: number;
  warningList?: unknown[];
  parsedAutomation?: unknown;
}

interface FlowFailedEventPayload {
  id?: string;
  name?: string;
  klaviyoStatus?: string;
  error?: string;
  warningList?: unknown[];
  parsedAutomation?: unknown;
  klaviyoFlow?: unknown;
}

/**
 * Write the bundle to res. Caller is responsible for HTTP status + headers
 * before calling (so an error before the first write can still surface as
 * a 4xx/5xx). Returns when the zip stream has finalized.
 */
export async function streamBundle(
  job: JobState,
  items: BundleItemRequest[],
  res: ServerResponse,
): Promise<void> {
  const archive = archiver("zip", { zlib: { level: 9 } });
  archive.on("warning", (err) => {
    if (err.code !== "ENOENT") console.warn("[bundle] archive warning:", err);
  });
  archive.on("error", (err) => {
    console.error("[bundle] archive error:", err);
    res.destroy(err);
  });
  archive.pipe(res);

  const manifest = {
    jobId: job.id,
    storeId: job.storeId,
    storeName: job.storeName,
    merchantSlug: job.merchantSlug,
    status: job.status,
    createdAt: job.createdAt,
    completedAt: job.completedAt,
    summary: job.summary,
    items: items.map((it) => ({ ...it, name: itemName(job, it.id) })),
  };
  archive.append(JSON.stringify(manifest, null, 2), { name: "manifest.json" });

  const readmeChunks: string[] = [
    `# Troubleshoot bundle — ${job.storeName}`,
    `Job ${job.id} (${job.merchantSlug})`,
    `Created ${job.createdAt}${job.completedAt ? ` · completed ${job.completedAt}` : ""}`,
    "",
    `## Items (${items.length})`,
    "",
  ];

  for (const item of items) {
    const note = coerceNote(job.notes[item.id]);
    const folder = `${item.type}-${item.id}`;
    if (item.type === "template") {
      addTemplateToBundle(job, item.id, folder, archive);
    } else {
      addFlowToBundle(job, item.id, folder, archive);
    }
    if (note) {
      const noteBody = note.author
        ? `_by ${note.author}${note.savedAt ? ` · ${note.savedAt}` : ""}_\n\n${note.text}`
        : note.text;
      archive.append(noteBody, { name: `${folder}/notes.md` });
    }

    readmeChunks.push(
      `### ${item.type}: ${itemName(job, item.id)} (${item.id})`,
      `Folder: \`${folder}/\``,
    );
    if (note) {
      readmeChunks.push("");
      if (note.author) readmeChunks.push(`**Note** (by ${note.author}):`);
      else readmeChunks.push(`**Note:**`);
      readmeChunks.push("", note.text.trim(), "");
    }
    readmeChunks.push("");
  }

  archive.append(readmeChunks.join("\n"), { name: "README.md" });

  await archive.finalize();
}

function itemName(job: JobState, itemId: string): string {
  for (const ev of job.events) {
    if (ev.kind === "exported" || ev.kind === "flow_imported" || ev.kind === "imported") {
      const p = ev.payload as { id?: string; name?: string };
      if (p.id === itemId && p.name) return p.name;
    }
  }
  return itemId;
}

function lastExportedFor(job: JobState, templateId: string): ExportedEventPayload | null {
  for (let i = job.events.length - 1; i >= 0; i--) {
    const ev = job.events[i];
    if (ev.kind === "exported") {
      const p = ev.payload as ExportedEventPayload;
      if (p.id === templateId) return p;
    }
  }
  return null;
}

function lastFlowImportedFor(job: JobState, flowId: string): FlowImportedEventPayload | null {
  for (let i = job.events.length - 1; i >= 0; i--) {
    const ev = job.events[i];
    if (ev.kind === "flow_imported") {
      const p = ev.payload as FlowImportedEventPayload;
      if (p.id === flowId) return p;
    }
  }
  return null;
}

function lastFlowFailedFor(job: JobState, flowId: string): FlowFailedEventPayload | null {
  for (let i = job.events.length - 1; i >= 0; i--) {
    const ev = job.events[i];
    if (ev.kind === "flow_failed") {
      const p = ev.payload as FlowFailedEventPayload;
      if (p.id === flowId) return p;
    }
  }
  return null;
}

function addTemplateToBundle(
  job: JobState,
  templateId: string,
  folder: string,
  archive: archiver.Archiver,
): void {
  const dir = join(MIGRATIONS_DIR, job.merchantSlug, "templates");
  const candidates = listTemplateFiles(dir, templateId);

  for (const f of candidates.sourceHtml) {
    archive.file(join(dir, f), { name: `${folder}/klaviyo-source.html` });
  }
  for (const f of candidates.sourceJson) {
    archive.file(join(dir, f), { name: `${folder}/klaviyo-meta.json` });
  }
  for (const f of candidates.redoOutput) {
    archive.file(join(dir, f), { name: `${folder}/redo-output.json` });
  }

  const exportedEvent = lastExportedFor(job, templateId);
  if (exportedEvent) {
    const parseResult = {
      sectionCount: exportedEvent.sectionCount ?? null,
      warnings: exportedEvent.warningList ?? [],
      substitutions: exportedEvent.substitutions ?? [],
      unsupportedFeatures: exportedEvent.unsupportedList ?? [],
      reviewItems: exportedEvent.reviewItemList ?? [],
      skippedBlocks: exportedEvent.skippedList ?? [],
      fontPlanEntries: exportedEvent.fontPlanEntries ?? [],
    };
    archive.append(JSON.stringify(parseResult, null, 2), {
      name: `${folder}/parse-result.json`,
    });
  }
}

function addFlowToBundle(
  job: JobState,
  flowId: string,
  folder: string,
  archive: archiver.Archiver,
): void {
  const dir = join(MIGRATIONS_DIR, job.merchantSlug, "flows");
  const candidates = listFlowFiles(dir, flowId);

  for (const f of candidates.sourceJson) {
    archive.file(join(dir, f), { name: `${folder}/klaviyo-flow.json` });
  }

  // Successful import path: flow_imported has the parsed automation tree
  // and the per-flow warnings.
  const flowEvent = lastFlowImportedFor(job, flowId);
  if (flowEvent) {
    const parseResult = {
      createdTemplateCount: flowEvent.createdTemplateCount ?? null,
      blankTemplateCount: flowEvent.blankTemplateCount ?? null,
      warnings: flowEvent.warningList ?? [],
      redoFlowId: flowEvent.flowId ?? null,
      parsedAutomation: flowEvent.parsedAutomation ?? null,
    };
    archive.append(JSON.stringify(parseResult, null, 2), {
      name: `${folder}/parse-result.json`,
    });
    return;
  }

  // Failed import path: flow_failed carries the parsed automation we tried
  // to send + the Klaviyo source flow + the full error string. Without this
  // the bundle for a failed flow has nothing useful in it (was only the
  // case for Replit-deployed migrate-server, where the migrations/<merchant>
  // dir on disk is empty).
  const failedEvent = lastFlowFailedFor(job, flowId);
  if (failedEvent) {
    const parseResult = {
      status: "failed",
      error: failedEvent.error ?? null,
      klaviyoStatus: failedEvent.klaviyoStatus ?? null,
      warnings: failedEvent.warningList ?? [],
      parsedAutomation: failedEvent.parsedAutomation ?? null,
    };
    archive.append(JSON.stringify(parseResult, null, 2), {
      name: `${folder}/parse-result.json`,
    });
    if (failedEvent.klaviyoFlow) {
      archive.append(JSON.stringify(failedEvent.klaviyoFlow, null, 2), {
        name: `${folder}/klaviyo-flow.json`,
      });
    }
    if (failedEvent.error) {
      archive.append(failedEvent.error, { name: `${folder}/error.txt` });
    }
  }
}

interface TemplateFileMatch {
  sourceHtml: string[];
  sourceJson: string[];
  redoOutput: string[];
}

// Klaviyo emits filenames like `<id>-<slug>.html`; redo output is a sibling
// named `<id>-<slug>.redo-template.json`. Match by id prefix and split by
// extension so each ends up at the right spot in the bundle.
function listTemplateFiles(dir: string, templateId: string): TemplateFileMatch {
  if (!existsSync(dir)) {
    return { sourceHtml: [], sourceJson: [], redoOutput: [] };
  }
  const files = readdirSync(dir);
  const prefix = `${templateId}-`;
  const sourceHtml = files.filter(
    (f) => f.startsWith(prefix) && f.endsWith(".html"),
  );
  // Source json: the Klaviyo API response. Skip our derived sidecar files
  // (`.redo-template.json` is the bundle output; `.sections.json` is a
  // pre-export debug artifact).
  const sourceJson = files.filter(
    (f) =>
      f.startsWith(prefix) &&
      f.endsWith(".json") &&
      !f.endsWith(".redo-template.json") &&
      !f.endsWith(".sections.json"),
  );
  const redoOutput = files.filter(
    (f) => f.startsWith(prefix) && f.endsWith(".redo-template.json"),
  );
  return { sourceHtml, sourceJson, redoOutput };
}

interface FlowFileMatch {
  sourceJson: string[];
}

function listFlowFiles(dir: string, flowId: string): FlowFileMatch {
  if (!existsSync(dir)) return { sourceJson: [] };
  const files = readdirSync(dir);
  const sourceJson = files.filter(
    (f) =>
      (f === `${flowId}.json` || f.startsWith(`${flowId}-`)) && f.endsWith(".json"),
  );
  return { sourceJson };
}
