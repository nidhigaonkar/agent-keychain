const { BrowserUse } = require("browser-use-sdk/v4");

async function fetchStripeLinkStatus(apiKey) {
  const res = await fetch("https://api.browser-use.com/api/v4/stripe-link", {
    headers: { "X-Browser-Use-API-Key": apiKey },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Browser Use stripe-link status failed (${res.status}): ${text}`);
  }
  return res.json();
}

async function resolveStripeLinkConnectionId(apiKey) {
  if (process.env.BROWSER_USE_STRIPE_LINK_CONNECTION_ID) {
    return process.env.BROWSER_USE_STRIPE_LINK_CONNECTION_ID;
  }
  const status = await fetchStripeLinkStatus(apiKey);
  if (!status.isConnected || !status.connectionId) {
    return null;
  }
  return status.connectionId;
}

const APPROVAL_URL_RE = /https:\/\/app\.link\.com[^\s"'<>\\]*/g;
const RUN_UI_BASE = "https://cloud.browser-use.com/runs";

async function fetchRunEvents(apiKey, runId, { afterId = 0 } = {}) {
  const url = new URL(`https://api.browser-use.com/api/v4/runs/${runId}/events`);
  if (afterId) url.searchParams.set("after", String(afterId));
  url.searchParams.set("limit", "100");
  const res = await fetch(url, {
    headers: { "X-Browser-Use-API-Key": apiKey },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Browser Use run events failed (${res.status}): ${text}`);
  }
  const body = await res.json();
  return body.events || body;
}

function extractApprovalSignals(events) {
  const urls = new Set();
  let spendRequestId = null;
  let needsApproval = false;

  for (const event of events) {
    const blob = JSON.stringify(event);
    for (const m of blob.matchAll(APPROVAL_URL_RE)) urls.add(m[0]);
    const lsrq = blob.match(/lsrq_[A-Za-z0-9]+/);
    if (lsrq) spendRequestId = lsrq[0];
    if (/requires_action|approval_url|approve button|approval is needed/i.test(blob)) {
      needsApproval = true;
    }
  }

  return { urls: [...urls], spendRequestId, needsApproval };
}

async function watchRunForApproval(apiKey, runId, { onApprovalNeeded, pollMs = 2000 } = {}) {
  let lastEventId = 0;
  const seenUrls = new Set();
  let stopped = false;

  const stop = () => {
    stopped = true;
  };

  const loop = async () => {
    while (!stopped) {
      try {
        const events = await fetchRunEvents(apiKey, runId, { afterId: lastEventId });
        if (events.length) {
          lastEventId = events[events.length - 1].id;
          const { urls, spendRequestId, needsApproval } = extractApprovalSignals(events);
          for (const url of urls) {
            if (!seenUrls.has(url)) {
              seenUrls.add(url);
              onApprovalNeeded({ type: "approval_url", url, spendRequestId, runId });
            }
          }
          if (needsApproval && !urls.length) {
            onApprovalNeeded({ type: "needs_approval", spendRequestId, runId });
          }
        }
      } catch {
        // keep polling until run completes
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
  };

  loop();
  return { stop };
}

function runUiUrl(runId) {
  return `${RUN_UI_BASE}/${runId}`;
}

async function waitForLiveViewUrl(apiKey, runId, { timeoutMs = 120_000, pollMs = 2000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastEventId = 0;
  while (Date.now() < deadline) {
    const events = await fetchRunEvents(apiKey, runId, { afterId: lastEventId });
    if (events.length) lastEventId = events[events.length - 1].id;
    const ready = events.find((e) => e.type === "browser.ready");
    if (ready?.data?.live_view_url) return ready.data.live_view_url;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return null;
}

module.exports = {
  fetchStripeLinkStatus,
  resolveStripeLinkConnectionId,
  fetchRunEvents,
  extractApprovalSignals,
  watchRunForApproval,
  runUiUrl,
  waitForLiveViewUrl,
};
