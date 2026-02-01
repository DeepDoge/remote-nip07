/**
 * Popup Script
 * Shows current site's connection status and manages all connected sites
 */

import qrcode from "qrcode-generator";

interface SiteSession {
  host: string;
  pubkey: string;
  connectedAt: number;
}

interface StatusResponse {
  sites: Record<string, SiteSession>;
  pendingConnection: { host: string; uri: string } | null;
  currentTab: { host: string } | null;
}

// Elements
const pageCurrent = document.getElementById("pageCurrent") as HTMLDivElement;
const pageList = document.getElementById("pageList") as HTMLDivElement;
const currentHostEl = document.getElementById("currentHost") as HTMLElement;
const stateConnected = document.getElementById(
  "stateConnected",
) as HTMLDivElement;
const stateQR = document.getElementById("stateQR") as HTMLDivElement;
const stateNotConnected = document.getElementById(
  "stateNotConnected",
) as HTMLDivElement;
const connectedPubkeyEl = document.getElementById(
  "connectedPubkey",
) as HTMLDivElement;
const qrCanvas = document.getElementById("qrCanvas") as HTMLCanvasElement;
const siteListEl = document.getElementById("siteList") as HTMLDivElement;
const btnShowList = document.getElementById("btnShowList") as HTMLButtonElement;
const btnBack = document.getElementById("btnBack") as HTMLDivElement;
const btnDisconnect = document.getElementById(
  "btnDisconnect",
) as HTMLButtonElement;

let currentHost: string | null = null;

/**
 * Initialize popup
 */
async function init() {
  // Get current tab's host
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tabs[0]?.url) {
    try {
      const url = new URL(tabs[0].url);
      currentHost = url.host;
      currentHostEl.textContent = currentHost;
    } catch {
      currentHost = null;
      currentHostEl.textContent = "-";
    }
  }

  // Load status and update UI
  await loadStatus();

  // Setup event listeners
  btnShowList.addEventListener("click", showListPage);
  btnBack.addEventListener("click", showCurrentPage);
  btnDisconnect.addEventListener("click", disconnectCurrentSite);
}

/**
 * Load status from background
 */
async function loadStatus() {
  try {
    const response = await chrome.runtime.sendMessage({ type: "getStatus" });

    if (!response.success) {
      console.error("Failed to get status:", response.error);
      return;
    }

    const status = response.result as StatusResponse;
    updateCurrentSiteUI(status);
    renderSiteList(status.sites);
  } catch (e) {
    console.error("Error loading status:", e);
  }
}

/**
 * Update the current site UI based on status
 */
async function updateCurrentSiteUI(status: StatusResponse) {
  // Hide all states first
  stateConnected.style.display = "none";
  stateQR.style.display = "none";
  stateNotConnected.style.display = "none";

  if (!currentHost) {
    stateNotConnected.style.display = "block";
    return;
  }

  // Check if there's a pending connection for this host
  if (
    status.pendingConnection && status.pendingConnection.host === currentHost
  ) {
    stateQR.style.display = "block";
    showQRCode(status.pendingConnection.uri);
    return;
  }

  // Check if this site is connected
  const siteSession = status.sites[currentHost];
  if (siteSession) {
    stateConnected.style.display = "block";
    connectedPubkeyEl.textContent = truncatePubkey(siteSession.pubkey);
    return;
  }

  // Not connected
  stateNotConnected.style.display = "block";
}

/**
 * Show QR code
 */
function showQRCode(uri: string) {
  const qr = qrcode(0, "M");
  qr.addData(uri);
  qr.make();

  const moduleCount = qr.getModuleCount();
  const cellSize = Math.floor(200 / moduleCount);
  const size = cellSize * moduleCount;

  qrCanvas.width = size;
  qrCanvas.height = size;

  const ctx = qrCanvas.getContext("2d")!;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, size, size);

  ctx.fillStyle = "#000000";
  for (let row = 0; row < moduleCount; row++) {
    for (let col = 0; col < moduleCount; col++) {
      if (qr.isDark(row, col)) {
        ctx.fillRect(col * cellSize, row * cellSize, cellSize, cellSize);
      }
    }
  }
}

/**
 * Render the sites list
 */
function renderSiteList(sites: Record<string, SiteSession>) {
  const entries = Object.entries(sites);

  if (entries.length === 0) {
    siteListEl.innerHTML =
      `<div class="empty-list">No sites connected yet.</div>`;
    return;
  }

  siteListEl.innerHTML = entries
    .sort((a, b) => b[1].connectedAt - a[1].connectedAt)
    .map(
      ([host, session]) => `
      <div class="site-item" data-host="${escapeHtml(host)}">
        <div class="site-info">
          <div class="site-host">${escapeHtml(host)}</div>
          <div class="site-pubkey">${truncatePubkey(session.pubkey)}</div>
        </div>
        <button class="btn-remove" data-host="${
        escapeHtml(host)
      }">Remove</button>
      </div>
    `,
    )
    .join("");

  // Add click handlers
  siteListEl.querySelectorAll(".btn-remove").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      const host = (e.target as HTMLButtonElement).dataset.host;
      if (host) {
        await removeSite(host);
      }
    });
  });
}

/**
 * Disconnect current site
 */
async function disconnectCurrentSite() {
  if (!currentHost) return;
  await removeSite(currentHost);
}

/**
 * Remove a site
 */
async function removeSite(host: string) {
  try {
    const response = await chrome.runtime.sendMessage({
      type: "removeSite",
      host,
    });
    if (response.success) {
      await loadStatus();
    }
  } catch (e) {
    console.error("Error removing site:", e);
  }
}

/**
 * Show list page
 */
function showListPage() {
  pageCurrent.classList.remove("active");
  pageList.classList.add("active");
}

/**
 * Show current page
 */
function showCurrentPage() {
  pageList.classList.remove("active");
  pageCurrent.classList.add("active");
}

/**
 * Truncate pubkey for display
 */
function truncatePubkey(pubkey: string): string {
  if (pubkey.length <= 16) return pubkey;
  return `${pubkey.slice(0, 8)}...${pubkey.slice(-8)}`;
}

/**
 * Escape HTML
 */
function escapeHtml(str: string): string {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// Listen for updates from background
chrome.runtime.onMessage.addListener((message) => {
  if (
    message.type === "connectionComplete" || message.type === "connectionFailed"
  ) {
    loadStatus();
  }
});

// Initialize
init();
