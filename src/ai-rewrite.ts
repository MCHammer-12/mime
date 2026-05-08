/**
 * AI-powered text rewrites for the migration pipeline.
 *
 * One LLM call per text block (not batched — see feedback memory).
 * System prompt is cached across calls so only the user text is billed at full rate.
 *
 * Three providers, picked by env:
 *   - `SKIP_AI=1` → AI is disabled; callers should guard with hasInlineCoupon()
 *     + a noop fallback.
 *   - `AI_VIA_CLAUDE_CODE=1` → local-dev mode. Hands the prompt off to
 *     a Claude Code session via `.ai-cache/*.request.md` + `.response.md`
 *     file pairs. Zero API key needed; see src/ai-claude-code.ts.
 *   - Otherwise → Anthropic SDK. Picks credentials in this order:
 *       1. `AI_INTEGRATIONS_ANTHROPIC_API_KEY` + `AI_INTEGRATIONS_ANTHROPIC_BASE_URL`
 *          — Replit Anthropic blueprint integration (proxied through Replit).
 *       2. `ANTHROPIC_API_KEY` — direct to api.anthropic.com. This is the
 *          shape Replit's "Add Anthropic integration" sets by default.
 */

import { claudeCodeMessagesCreate } from "./ai-claude-code.js";

// The @anthropic-ai/sdk module is loaded lazily so the pipeline can run
// without the package installed when AI rewrites aren't needed (SKIP_AI=1).
type AnthropicCtor = new (opts: { apiKey: string; baseURL?: string }) => {
  messages: {
    create: (req: any) => Promise<any>;
  };
};

interface MessagesCreator {
  messages: { create: (req: any) => Promise<any> };
}

const MODEL = "claude-sonnet-4-6";

let _client: MessagesCreator | null = null;
async function client(): Promise<MessagesCreator> {
  if (_client) return _client;

  // Local dev: route through the Claude Code file-handoff client.
  if (process.env.AI_VIA_CLAUDE_CODE === "1") {
    _client = {
      messages: { create: claudeCodeMessagesCreate },
    };
    return _client;
  }

  // Prefer the Replit blueprint pair (proxied through Replit) when present,
  // else fall back to a bare ANTHROPIC_API_KEY (direct to api.anthropic.com).
  // Replit's default "Add Anthropic integration" sets only ANTHROPIC_API_KEY.
  const blueprintKey = process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY;
  const blueprintBase = process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL;
  const directKey = process.env.ANTHROPIC_API_KEY;

  let apiKey: string | undefined;
  let baseURL: string | undefined;
  if (blueprintKey && blueprintBase) {
    apiKey = blueprintKey;
    baseURL = blueprintBase;
  } else if (directKey) {
    apiKey = directKey;
    // baseURL omitted → SDK defaults to api.anthropic.com.
  }

  if (!apiKey) {
    throw new Error(
      "No AI provider configured. Set AI_VIA_CLAUDE_CODE=1 for local dev, " +
        "ANTHROPIC_API_KEY for direct access, or " +
        "AI_INTEGRATIONS_ANTHROPIC_API_KEY + AI_INTEGRATIONS_ANTHROPIC_BASE_URL " +
        "for the Replit blueprint integration.",
    );
  }

  // Dynamic import of an optional peer. The package is declared in
  // package.json but may not be installed (e.g. when SKIP_AI=1).
  const mod = await import("@anthropic-ai/sdk");
  const Anthropic = (mod.default ?? mod) as unknown as AnthropicCtor;
  _client = new Anthropic(baseURL ? { apiKey, baseURL } : { apiKey });
  return _client;
}

// ─── Inline-coupon rewrite ──────────────────────────────────────

const INLINE_COUPON_SYSTEM_PROMPT = `You are rewriting HTML fragments from marketing emails that are being migrated from Klaviyo to Redo.

The user will send you an HTML fragment that contains one or more inline Klaviyo \`{% coupon_code 'Name' %}\` template variables embedded mid-sentence. Redo has no inline coupon primitive, so the coupon must be removed from the text. A discount block will be inserted **directly below** the rewritten text by the migration pipeline — you can safely reference it.

Your job: rewrite the text so that (a) the \`{% coupon_code %}\` variable is gone, and (b) the surrounding sentence flows naturally and points the reader to the discount block below.

Rules:
1. Preserve all HTML tags and inline styles exactly. Only change the visible text.
2. Preserve the original tone, capitalization style, and punctuation conventions.
3. Keep every other liquid/Klaviyo template variable intact (e.g. \`{{ person.first_name }}\`, \`{{ organization.name }}\`).
4. Don't add any new links, buttons, or markup. Don't add emoji or formatting the original didn't have.
5. When the original sentence referred to "the code" or "code below" or "use the code X", rewrite to say "the code below" or similar — refer to the block that's being inserted.
6. If the sentence after removal would be stubby or awkward, merge it with an adjacent sentence rather than leaving a fragment.
7. Output ONLY the rewritten HTML fragment. No preamble, no explanation, no code fences.

Examples:

Input:
<p>Your 10% discount expires in just 24 short hours. Just use code {% coupon_code 'AbandonedCart' %} at checkout – and the discount will be automatically applied.</p>

Output:
<p>Your 10% discount expires in just 24 short hours. Use the code below at checkout – and the discount will be automatically applied.</p>

Input:
<p>Hey {{ person.first_name|default:'there' }}, here's {% coupon_code 'Welcome10' %} for 10% off your first order!</p>

Output:
<p>Hey {{ person.first_name|default:'there' }}, here's your 10% off code for your first order — see below!</p>

Input:
<p style="text-align:center"><span style="color:#333">Enter {% coupon_code 'FlashSale' %} at checkout to save.</span></p>

Output:
<p style="text-align:center"><span style="color:#333">Enter the code below at checkout to save.</span></p>`;

export interface RewriteResult {
  text: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
  };
}

/**
 * Rewrite a text-block HTML fragment that contains one or more inline
 * {% coupon_code %} variables. Returns the rewritten HTML.
 *
 * The caller is responsible for inserting a DiscountBlock after the
 * returned text — the rewrite assumes one will be present directly below.
 */
export async function rewriteInlineCoupon(
  textHtml: string,
): Promise<RewriteResult> {
  const response = await (await client()).messages.create({
    model: MODEL,
    max_tokens: 4096,
    system: [
      {
        type: "text",
        text: INLINE_COUPON_SYSTEM_PROMPT,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [{ role: "user", content: textHtml }],
  });

  const block = response.content[0];
  const text = block && block.type === "text" ? block.text : "";

  return {
    text: text.trim(),
    usage: {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
      cacheCreationTokens: response.usage.cache_creation_input_tokens ?? 0,
    },
  };
}

/**
 * Does this HTML fragment contain one or more inline {% coupon_code %} variables?
 * The parser already splits out standalone coupons into DiscountBlocks, so by
 * the time transform.ts runs, any remaining coupon in a text block is inline.
 */
export function hasInlineCoupon(html: string): boolean {
  return /\{%\s*coupon_code\s+'[^']*'?\s*%\}/.test(html);
}
