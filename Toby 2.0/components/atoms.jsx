// Small presentational atoms used throughout the migrator UI.

const { useState, useEffect, useRef, useMemo, useCallback } = React;

// ── Status dot for flows ──────────────────────────────────────────
function StatusBadge({ status }) {
  const config = {
    live:     { dot: "#3fb950", label: "live" },
    draft:    { dot: "#8b949e", label: "draft" },
    manual:   { dot: "#d29922", label: "manual" },
    disabled: { dot: "#6e7681", label: "disabled" },
  }[status] || { dot: "#8b949e", label: status };

  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] text-[#8b949e] tabular-nums">
      <span className="inline-block w-1.5 h-1.5 rounded-full" style={{ background: config.dot }} />
      {config.label}
    </span>
  );
}

// ── Short relative date ───────────────────────────────────────────
function relDate(iso) {
  const d = new Date(iso);
  const now = new Date();
  const ms = now - d;
  const days = Math.floor(ms / 86400000);
  if (days < 1) return "today";
  if (days < 7) return `${days}d`;
  if (days < 30) return `${Math.floor(days / 7)}w`;
  if (days < 365) return `${Math.floor(days / 30)}mo`;
  return `${Math.floor(days / 365)}y`;
}

// ── Checkbox ──────────────────────────────────────────────────────
// Button-like: square tile with tactile hover/press + animated checkmark.
function Checkbox({ checked, indeterminate, onChange, disabled }) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={indeterminate ? "mixed" : !!checked}
      disabled={disabled}
      onClick={(e) => { e.stopPropagation(); if (!disabled && onChange) onChange({ target: { checked: !checked } }); }}
      className={
        "relative w-[18px] h-[18px] rounded-[4px] flex items-center justify-center " +
        "transition-all duration-100 ease-out select-none " +
        "active:scale-[0.88] " +
        (disabled
          ? "bg-[#161b22] border border-[#30363d] cursor-not-allowed opacity-40"
          : checked || indeterminate
            ? "bg-[#238636] border border-[#2ea043] shadow-[0_1px_0_0_#1a6127,inset_0_1px_0_0_#3fb95033] hover:bg-[#2ea043] hover:border-[#3fb950] active:shadow-none active:translate-y-px cursor-pointer"
            : "bg-[#0d1117] border border-[#30363d] hover:border-[#6e7681] hover:bg-[#161b22] shadow-[inset_0_1px_0_0_#ffffff05] cursor-pointer"
        )
      }
    >
      {indeterminate && !checked ? (
        <span className="w-[9px] h-[1.5px] bg-white rounded-full" />
      ) : checked ? (
        <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="white" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ filter: "drop-shadow(0 1px 0 rgba(0,0,0,0.25))" }}>
          <path d="M3.5 8.2L6.5 11.3L12.5 4.7"
            style={{
              strokeDasharray: 14,
              strokeDashoffset: 0,
              animation: "cbDraw 180ms ease-out",
            }}
          />
        </svg>
      ) : null}
      <style>{`@keyframes cbDraw { from { stroke-dashoffset: 14 } to { stroke-dashoffset: 0 } }`}</style>
    </button>
  );
}

// ── Tiny icons (inline SVG, no deps) ──────────────────────────────
const Icon = {
  search: (p) => (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" {...p}>
      <circle cx="7" cy="7" r="4.5" /><path d="M10.5 10.5L13.5 13.5" strokeLinecap="round"/>
    </svg>
  ),
  x: (p) => (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" {...p}>
      <path d="M4 4L12 12M12 4L4 12" strokeLinecap="round"/>
    </svg>
  ),
  check: (p) => (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" {...p}>
      <path d="M3 8L6.5 11.5L13 4.5" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  ),
  chevronDown: (p) => (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" {...p}>
      <path d="M4 6L8 10L12 6" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  ),
  chevronRight: (p) => (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" {...p}>
      <path d="M6 4L10 8L6 12" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  ),
  refresh: (p) => (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" {...p}>
      <path d="M13.5 3.5V6.5H10.5" strokeLinecap="round" strokeLinejoin="round"/>
      <path d="M2.5 12.5V9.5H5.5" strokeLinecap="round" strokeLinejoin="round"/>
      <path d="M13 6.5C12 4.5 10 3 7.5 3C5.5 3 3.7 4 2.8 5.5M3 9.5C4 11.5 6 13 8.5 13C10.5 13 12.3 12 13.2 10.5" strokeLinecap="round"/>
    </svg>
  ),
  mail: (p) => (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" {...p}>
      <rect x="2" y="3.5" width="12" height="9" rx="1"/><path d="M2.5 4.5L8 9L13.5 4.5" strokeLinecap="round"/>
    </svg>
  ),
  branch: (p) => (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" {...p}>
      <circle cx="4" cy="3" r="1.5"/><circle cx="4" cy="13" r="1.5"/><circle cx="12" cy="6" r="1.5"/>
      <path d="M4 4.5V11.5" strokeLinecap="round"/><path d="M4 7.5C4 6 5 6 6 6H10.5" strokeLinecap="round"/>
    </svg>
  ),
  alert: (p) => (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" {...p}>
      <path d="M8 2L14 13H2L8 2Z" strokeLinejoin="round"/><path d="M8 6V9" strokeLinecap="round"/><circle cx="8" cy="11" r="0.5" fill="currentColor"/>
    </svg>
  ),
  eye: (p) => (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" {...p}>
      <path d="M1.5 8C3 5 5.5 3.5 8 3.5C10.5 3.5 13 5 14.5 8C13 11 10.5 12.5 8 12.5C5.5 12.5 3 11 1.5 8Z"/>
      <circle cx="8" cy="8" r="2"/>
    </svg>
  ),
  eyeOff: (p) => (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" {...p}>
      <path d="M2 8C3.5 5 6 3.5 8 3.5M14 8C13 9.5 12 10.5 11 11.2M8 12.5C7 12.5 6 12.2 5 11.5" strokeLinecap="round"/>
      <path d="M2 2L14 14" strokeLinecap="round"/>
    </svg>
  ),
  minus: (p) => (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" {...p}>
      <path d="M3 8H13" strokeLinecap="round"/>
    </svg>
  ),
  stop: (p) => (
    <svg viewBox="0 0 16 16" fill="currentColor" {...p}><rect x="4" y="4" width="8" height="8"/></svg>
  ),
  code: (p) => (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" {...p}>
      <path d="M6 4L2 8L6 12M10 4L14 8L10 12" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  ),
  external: (p) => (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" {...p}>
      <path d="M9 3H13V7" strokeLinecap="round" strokeLinejoin="round"/>
      <path d="M13 3L7.5 8.5" strokeLinecap="round"/>
      <path d="M12 10V12.5C12 13 11.5 13.5 11 13.5H3.5C3 13.5 2.5 13 2.5 12.5V5C2.5 4.5 3 4 3.5 4H6" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  ),
  drag: (p) => (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" {...p}>
      <rect x="2" y="3" width="12" height="10" rx="1"/><path d="M2 6.5H14M2 9.5H14" strokeLinecap="round"/>
    </svg>
  ),
};

Object.assign(window, { StatusBadge, relDate, Checkbox, Icon });
