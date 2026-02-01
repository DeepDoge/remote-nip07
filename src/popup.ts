/**
 * Popup Script
 * Handles UI for connecting to Amber via bunker URI or nostrconnect QR
 */

// Declare qrcode-generator from the library
declare function qrcode(
  typeNumber: number,
  errorCorrectionLevel: string,
): {
  addData(data: string): void;
  make(): void;
  createDataURL(cellSize?: number, margin?: number): string;
  createImgTag(cellSize?: number, margin?: number): string;
};

// Elements
const connectedView = document.getElementById("connected-view")!;
const disconnectedView = document.getElementById("disconnected-view")!;
const displayPubkey = document.getElementById("display-pubkey")!;
const bunkerInput = document.getElementById("bunker-input") as HTMLInputElement;
const connectBtn = document.getElementById("connect-btn")!;
const disconnectBtn = document.getElementById("disconnect-btn")!;
const errorMessage = document.getElementById("error-message")!;

// QR/Nostrconnect elements
const tabs = document.querySelectorAll(".tab");
const tabQr = document.getElementById("tab-qr")!;
const tabPaste = document.getElementById("tab-paste")!;
const generateQrBtn = document.getElementById("generate-qr-btn")!;
const cancelBtn = document.getElementById("cancel-btn")!;
const qrWrapper = document.getElementById("qr-wrapper")!;
const qrImage = document.getElementById("qr-image") as HTMLImageElement;
const waitingMessage = document.getElementById("waiting-message")!;

// Shorten pubkey for display
function shortenPubkey(pubkey: string): string {
  if (pubkey.length < 16) return pubkey;
  return `${pubkey.slice(0, 8)}...${pubkey.slice(-8)}`;
}

// Show error
function showError(message: string) {
  errorMessage.textContent = message;
  errorMessage.classList.remove("hidden");
}

// Hide error
function hideError() {
  errorMessage.classList.add("hidden");
}

// Set loading state
function setLoading(loading: boolean) {
  if (loading) {
    connectBtn.innerHTML =
      `<span class="loading"><span class="spinner"></span>Connecting...</span>`;
    connectBtn.setAttribute("disabled", "true");
    bunkerInput.setAttribute("disabled", "true");
  } else {
    connectBtn.innerHTML = `<span class="btn-text">Connect to Amber</span>`;
    connectBtn.removeAttribute("disabled");
    bunkerInput.removeAttribute("disabled");
  }
}

// Status type from background
type ConnectionState = "idle" | "awaiting_connection" | "connected";
interface Status {
  state: ConnectionState;
  pubkey: string | null;
  relays: string[];
  nostrConnectUri: string | null;
}

// Update UI based on connection status
function updateUI(status: Status) {
  hideError();

  if (status.state === "connected" && status.pubkey) {
    // Connected state
    connectedView.classList.remove("hidden");
    disconnectedView.classList.add("hidden");
    displayPubkey.textContent = shortenPubkey(status.pubkey);
    resetQrState();
  } else if (status.state === "awaiting_connection" && status.nostrConnectUri) {
    // Awaiting connection - show QR
    connectedView.classList.add("hidden");
    disconnectedView.classList.remove("hidden");

    // Switch to QR tab and show the QR code
    tabs.forEach((t) => t.classList.remove("active"));
    document.querySelector('[data-tab="qr"]')?.classList.add("active");
    tabQr.classList.add("active");
    tabPaste.classList.remove("active");

    // Generate QR code from stored URI
    const qr = qrcode(0, "M");
    qr.addData(status.nostrConnectUri);
    qr.make();
    qrImage.src = qr.createDataURL(5, 2);

    qrWrapper.classList.remove("hidden");
    waitingMessage.classList.remove("hidden");
    generateQrBtn.classList.add("hidden");
    cancelBtn.classList.remove("hidden");

    // Start awaiting connection (unless already waiting)
    if (!isAwaitingConnection) {
      awaitConnectionInBackground();
    }
  } else {
    // Idle state
    connectedView.classList.add("hidden");
    disconnectedView.classList.remove("hidden");
    resetQrState();
  }
}

// Track if we're already awaiting connection
let isAwaitingConnection = false;

// Await connection in background (non-blocking for UI)
async function awaitConnectionInBackground() {
  if (isAwaitingConnection) return;
  isAwaitingConnection = true;

  try {
    const result = await sendMessage<{ pubkey: string }>({
      type: "awaitNostrConnect",
    });

    // Refresh status on success
    const status = await sendMessage<Status>({ type: "getStatus" });
    updateUI(status);
  } catch (e) {
    if ((e as Error).message !== "Cancelled") {
      showError(e instanceof Error ? e.message : "Connection failed");
    }
    // Refresh status
    const status = await sendMessage<Status>({ type: "getStatus" });
    updateUI(status);
  } finally {
    isAwaitingConnection = false;
  }
}

// Response type from background
interface BackgroundResponse<T> {
  success: boolean;
  result?: T;
  error?: string;
}

// Send message to background
async function sendMessage<T>(message: Record<string, unknown>): Promise<T> {
  const response = await chrome.runtime.sendMessage(
    message,
  ) as BackgroundResponse<T>;
  if (!response.success) {
    throw new Error(response.error || "Unknown error");
  }
  return response.result as T;
}

// Connect handler
async function handleConnect() {
  const bunkerUri = bunkerInput.value.trim();

  if (!bunkerUri) {
    showError("Please enter a bunker URI");
    return;
  }

  if (!bunkerUri.startsWith("bunker://")) {
    showError("Invalid bunker URI format");
    return;
  }

  hideError();
  setLoading(true);

  try {
    await sendMessage<{ pubkey: string }>({
      type: "connect",
      bunkerUri,
    });

    // Refresh status
    const status = await sendMessage<Status>({ type: "getStatus" });
    updateUI(status);
    bunkerInput.value = "";
  } catch (e) {
    showError(e instanceof Error ? e.message : "Connection failed");
  } finally {
    setLoading(false);
  }
}

// Disconnect handler
async function handleDisconnect() {
  try {
    await sendMessage({ type: "disconnect" });
    // Refresh status
    const status = await sendMessage<Status>({ type: "getStatus" });
    updateUI(status);
  } catch (e) {
    showError(
      e instanceof Error
        ? e
          .message
        : "Disconnect failed",
    );
  }
}

// Initialize
async function init() {
  try {
    const status = await sendMessage<Status>({
      type: "getStatus",
    });
    updateUI(status);
  } catch (e) {
    console.error("Failed to get status:", e);
    updateUI({
      state: "idle",
      pubkey: null,
      relays: [],
      nostrConnectUri: null,
    });
  }
}

// Event listeners
connectBtn.addEventListener("click", handleConnect);
disconnectBtn.addEventListener("click", handleDisconnect);
generateQrBtn.addEventListener("click", handleGenerateQr);
cancelBtn.addEventListener("click", handleCancelQr);

// Tab switching
tabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    const tabName = (tab as HTMLElement).dataset.tab;
    tabs.forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");

    if (tabName === "qr") {
      tabQr.classList.add("active");
      tabPaste.classList.remove("active");
    } else {
      tabQr.classList.remove("active");
      tabPaste.classList.add("active");
    }
  });
});

bunkerInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    handleConnect();
  }
});

// Handle paste - auto-connect if valid bunker URI is pasted
bunkerInput.addEventListener("paste", () => {
  setTimeout(() => {
    const value = bunkerInput.value.trim();
    if (value.startsWith("bunker://") && value.includes("relay=")) {
      handleConnect();
    }
  }, 100);
});

// Generate QR code handler
async function handleGenerateQr() {
  hideError();

  try {
    // Start nostrconnect flow - this generates the URI and sets state
    await sendMessage<{ uri: string; secret: string }>({
      type: "startNostrConnect",
    });

    // Refresh status - this will show the QR and start awaiting
    const status = await sendMessage<Status>({ type: "getStatus" });
    updateUI(status);
  } catch (e) {
    showError(e instanceof Error ? e.message : "Failed to generate QR");
    resetQrState();
  }
}

// Cancel QR handler
async function handleCancelQr() {
  try {
    await sendMessage({ type: "cancelNostrConnect" });
  } catch {
    // Ignore errors
  }
  // Refresh status
  try {
    const status = await sendMessage<Status>({ type: "getStatus" });
    updateUI(status);
  } catch {
    resetQrState();
  }
}

// Reset QR UI state
function resetQrState() {
  qrWrapper.classList.add("hidden");
  waitingMessage.classList.add("hidden");
  generateQrBtn.classList.remove("hidden");
  cancelBtn.classList.add("hidden");
}

// Start
init();
