/**
 * Background Service Worker
 * Handles per-site NIP-46 connections with Amber
 * Each site (origin) gets its own independent connection
 */

import {
  createNIP46Request,
  generateSessionKeypair,
  type NIP46Session,
  parseNIP46Response,
} from "./lib/nip46.ts";
import { RelayPool } from "./lib/relay.ts";
import type { NostrEvent, SignedEvent, UnsignedEvent } from "./lib/nostr.ts";

// Per-site session data
interface SiteSession extends NIP46Session {
  host: string;
  userPubkey: string; // The actual Nostr pubkey of the user for this site
  connectedAt: number;
}

// Pending connection for a site
interface PendingConnection {
  host: string;
  uri: string;
  secret: string;
  session: NIP46Session;
  relayPool: RelayPool;
  resolve: (pubkey: string) => void;
  reject: (e: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

// State
const siteSessions: Map<string, SiteSession> = new Map();
const siteRelayPools: Map<string, RelayPool> = new Map();
const pendingRequests: Map<
  string,
  { host: string; resolve: (v: unknown) => void; reject: (e: Error) => void }
> = new Map();
let pendingConnection: PendingConnection | null = null;
// Track pending getPublicKey calls so multiple requests wait for the same connection
const pendingGetPubkeyPromises: Map<string, Promise<string>> = new Map();

// Storage keys
const STORAGE_KEY_SITES = "site_sessions";

// Default relay for nostrconnect
const DEFAULT_RELAYS = ["wss://relay.nsec.app"];

/**
 * Initialize on startup - restore sessions if available
 */
async function init() {
  try {
    const stored = await chrome.storage.local.get([STORAGE_KEY_SITES]);
    const storedSites = stored[STORAGE_KEY_SITES] as
      | Record<string, SiteSession>
      | undefined;

    if (storedSites) {
      for (const [host, session] of Object.entries(storedSites)) {
        siteSessions.set(host, session);
        await connectSiteToRelays(host, session);
      }
      console.log("[Background] Restored", siteSessions.size, "site sessions");
    }
  } catch (e) {
    console.error("[Background] Failed to restore sessions:", e);
  }
}

/**
 * Connect a site to its relays and subscribe for responses
 */
async function connectSiteToRelays(host: string, session: SiteSession) {
  // Close existing pool if any
  const existingPool = siteRelayPools.get(host);
  if (existingPool) {
    existingPool.close();
  }

  const relayPool = new RelayPool(session.relayUrls);
  await relayPool.connect();

  // Subscribe for responses from Amber for this site
  relayPool.subscribe(
    `nip46-${host}`,
    [
      {
        kinds: [24133],
        "#p": [session.localPubkey],
        since: Math.floor(Date.now() / 1000) - 60,
      },
    ],
    (event) => handleRelayEvent(host, event),
  );

  siteRelayPools.set(host, relayPool);
}

/**
 * Handle incoming NIP-46 response events for a specific site
 */
async function handleRelayEvent(host: string, event: NostrEvent) {
  console.log("[Background] Received event for", host, ":", {
    id: event.id,
    pubkey: event.pubkey,
    kind: event.kind,
  });

  // Check if this is for a pending connection
  if (pendingConnection && pendingConnection.host === host) {
    await handlePendingConnectionEvent(event);
    return;
  }

  const session = siteSessions.get(host);
  if (!session) {
    console.log("[Background] No session for", host);
    return;
  }

  try {
    const response = await parseNIP46Response(event as SignedEvent, session);
    console.log("[Background] Decrypted response:", response);

    // Check if this is from the expected remote
    if (event.pubkey !== session.remotePubkey) {
      console.log("[Background] Event from unknown pubkey");
      return;
    }

    const pending = pendingRequests.get(response.id);
    if (pending && pending.host === host) {
      pendingRequests.delete(response.id);

      if (response.error) {
        pending.reject(new Error(response.error));
      } else {
        pending.resolve(response.result);
      }
    }
  } catch (e) {
    console.log("[Background] Failed to parse event:", e);
  }
}

/**
 * Handle event during pending connection flow
 */
async function handlePendingConnectionEvent(event: NostrEvent) {
  if (!pendingConnection) return;

  const { session, secret, host } = pendingConnection;

  try {
    // Need to use the event pubkey as the remote for decryption
    const remotePubkey = session.remotePubkey || event.pubkey!;
    const tempSession = { ...session, remotePubkey };
    const response = await parseNIP46Response(
      event as SignedEvent,
      tempSession,
    );

    console.log("[Background] Pending connection response:", response);

    // Check if this is a connect response
    const isConnectResponse = response.result === "ack" ||
      response.result === secret;

    if (isConnectResponse) {
      console.log("[Background] Got connect response!");

      // Update session with remote pubkey
      session.remotePubkey = event.pubkey!;

      // Now get the user's pubkey and complete the connection
      await completeConnection();
      return;
    }

    // Check if this is a response to a pending request (like get_public_key)
    const pending = pendingRequests.get(response.id);
    if (pending && pending.host === host) {
      console.log("[Background] Got pending request response:", response.id);
      pendingRequests.delete(response.id);

      if (response.error) {
        pending.reject(new Error(response.error));
      } else {
        pending.resolve(response.result);
      }
    }
  } catch (e) {
    console.log("[Background] Failed to handle pending connection event:", e);
  }
}

/**
 * Complete the connection after receiving connect ack
 */
async function completeConnection() {
  if (!pendingConnection) return;

  const { session, host, relayPool } = pendingConnection;

  try {
    // Get user's pubkey
    const pubkey = await sendSiteRequest(
      host,
      session,
      relayPool,
      "get_public_key",
      [],
    );

    console.log("[Background] Got user pubkey:", pubkey);

    // Create the full site session
    const siteSession: SiteSession = {
      ...session,
      host,
      userPubkey: pubkey as string,
      connectedAt: Date.now(),
    };

    // Store the session
    siteSessions.set(host, siteSession);
    siteRelayPools.set(host, relayPool);

    // Subscribe for future events (replace pending subscription)
    relayPool.subscribe(
      `nip46-${host}`,
      [
        {
          kinds: [24133],
          "#p": [session.localPubkey],
          since: Math.floor(Date.now() / 1000) - 10,
        },
      ],
      (evt) => handleRelayEvent(host, evt),
    );

    await saveSessions();

    // Notify popup
    notifyPopup("connectionComplete", {
      host,
      pubkey: pubkey as string,
    });

    // Resolve the pending promise
    clearTimeout(pendingConnection.timeout);
    pendingConnection.resolve(pubkey as string);
    pendingConnection = null;

    console.log("[Background] Site connected:", host, "pubkey:", pubkey);
  } catch (e) {
    console.error("[Background] Failed to complete connection:", e);
    notifyPopup("connectionFailed", { error: String(e) });
  }
}

/**
 * Send a NIP-46 request for a specific site
 */
async function sendSiteRequest(
  host: string,
  session: NIP46Session,
  relayPool: RelayPool,
  method: string,
  params: string[],
  timeoutMs = 60000,
): Promise<unknown> {
  console.log("[Background] Sending request for", host, ":", {
    method,
    params,
  });

  const { event, requestId } = await createNIP46Request(
    session,
    method,
    params,
  );

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingRequests.delete(requestId);
      reject(new Error("Request timeout"));
    }, timeoutMs);

    pendingRequests.set(requestId, {
      host,
      resolve: (v) => {
        clearTimeout(timeout);
        resolve(v);
      },
      reject: (e) => {
        clearTimeout(timeout);
        reject(e);
      },
    });

    relayPool.publish(event);
  });
}

/**
 * Start connection flow for a site - generates QR code URI
 */
async function startSiteConnection(host: string): Promise<{ uri: string }> {
  // If there's already a pending connection for THIS host, reuse it
  if (pendingConnection && pendingConnection.host === host) {
    console.log("[Background] Reusing existing pending connection for", host);
    return { uri: pendingConnection.uri };
  }

  // If there's a pending connection for a DIFFERENT host, cancel it
  if (pendingConnection && pendingConnection.host !== host) {
    cancelPendingConnection();
  }

  const keypair = await generateSessionKeypair();
  const relayUrls = DEFAULT_RELAYS;

  // Generate random secret
  const secretBytes = new Uint8Array(16);
  crypto.getRandomValues(secretBytes);
  const secret = Array.from(secretBytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  // Create session
  const session: NIP46Session = {
    localPrivkey: keypair.privkey,
    localPubkey: keypair.pubkey,
    remotePubkey: "", // Will be set when Amber responds
    relayUrls,
    secret,
  };

  // Connect to relays
  const relayPool = new RelayPool(relayUrls);
  await relayPool.connect();

  // Subscribe for connect response
  relayPool.subscribe(
    `pending-${host}`,
    [
      {
        kinds: [24133],
        "#p": [keypair.pubkey],
        since: Math.floor(Date.now() / 1000) - 10,
      },
    ],
    (event) => handlePendingConnectionEvent(event),
  );

  // Build nostrconnect URI
  // Use host as the app name so Amber shows which site is connecting
  const metadata = JSON.stringify({
    name: `${host} (Remote NIP-07)`,
    description: "Remote NIP-07 Signer",
    url: `https://${host}`,
  });

  const params = new URLSearchParams();
  for (const relay of relayUrls) {
    params.append("relay", relay);
  }
  params.append("secret", secret);
  params.append("metadata", metadata);

  const uri = `nostrconnect://${keypair.pubkey}?${params.toString()}`;

  console.log("[Background] Generated nostrconnect URI for", host);

  // Store pending connection
  pendingConnection = {
    host,
    uri,
    secret,
    session,
    relayPool,
    resolve: () => {},
    reject: () => {},
    timeout: setTimeout(() => {}, 0),
  };

  return { uri };
}

/**
 * Wait for pending connection to complete
 */
function awaitSiteConnection(timeoutMs = 300000): Promise<{ pubkey: string }> {
  return new Promise((resolve, reject) => {
    if (!pendingConnection) {
      reject(new Error("No pending connection"));
      return;
    }

    const timeout = setTimeout(() => {
      if (pendingConnection) {
        pendingConnection.relayPool.close();
        pendingConnection = null;
      }
      notifyPopup("connectionFailed", { error: "Connection timeout" });
      reject(new Error("Connection timeout"));
    }, timeoutMs);

    pendingConnection.timeout = timeout;
    pendingConnection.resolve = (pubkey) => resolve({ pubkey });
    pendingConnection.reject = reject;
  });
}

/**
 * Cancel pending connection
 */
function cancelPendingConnection() {
  if (pendingConnection) {
    clearTimeout(pendingConnection.timeout);
    pendingConnection.relayPool.close();
    pendingConnection.reject(new Error("Cancelled"));
    pendingConnection = null;
  }
}

/**
 * Remove a site's session
 */
async function removeSite(host: string) {
  const pool = siteRelayPools.get(host);
  if (pool) {
    pool.close();
    siteRelayPools.delete(host);
  }

  siteSessions.delete(host);
  await saveSessions();

  console.log("[Background] Removed site:", host);
}

/**
 * Get public key for a site (may trigger connection flow)
 * Multiple calls for the same host will share the same pending connection
 */
async function getPublicKeyForSite(host: string): Promise<string> {
  // Already connected?
  const session = siteSessions.get(host);
  if (session) {
    return session.userPubkey;
  }

  // Already have a pending promise for this host?
  const existingPromise = pendingGetPubkeyPromises.get(host);
  if (existingPromise) {
    console.log("[Background] Reusing existing pending connection for", host);
    return existingPromise;
  }

  // If there's a pending connection for a DIFFERENT host, cancel it
  if (pendingConnection && pendingConnection.host !== host) {
    cancelPendingConnection();
  }

  // Create a new promise for this connection
  const connectionPromise = (async () => {
    try {
      // If already have pending connection for this host, reuse its URI
      let uri: string;
      if (pendingConnection && pendingConnection.host === host) {
        uri = pendingConnection.uri;
      } else {
        const result = await startSiteConnection(host);
        uri = result.uri;
      }

      // Open popup to show QR code
      await openPopupWithQR(host, uri);

      // Wait for connection
      const { pubkey } = await awaitSiteConnection();
      return pubkey;
    } finally {
      // Clean up the pending promise
      pendingGetPubkeyPromises.delete(host);
    }
  })();

  pendingGetPubkeyPromises.set(host, connectionPromise);
  return connectionPromise;
}

/**
 * Sign event for a site
 */
async function signEventForSite(
  host: string,
  event: UnsignedEvent,
): Promise<SignedEvent> {
  const session = siteSessions.get(host);
  const relayPool = siteRelayPools.get(host);

  if (!session || !relayPool) {
    // Need to connect first
    await getPublicKeyForSite(host);

    // Now try again
    const newSession = siteSessions.get(host);
    const newPool = siteRelayPools.get(host);

    if (!newSession || !newPool) {
      throw new Error("Failed to connect");
    }

    const result = await sendSiteRequest(
      newSession.host,
      newSession,
      newPool,
      "sign_event",
      [
        JSON.stringify(event),
      ],
    );

    return JSON.parse(result as string) as SignedEvent;
  }

  const result = await sendSiteRequest(host, session, relayPool, "sign_event", [
    JSON.stringify(event),
  ]);

  return JSON.parse(result as string) as SignedEvent;
}

/**
 * Get status for popup
 */
function getStatus(): {
  sites: Record<string, { host: string; pubkey: string; connectedAt: number }>;
  pendingConnection: { host: string; uri: string } | null;
} {
  const sites: Record<
    string,
    { host: string; pubkey: string; connectedAt: number }
  > = {};

  for (const [host, session] of siteSessions.entries()) {
    sites[host] = {
      host,
      pubkey: session.userPubkey,
      connectedAt: session.connectedAt,
    };
  }

  return {
    sites,
    pendingConnection: pendingConnection
      ? { host: pendingConnection.host, uri: pendingConnection.uri }
      : null,
  };
}

/**
 * Save sessions to storage
 */
async function saveSessions() {
  const toStore: Record<string, SiteSession> = {};

  for (const [host, session] of siteSessions.entries()) {
    toStore[host] = session;
  }

  await chrome.storage.local.set({ [STORAGE_KEY_SITES]: toStore });
}

/**
 * Open popup and show QR code
 */
async function openPopupWithQR(_host: string, _uri: string) {
  // The popup will check for pending connection and display QR
  try {
    await chrome.action.openPopup();
  } catch (e) {
    // openPopup may not be available in all contexts
    // The pending connection will still be shown when user opens popup manually
    console.log("[Background] Could not auto-open popup:", e);
  }
}

/**
 * Notify popup of events
 */
function notifyPopup(type: string, data: Record<string, unknown>) {
  chrome.runtime.sendMessage({ type, ...data }).catch(() => {
    // Popup might not be open
  });
}

// Message types
interface ExtensionMessage {
  type: string;
  host?: string;
  event?: UnsignedEvent;
}

/**
 * Extract host from sender
 */
function getSenderHost(sender: chrome.runtime.MessageSender): string | null {
  if (sender.url) {
    try {
      const url = new URL(sender.url);
      return url.host;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Message handler
 */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const message = msg as ExtensionMessage;

  const handleAsync = async () => {
    try {
      switch (message.type) {
        // From content script
        case "getPublicKey": {
          const host = getSenderHost(sender);
          if (!host) throw new Error("Could not determine site host");
          return await getPublicKeyForSite(host);
        }

        case "signEvent": {
          const host = getSenderHost(sender);
          if (!host) throw new Error("Could not determine site host");
          return await signEventForSite(host, message.event!);
        }

        // From popup
        case "getStatus":
          return getStatus();

        case "removeSite":
          await removeSite(message.host!);
          return { success: true };

        case "cancelPendingConnection":
          cancelPendingConnection();
          return { success: true };

        default:
          throw new Error(`Unknown message type: ${message.type}`);
      }
    } catch (e) {
      console.error("[Background] Error:", e);
      throw e;
    }
  };

  handleAsync()
    .then((result) => sendResponse({ success: true, result }))
    .catch((e) => sendResponse({ success: false, error: e.message }));

  return true; // Keep channel open for async response
});

// Initialize on load
init();

// Keep service worker alive
chrome.alarms.create("keepalive", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "keepalive") {
    // Reconnect any disconnected pools
    for (const [host, session] of siteSessions.entries()) {
      const pool = siteRelayPools.get(host);
      if (!pool) {
        connectSiteToRelays(host, session);
      }
    }
  }
});
