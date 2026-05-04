// Flows and Templates list views. Shared shell, specialized row renderers.

const { useState: useStateList, useMemo: useMemoList } = React;

function ListShell({
  items, selectedIds, onToggle, onToggleAll,
  filter, onFilterChange,
  statusFilter, onStatusFilterChange, statuses,
  renderRow, countLabel,
  hideAlreadyImported, onHideAlreadyImportedChange,
  alreadyImportedCount,
  noContentNote,
  emptyText,
}) {
  const allSelected = items.length > 0 && items.every(i => selectedIds.has(getItemId(i)));
  const someSelected = items.some(i => selectedIds.has(getItemId(i))) && !allSelected;

  return (
    <div className="flex flex-col h-full">
      {/* Filter bar */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-[#21262d] bg-[#0d1117]">
        <div className="relative flex-1 max-w-md">
          <Icon.search
            width="13" height="13"
            className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[#6e7681]"
          />
          <input
            value={filter}
            onChange={(e) => onFilterChange(e.target.value)}
            placeholder="Filter by name…"
            className="w-full bg-[#010409] border border-[#30363d] rounded-[4px] pl-7 pr-2 py-1 text-[12px] text-[#e6edf3] placeholder:text-[#484f58] focus:outline-none focus:border-[#388bfd]"
          />
          {filter && (
            <button onClick={() => onFilterChange("")} className="absolute right-1.5 top-1/2 -translate-y-1/2 text-[#6e7681] hover:text-[#e6edf3]">
              <Icon.x width="12" height="12"/>
            </button>
          )}
        </div>

        {statuses && (
          <div className="flex items-center gap-0.5 text-[11px]">
            <span className="text-[#6e7681] mr-1 text-[10px] uppercase tracking-wider">status</span>
            {["all", ...statuses].map(s => (
              <button
                key={s}
                onClick={() => onStatusFilterChange(s)}
                className={
                  "px-2 py-0.5 rounded-[3px] " +
                  (statusFilter === s
                    ? "bg-[#21262d] text-[#e6edf3]"
                    : "text-[#8b949e] hover:text-[#e6edf3]")
                }
              >{s}</button>
            ))}
          </div>
        )}

        <label className="flex items-center gap-1.5 text-[11px] text-[#8b949e] cursor-pointer ml-auto">
          <input
            type="checkbox"
            checked={hideAlreadyImported}
            onChange={(e) => onHideAlreadyImportedChange(e.target.checked)}
            className="w-3 h-3 accent-[#238636] cursor-pointer"
          />
          Hide already imported
          {alreadyImportedCount > 0 && (
            <span className="text-[#484f58] tabular-nums">({alreadyImportedCount})</span>
          )}
        </label>

        <span className="text-[11px] text-[#8b949e] tabular-nums pl-2 border-l border-[#21262d]">
          {countLabel}
        </span>
      </div>

      {/* Column header */}
      <div className="flex items-center px-4 py-1.5 border-b border-[#21262d] text-[10px] uppercase tracking-wider text-[#6e7681] bg-[#0d1117] sticky top-0 z-[1]">
        <Checkbox
          checked={allSelected}
          indeterminate={someSelected}
          onChange={() => onToggleAll()}
        />
        <span className="ml-3">{items.length.toLocaleString()} shown</span>
      </div>

      {noContentNote && (
        <div className="px-4 py-1.5 border-b border-[#21262d] bg-[#0d1117] text-[11px] text-[#8b949e] flex items-start gap-1.5">
          <Icon.alert width="12" height="12" className="text-[#6e7681] mt-0.5 shrink-0"/>
          <span>{noContentNote}</span>
        </div>
      )}

      {/* Rows */}
      <div className="flex-1 overflow-y-auto">
        {items.length === 0 ? (
          <div className="px-4 py-8 text-[12px] text-[#6e7681] text-center">{emptyText}</div>
        ) : (
          items.map(item => renderRow(item, selectedIds.has(getItemId(item)), () => onToggle(getItemId(item))))
        )}
      </div>
    </div>
  );
}

function getItemId(item) {
  return item.flowId || item.campaignId || item.id;
}

// ── Flow row ──────────────────────────────────────────────────────
function FlowRow({ flow, selected, onToggle, alreadyImported, inProgress, lastResult }) {
  const [expanded, setExpanded] = useStateList(false);
  const emailCount = flow.emails.length;

  const stateIndicator = () => {
    if (inProgress) return (
      <span className="text-[10px] text-[#388bfd] flex items-center gap-1">
        <span className="inline-block w-1.5 h-1.5 rounded-full bg-[#388bfd] animate-pulse" />
        importing
      </span>
    );
    if (lastResult === "imported") return (
      <span className="text-[10px] text-[#3fb950] flex items-center gap-1">
        <Icon.check width="10" height="10"/> just imported
      </span>
    );
    if (lastResult === "failed") return (
      <span className="text-[10px] text-[#f85149] flex items-center gap-1">
        <Icon.alert width="10" height="10"/> failed
      </span>
    );
    if (alreadyImported) return (
      <span className="text-[10px] text-[#6e7681] flex items-center gap-1">
        <Icon.check width="10" height="10"/> imported earlier
      </span>
    );
    return null;
  };

  return (
    <div className={"border-b border-[#21262d] " + (selected ? "bg-[#388bfd08]" : "hover:bg-[#161b22]")}>
      <div
        className="flex items-center px-4 py-2 cursor-pointer"
        onClick={onToggle}
      >
        <Checkbox checked={selected} onChange={onToggle} />
        <button
          onClick={(e) => { e.stopPropagation(); setExpanded(!expanded); }}
          className="ml-1 w-4 h-4 flex items-center justify-center text-[#6e7681] hover:text-[#e6edf3]"
        >
          {expanded
            ? <Icon.chevronDown width="12" height="12"/>
            : <Icon.chevronRight width="12" height="12"/>}
        </button>
        <div className="flex-1 min-w-0 ml-2">
          <div className="flex items-center gap-3">
            <span className={"text-[13px] truncate " + (alreadyImported ? "text-[#8b949e]" : "text-[#e6edf3]")}>
              {flow.flowName}
            </span>
            {stateIndicator()}
          </div>
          <div className="flex items-center gap-3 mt-0.5 text-[11px] text-[#6e7681]">
            <StatusBadge status={flow.flowStatus}/>
            <span>{flow.triggerType}</span>
            <span>·</span>
            <span className="flex items-center gap-1">
              <Icon.mail width="10" height="10"/>
              {emailCount} email{emailCount === 1 ? "" : "s"}
            </span>
            <span>·</span>
            <span>updated {relDate(flow.updated)}</span>
          </div>
        </div>
        <code className="text-[10px] text-[#484f58] font-mono hidden md:block ml-3 truncate max-w-[160px]">
          {flow.flowId}
        </code>
      </div>
      {expanded && (
        <div className="pb-2 pl-[52px] pr-4 -mt-1">
          <div className="text-[10px] uppercase tracking-wider text-[#6e7681] mb-1">
            Emails in this flow · imported together
          </div>
          <div className="space-y-0.5">
            {flow.emails.map((e, i) => (
              <div key={e.templateId} className="flex items-center gap-2 text-[11px] text-[#8b949e]">
                <span className="text-[#484f58] tabular-nums">{String(i + 1).padStart(2, "0")}</span>
                <Icon.mail width="10" height="10" className="text-[#484f58]"/>
                <span className="truncate">{e.name}</span>
                <code className="text-[#484f58] text-[10px] ml-auto truncate max-w-[140px]">{e.templateId}</code>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Template row ──────────────────────────────────────────────────
function TemplateRow({ template, selected, onToggle, alreadyImported, inProgress, lastResult }) {
  const stateIndicator = () => {
    if (inProgress) return (
      <span className="text-[10px] text-[#388bfd] flex items-center gap-1">
        <span className="inline-block w-1.5 h-1.5 rounded-full bg-[#388bfd] animate-pulse" />
        importing
      </span>
    );
    if (lastResult === "imported") return (
      <span className="text-[10px] text-[#3fb950] flex items-center gap-1">
        <Icon.check width="10" height="10"/> just imported
      </span>
    );
    if (lastResult === "failed") return (
      <span className="text-[10px] text-[#f85149] flex items-center gap-1">
        <Icon.alert width="10" height="10"/> failed
      </span>
    );
    if (alreadyImported) return (
      <span className="text-[10px] text-[#6e7681] flex items-center gap-1">
        <Icon.check width="10" height="10"/> imported earlier
      </span>
    );
    return null;
  };

  return (
    <div
      className={
        "flex items-center px-4 py-1.5 border-b border-[#21262d] cursor-pointer " +
        (selected ? "bg-[#388bfd08]" : "hover:bg-[#161b22]")
      }
      onClick={onToggle}
    >
      <Checkbox checked={selected} onChange={onToggle} />
      <div className="flex-1 min-w-0 ml-3">
        <div className="flex items-center gap-3">
          <span className={"text-[13px] truncate " + (alreadyImported ? "text-[#8b949e]" : "text-[#e6edf3]")}>
            {template.name}
          </span>
          {stateIndicator()}
        </div>
        <div className="flex items-center gap-3 mt-0.5 text-[11px] text-[#6e7681]">
          {template.editorType === "CODE"
            ? <span className="flex items-center gap-1"><Icon.code width="10" height="10"/> code</span>
            : <span className="flex items-center gap-1"><Icon.drag width="10" height="10"/> draggable</span>}
          <span>·</span>
          <span>updated {relDate(template.updated)}</span>
        </div>
      </div>
      <code className="text-[10px] text-[#484f58] font-mono hidden md:block ml-3 truncate max-w-[200px]">
        {template.id}
      </code>
    </div>
  );
}

// ── Campaign row ──────────────────────────────────────────────────
// Parallels FlowRow (expandable container showing each message). A campaign
// with multiple messages = A/B variants → each produces an EmailTemplate.
function CampaignRow({ campaign, selected, onToggle, alreadyImported, inProgress, lastResult, libraryTemplateIds }) {
  const [expanded, setExpanded] = useStateList(false);
  const msgCount = campaign.messages?.length ?? 0;
  const hasLibraryOverlap = (campaign.messages ?? []).some(
    (m) => m.templateId && libraryTemplateIds?.has(m.templateId),
  );

  const stateIndicator = () => {
    if (inProgress) return (
      <span className="text-[10px] text-[#388bfd] flex items-center gap-1">
        <span className="inline-block w-1.5 h-1.5 rounded-full bg-[#388bfd] animate-pulse" />
        importing
      </span>
    );
    if (lastResult === "imported") return (
      <span className="text-[10px] text-[#3fb950] flex items-center gap-1">
        <Icon.check width="10" height="10"/> just imported
      </span>
    );
    if (lastResult === "failed") return (
      <span className="text-[10px] text-[#f85149] flex items-center gap-1">
        <Icon.alert width="10" height="10"/> failed
      </span>
    );
    if (alreadyImported) return (
      <span className="text-[10px] text-[#6e7681] flex items-center gap-1">
        <Icon.check width="10" height="10"/> imported earlier
      </span>
    );
    return null;
  };

  return (
    <div className={"border-b border-[#21262d] " + (selected ? "bg-[#388bfd08]" : "hover:bg-[#161b22]")}>
      <div
        className="flex items-center px-4 py-2 cursor-pointer"
        onClick={onToggle}
      >
        <Checkbox checked={selected} onChange={onToggle} />
        <button
          onClick={(e) => { e.stopPropagation(); setExpanded(!expanded); }}
          className="ml-1 w-4 h-4 flex items-center justify-center text-[#6e7681] hover:text-[#e6edf3]"
        >
          {expanded
            ? <Icon.chevronDown width="12" height="12"/>
            : <Icon.chevronRight width="12" height="12"/>}
        </button>
        <div className="flex-1 min-w-0 ml-2">
          <div className="flex items-center gap-3">
            <span className={"text-[13px] truncate " + (alreadyImported ? "text-[#8b949e]" : "text-[#e6edf3]")}>
              {campaign.campaignName}
            </span>
            {stateIndicator()}
          </div>
          <div className="flex items-center gap-3 mt-0.5 text-[11px] text-[#6e7681]">
            <StatusBadge status={campaign.status}/>
            <span className="flex items-center gap-1">
              <Icon.mail width="10" height="10"/>
              {msgCount} message{msgCount === 1 ? "" : "s"}
              {msgCount > 1 && <span className="text-[#d29922] ml-0.5">(A/B)</span>}
            </span>
            {campaign.sendTime && (
              <>
                <span>·</span>
                <span>sent {relDate(campaign.sendTime)}</span>
              </>
            )}
            {hasLibraryOverlap && (
              <>
                <span>·</span>
                <span className="text-[#d29922]" title="This campaign reuses a library template that also appears in the Templates tab. Importing both will produce a duplicate in Redo.">
                  uses library template
                </span>
              </>
            )}
          </div>
        </div>
        <code className="text-[10px] text-[#484f58] font-mono hidden md:block ml-3 truncate max-w-[160px]">
          {campaign.campaignId}
        </code>
      </div>
      {expanded && (
        <div className="pb-2 pl-[52px] pr-4 -mt-1">
          <div className="text-[10px] uppercase tracking-wider text-[#6e7681] mb-1">
            Messages · each becomes one email template in Redo
          </div>
          <div className="space-y-0.5">
            {(campaign.messages ?? []).map((m, i) => (
              <div key={m.messageId} className="flex items-center gap-2 text-[11px] text-[#8b949e]">
                <span className="text-[#484f58] tabular-nums">{String(i + 1).padStart(2, "0")}</span>
                <Icon.mail width="10" height="10" className="text-[#484f58]"/>
                <span className="truncate">{m.label || m.subject || `variant ${String.fromCharCode(65 + i)}`}</span>
                {m.templateId && libraryTemplateIds?.has(m.templateId) && (
                  <span className="text-[9px] text-[#d29922]">· also in library</span>
                )}
                <code className="text-[#484f58] text-[10px] ml-auto truncate max-w-[140px]">
                  {m.templateId || "(no template)"}
                </code>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

Object.assign(window, { ListShell, FlowRow, TemplateRow, CampaignRow });
