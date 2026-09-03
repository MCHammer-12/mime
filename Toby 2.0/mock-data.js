// Mock Klaviyo-style data. Realistic shapes matching the API contract.

const FLOW_NAMES = [
  "Welcome Series", "Abandoned Cart", "Browse Abandonment", "Post-Purchase Thank You",
  "Win-Back 60 Day", "Win-Back 120 Day", "Birthday", "VIP Early Access",
  "Back In Stock", "Price Drop Alert", "Review Request", "Replenishment - Skincare",
  "Replenishment - Supplements", "First Purchase Follow-up", "Shipping Confirmation Upsell",
  "Cart to Checkout Nudge", "New Subscriber Double Opt-in", "Sunset Inactive 180d",
  "Post-Delivery Care Guide", "Loyalty Tier Upgrade", "Quiz Completion Series",
  "Wholesale Lead Nurture", "Sample Request Follow-up", "Subscription Renewal 7d",
  "Subscription Renewal 1d", "Subscription Failed Payment", "Referral Invite",
  "Referral Reward Issued", "Quick Ship Reminder", "Gift Card Purchased",
  "Gift Card Recipient", "Black Friday Early Access", "Holiday Gift Guide",
];

const TRIGGER_TYPES = ["list", "segment", "metric", "price_drop", "back_in_stock", "date_property"];
const STATUSES = ["live", "live", "live", "live", "draft", "manual", "disabled"];

const TEMPLATE_PREFIXES = [
  "Newsletter", "Product Launch", "Announcement", "Sale", "Collection",
  "Founder Note", "Digest", "Editorial", "Behind the Scenes", "Customer Story",
];
const TEMPLATE_SUFFIXES = [
  "v1", "v2", "v3", "Draft", "Final", "A", "B", "Q1", "Q2", "Q3", "Q4",
  "2024", "2025", "Mobile", "Desktop", "Test", "Backup", "Archive",
];

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

function seededRandom(seed) {
  let x = seed;
  return () => {
    x = (x * 1664525 + 1013904223) % 4294967296;
    return x / 4294967296;
  };
}

function makeMockData() {
  const rand = seededRandom(42);
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const daysAgo = (n) => {
    const d = new Date();
    d.setDate(d.getDate() - n);
    return d.toISOString();
  };

  // 30 flows
  const flows = FLOW_NAMES.slice(0, 30).map((name, i) => {
    const emailCount = 1 + Math.floor(rand() * 5);
    const emails = Array.from({ length: emailCount }, (_, j) => ({
      templateId: `tmpl_${i}_${j}_${Math.floor(rand() * 100000)}`,
      messageId: `msg_${i}_${j}`,
      actionId: `act_${i}_${j}`,
      name: `${name} · Email ${j + 1}`,
    }));
    return {
      flowId: `flow_${(1000 + i).toString(36)}${Math.floor(rand() * 9999)}`,
      flowName: name,
      flowStatus: pick(STATUSES),
      triggerType: pick(TRIGGER_TYPES),
      emails,
      updated: daysAgo(Math.floor(rand() * 400)),
    };
  });

  // ~80 templates
  const templates = [];
  for (let i = 0; i < 82; i++) {
    const prefix = pick(TEMPLATE_PREFIXES);
    const suffix = pick(TEMPLATE_SUFFIXES);
    const monthName = pick(MONTHS);
    const name = rand() < 0.3
      ? `${prefix} — ${monthName} ${suffix}`
      : `${prefix} ${suffix}`;
    templates.push({
      id: `tmpl_standalone_${i}_${Math.floor(rand() * 100000)}`,
      name,
      editorType: rand() < 0.7 ? "SYSTEM_DRAGGABLE" : "CODE",
      updated: daysAgo(Math.floor(rand() * 500)),
    });
  }

  return { flows, templates };
}

// Simulated prior-run state: pretend these IDs were imported before.
// In a real app this would come from Redo's side.
const PRIOR_IMPORTED_FLOW_IDS = new Set([
  // mark ~5 flows as already imported (indices 0, 3, 7, 12, 18)
]);
const PRIOR_IMPORTED_TEMPLATE_IDS = new Set([]);

function populatePriorImported(data) {
  [0, 3, 7, 12, 18].forEach(i => {
    if (data.flows[i]) PRIOR_IMPORTED_FLOW_IDS.add(data.flows[i].flowId);
  });
  [2, 11, 19, 27, 44, 51, 68].forEach(i => {
    if (data.templates[i]) PRIOR_IMPORTED_TEMPLATE_IDS.add(data.templates[i].id);
  });
}

const MOCK_DATA = makeMockData();
populatePriorImported(MOCK_DATA);

// Matches the real POST /api/flows response which includes a debug field.
MOCK_DATA.debug = {
  rawFlowCount: MOCK_DATA.flows.length,
  flowsWithNoEmails: 0,
  messagesFetched: MOCK_DATA.flows.reduce((s, f) => s + f.emails.length, 0),
};

window.MOCK_DATA = MOCK_DATA;
window.PRIOR_IMPORTED_FLOW_IDS = PRIOR_IMPORTED_FLOW_IDS;
window.PRIOR_IMPORTED_TEMPLATE_IDS = PRIOR_IMPORTED_TEMPLATE_IDS;
