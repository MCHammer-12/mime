// Redo marketing-rpc client for segments. Same wire format + auth as
// src/migrate/import-rpc.ts (raw `Authorization: <jwt>`, body `{ input }`,
// response `{ output }`), narrowed to the two RPCs the segment flow needs:
//   POST /marketing-rpc/getSegmentCount     → count a query WITHOUT persisting
//   POST /marketing-rpc/createDynamicSegment → persist the segment
//
// getSegmentCount perms: VIEW_MARKETING | MANAGE_CAMPAIGNS | MANAGE_AUTOMATIONS.
// createDynamicSegment perm: MANAGE_SEGMENTS. A team admin JWT covers both.

import { DEFAULT_SERVER_BASE, RedoAuthExpiredError } from "../migrate/import-rpc.js";
import type { SegmentQuery } from "./redo-types.js";

export interface RedoClientOptions {
  jwt: string;
  serverBase?: string;
}

export interface SegmentCounts {
  allCount: number;
  emailEligibleCount: number;
  emailSubscriberCount: number;
  smsSubscriberCount: number;
}

function base(serverBase: string | undefined): string {
  const raw = (serverBase ?? DEFAULT_SERVER_BASE).trim();
  return raw.replace(/\/+$/, "") || DEFAULT_SERVER_BASE;
}

async function postMarketingRpc(
  method: string,
  input: unknown,
  opts: RedoClientOptions,
): Promise<any> {
  const url = `${base(opts.serverBase)}/marketing-rpc/${method}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: opts.jwt },
    body: JSON.stringify({ input }),
  });
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // non-JSON error body
  }
  if (!res.ok) {
    const msg =
      body?.error ??
      body?.message ??
      (text && text.length > 0 ? text.slice(0, 2000) : res.statusText);
    if (res.status === 401) throw new RedoAuthExpiredError(`/marketing-rpc/${method}`, res.status, msg);
    throw new Error(`POST /marketing-rpc/${method} ${res.status}: ${msg}`);
  }
  if (body?.error) throw new Error(`POST /marketing-rpc/${method}: ${body.error}`);
  return body?.output ?? body;
}

/** Count the population a query would select, without creating anything. */
export async function getSegmentCount(
  segment: SegmentQuery,
  opts: RedoClientOptions,
): Promise<SegmentCounts> {
  const out = await postMarketingRpc("getSegmentCount", { segment }, opts);
  return {
    allCount: Number(out?.allCount ?? 0),
    emailEligibleCount: Number(out?.emailEligibleCount ?? 0),
    emailSubscriberCount: Number(out?.emailSubscriberCount ?? 0),
    smsSubscriberCount: Number(out?.smsSubscriberCount ?? 0),
  };
}

export interface CreatedSegment {
  id: string;
  name: string;
}

/** Persist a dynamic segment. Call only after verification passes / approval. */
export async function createDynamicSegment(
  name: string,
  conditions: SegmentQuery,
  opts: RedoClientOptions,
): Promise<CreatedSegment> {
  const out = await postMarketingRpc("createDynamicSegment", { name, conditions }, opts);
  return { id: String(out?._id ?? out?.id ?? ""), name: String(out?.name ?? name) };
}
