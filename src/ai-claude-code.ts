/**
 * Local-dev AI provider that hands off prompts to a Claude Code session
 * via the filesystem — so we can iterate locally without an Anthropic key.
 *
 * When `AI_VIA_CLAUDE_CODE=1` is set, calls to the Anthropic SDK are
 * redirected here. This module exposes `claudeCodeMessagesCreate()`, which
 * implements the same shape the Anthropic SDK's `messages.create()`
 * returns.
 *
 * Protocol:
 *   1. On a call, write the full prompt (system + user messages) to
 *      `.ai-cache/<id>.request.md`.
 *   2. Print a one-line instruction to stderr so the developer can paste
 *      it to Claude in their chat.
 *   3. Poll for `.ai-cache/<id>.response.md` every 500ms (up to
 *      AI_VIA_CLAUDE_CODE_TIMEOUT_MS, default 10 minutes).
 *   4. When the response file appears, read it, return it as the SDK's
 *      content[0].text, and clean up both files.
 *
 * The response file can be plain text — the whole file body becomes the
 * "text" content of the response. No structured formatting required.
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const CACHE_DIR = ".ai-cache";
const POLL_INTERVAL_MS = 500;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

interface AnthropicSystemBlock {
  type: "text";
  text: string;
  cache_control?: unknown;
}

interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | Array<{ type: string; text?: string }>;
}

interface CreateRequest {
  model: string;
  max_tokens: number;
  system?: string | AnthropicSystemBlock[];
  messages: AnthropicMessage[];
}

interface CreateResponse {
  content: Array<{ type: "text"; text: string }>;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
  };
}

function renderPromptFile(req: CreateRequest, id: string): string {
  const systemText = Array.isArray(req.system)
    ? req.system.map((s) => s.text).join("\n\n")
    : typeof req.system === "string"
    ? req.system
    : "";

  const userParts: string[] = [];
  for (const m of req.messages) {
    if (typeof m.content === "string") {
      userParts.push(`**${m.role}:**\n\n${m.content}`);
    } else {
      for (const c of m.content) {
        if (c.type === "text" && c.text) {
          userParts.push(`**${m.role}:**\n\n${c.text}`);
        }
      }
    }
  }

  return [
    `# AI request — ${id}`,
    ``,
    `**Model:** ${req.model}`,
    `**Max tokens:** ${req.max_tokens}`,
    ``,
    `## System prompt`,
    ``,
    systemText || "_(none)_",
    ``,
    `## Conversation`,
    ``,
    userParts.join("\n\n---\n\n"),
    ``,
    `---`,
    ``,
    `## Instructions for Claude`,
    ``,
    `Respond as if you were running the prompt above with the model \`${req.model}\`.`,
    `Output ONLY the response content the model would produce — no preamble, no`,
    `explanation, no code fences around the whole thing. Preserve all HTML/whitespace`,
    `verbatim.`,
    ``,
    `Save your response to: \`${CACHE_DIR}/${id}.response.md\``,
    ``,
    `The pipeline is polling for that file and will pick it up automatically.`,
    ``,
  ].join("\n");
}

function ensureCacheDir(): void {
  if (!existsSync(CACHE_DIR)) {
    mkdirSync(CACHE_DIR, { recursive: true });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Clean up stale request/response pairs left over from prior runs. */
function cleanup(id: string): void {
  for (const suffix of [".request.md", ".response.md"]) {
    const p = join(CACHE_DIR, `${id}${suffix}`);
    try {
      if (existsSync(p)) unlinkSync(p);
    } catch {
      // ignore
    }
  }
}

/**
 * Drop-in replacement for `anthropic.messages.create(req)`. Blocks until
 * the developer pastes the request to Claude + Claude writes a response
 * file. Returns an SDK-shaped response object.
 */
export async function claudeCodeMessagesCreate(
  req: CreateRequest,
): Promise<CreateResponse> {
  ensureCacheDir();
  const id = randomUUID().slice(0, 8);
  const requestPath = join(CACHE_DIR, `${id}.request.md`);
  const responsePath = join(CACHE_DIR, `${id}.response.md`);

  writeFileSync(requestPath, renderPromptFile(req, id), "utf8");

  // One-line hint for the developer. Written to stderr so it doesn't
  // interleave with NDJSON event streams on stdout.
  const hint = [
    ``,
    `[ai-via-claude-code] AI prompt written to ${requestPath}`,
    `[ai-via-claude-code] → Tell Claude: "Check ${requestPath} and save your response to ${responsePath}"`,
    `[ai-via-claude-code] (polling for response, Ctrl+C to abort)`,
    ``,
  ].join("\n");
  process.stderr.write(hint);

  const timeoutMs = Number(process.env.AI_VIA_CLAUDE_CODE_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (existsSync(responsePath)) {
      const text = readFileSync(responsePath, "utf8").trim();
      cleanup(id);
      // Approximate token usage for logging. Real usage is unknown; use
      // rough character-based estimates so the transform stats aren't
      // totally blank.
      const rawInputChars =
        (typeof req.system === "string"
          ? req.system.length
          : Array.isArray(req.system)
          ? req.system.reduce((n, s) => n + s.text.length, 0)
          : 0) +
        req.messages.reduce((n, m) => {
          if (typeof m.content === "string") return n + m.content.length;
          return (
            n +
            m.content.reduce(
              (nn, c) => nn + (c.type === "text" && c.text ? c.text.length : 0),
              0,
            )
          );
        }, 0);
      return {
        content: [{ type: "text", text }],
        usage: {
          input_tokens: Math.ceil(rawInputChars / 4),
          output_tokens: Math.ceil(text.length / 4),
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      };
    }
    await sleep(POLL_INTERVAL_MS);
  }

  cleanup(id);
  throw new Error(
    `[ai-via-claude-code] Timed out after ${timeoutMs}ms waiting for ${responsePath}. ` +
      `Re-run with SKIP_AI=1 or AI_VIA_CLAUDE_CODE_TIMEOUT_MS=<larger-ms>.`,
  );
}
