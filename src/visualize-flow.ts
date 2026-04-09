import { readFile, writeFile } from "node:fs/promises";

type Action = {
  id: string;
  type: string;
  data: any;
  links: { next?: string | null; next_if_true?: string | null; next_if_false?: string | null };
};

function hms(d: any): string {
  if (!d) return "0";
  const v = d.value ?? 0;
  const u = (d.unit ?? "").toLowerCase();
  return `${v}${u[0] ?? "?"}`;
}

function sanitize(s: string): string {
  return s
    .replace(/[()"'`{}[\]<>|&#]/g, "")
    .replace(/\n/g, " ")
    .trim()
    .slice(0, 70);
}

function summarizeConditions(tf: any): string {
  if (!tf?.condition_groups?.length) return "(no condition)";
  const parts: string[] = [];
  for (const g of tf.condition_groups) {
    for (const c of g.conditions ?? []) {
      if (c.type === "metric-property") {
        parts.push(`${c.field} ${c.filter?.operator} ${JSON.stringify(c.filter?.value ?? "")}`);
      } else if (c.type === "profile-metric") {
        parts.push(`metric ${c.metric_id} ${c.measurement_filter?.operator} ${c.measurement_filter?.value}`);
      } else {
        parts.push(c.type);
      }
    }
  }
  if (parts.length <= 2) return parts.join(" OR ");
  return `${parts.slice(0, 2).join(" OR ")} ...+${parts.length - 2}`;
}

async function main() {
  const file = process.argv[2];
  if (!file) throw new Error("usage: visualize-flow.ts <flow.json>");
  const bundle = JSON.parse(await readFile(file, "utf-8"));
  const attrs = bundle.data.attributes;
  const defn = attrs.definition;
  if (!defn) throw new Error("no definition in flow");

  const actions: Action[] = defn.actions;
  const byId = new Map<string, Action>(actions.map((a) => [a.id, a]));
  const entry = defn.entry_action_id;

  const lines: string[] = [];
  lines.push("flowchart TD");

  const metricId = defn.triggers?.[0]?.id ?? "none";
  lines.push(`  trigger["TRIGGER: ${sanitize(defn.triggers?.[0]?.type ?? "")} ${sanitize(metricId)}"]`);
  lines.push(`  style trigger fill:#2d7a2d,color:#fff`);

  const cfGroups = defn.profile_filter?.condition_groups?.length ?? 0;
  let root = "trigger";
  if (cfGroups) {
    lines.push(`  pfilter{"Profile filter — ${cfGroups} groups"}`);
    lines.push(`  trigger --> pfilter`);
    lines.push(`  style pfilter fill:#555,color:#fff`);
    root = "pfilter";
  }

  if (entry) lines.push(`  ${root} --> a${entry}`);

  for (const a of actions) {
    const id = `a${a.id}`;
    let label = "";
    let shape: [string, string] = ["[", "]"];
    let style = "";
    switch (a.type) {
      case "time-delay":
        label = `delay ${hms(a.data)}`;
        shape = ["([", "])"];
        style = `style ${id} fill:#ddd,color:#000`;
        break;
      case "send-email": {
        const m = a.data?.message ?? {};
        const subj = sanitize(m.subject_line ?? "(no subject)");
        const from = sanitize(m.from_label ?? m.from_email ?? "");
        label = `EMAIL: ${subj}<br/>${from}`;
        style = `style ${id} fill:#2c5a7a,color:#fff`;
        break;
      }
      case "send-sms": {
        const body = sanitize(a.data?.message?.body ?? "(no body)");
        label = `SMS: ${body}`;
        style = `style ${id} fill:#6a3d7a,color:#fff`;
        break;
      }
      case "conditional-split":
      case "trigger-split": {
        const cond = sanitize(summarizeConditions(a.data?.trigger_filter ?? a.data?.profile_filter));
        label = `BRANCH: ${cond}`;
        shape = ["{{", "}}"];
        style = `style ${id} fill:#b54,color:#fff`;
        break;
      }
      case "unsubscribe":
      case "update-profile":
      case "update-profile-property":
        label = a.type;
        style = `style ${id} fill:#999,color:#fff`;
        break;
      case "webhook":
        label = "webhook";
        break;
      case "ab-test":
        label = "A/B test";
        shape = ["{{", "}}"];
        break;
      default:
        label = a.type;
    }
    lines.push(`  ${id}${shape[0]}"${label}"${shape[1]}`);
    if (style) lines.push(`  ${style}`);

    if (a.links?.next_if_true || a.links?.next_if_false) {
      if (a.links.next_if_true) lines.push(`  ${id} -->|true| a${a.links.next_if_true}`);
      if (a.links.next_if_false) lines.push(`  ${id} -->|false| a${a.links.next_if_false}`);
    } else if (a.links?.next) {
      lines.push(`  ${id} --> a${a.links.next}`);
    }
  }

  const mmd = lines.join("\n");
  const base = file.replace(/\.json$/, "");
  await writeFile(`${base}.mmd`, mmd);

  const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>${sanitize(attrs.name ?? "Flow")}</title>
  <script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script>
  <style>
    body { font-family: -apple-system, system-ui, sans-serif; margin: 0; padding: 20px; background: #f4f4f4; }
    h1 { margin: 0 0 8px; }
    .meta { color: #666; margin-bottom: 20px; font-size: 14px; }
    .mermaid { background: white; padding: 20px; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,.08); overflow-x: auto; }
  </style>
</head>
<body>
  <h1>${sanitize(attrs.name ?? "Flow")}</h1>
  <div class="meta">
    <strong>Status:</strong> ${attrs.status} ·
    <strong>Trigger:</strong> ${defn.triggers?.[0]?.type ?? ""} ${metricId} ·
    <strong>Actions:</strong> ${actions.length} ·
    <strong>Branches:</strong> ${actions.filter((a) => a.type === "conditional-split" || a.type === "trigger-split").length}
  </div>
  <pre class="mermaid">
${mmd}
  </pre>
  <script>
    mermaid.initialize({ startOnLoad: true, theme: 'default', flowchart: { curve: 'basis', htmlLabels: true } });
  </script>
</body>
</html>`;
  await writeFile(`${base}.html`, html);
  console.log(`wrote ${base}.html`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
