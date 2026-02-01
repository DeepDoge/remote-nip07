/**
 * Background Service Worker
 * Handles NIP-46 communication with Amber and manages extension state
 */

import {
  createNIP46Request,
  generateSessionKeypair,
  type NIP46Session,
  parseBunkerUri,
  parseNIP46Response,
} from "./lib/nip46.ts";
import { RelayPool } from "./lib/relay.ts";
import type { NostrEvent, SignedEvent, UnsignedEvent } from "./lib/nostr.ts";

// State
type ConnectionState = "idle" | "awaiting_connection" | "connected";
let connectionState: ConnectionState = "idle";
let nostrConnectUri: string | null = null;
let session: NIP46Session | null = null;
let relayPool: RelayPool | null = null;
let remotePubkey: string | null = null;
let pendingNostrConnect: {
  resolve: (pubkey: string) => void;
  reject: (e: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
} | null = null;
const pendingRequests: Map<
  string,
  { resolve: (v: unknown) => void; reject: (e: Error) => void }
> = new Map();

// Storage keys
const STORAGE_KEY_SESSION = "nip46_session";
const STORAGE_KEY_PUBKEY = "remote_pubkey";

/**
 * Initialize on startup - restore session if available
 */
async function init() {
  try {
    const stored = await chrome.storage.local.get([
      STORAGE_KEY_SESSION,
      STORAGE_KEY_PUBKEY,
    ]);

    if (stored[STORAGE_KEY_SESSION] && stored[STORAGE_KEY_PUBKEY]) {
      session = stored[STORAGE_KEY_SESSION] as NIP46Session;
      remotePubkey = stored[STORAGE_KEY_PUBKEY] as string;
      connectionState = "connected";
      await connectToRelays();
      console.log("[Background] Session restored");
    }
  } catch (e) {
    console.error("[Background] Failed to restore session:", e);
  }
}

/**
 * Connect to relays and subscribe for responses
 */
async function connectToRelays() {
  if (!session) return;

  if (relayPool) {
    relayPool.close();
  }

  relayPool = new RelayPool(session.relayUrls);
  await relayPool.connect();

  // Subscribe for responses from Amber
  relayPool.subscribe(
    "nip46-responses",
    [
      {
        kinds: [24133],
        "#p": [session.localPubkey],
        since: Math.floor(Date.now() / 1000) - 60,
      },
    ],
    handleRelayEvent,
  );
}

/**
 * Handle incoming NIP-46 response events
 */
async function handleRelayEvent(event: NostrEvent) {
  console.log("[Background] Received event:", {
    id: event.id,
    pubkey: event.pubkey,
    kind: event.kind,
    contentLength: event.content?.length,
  });

  if (!session) {
    console.log("[Background] No session, ignoring event");
    return;
  }

  console.log("[Background] Session state:", {
    localPubkey: session.localPubkey,
    remotePubkey: session.remotePubkey || "(not set)",
    hasPendingNostrConnect: !!pendingNostrConnect,
    pendingRequestIds: Array.from(pendingRequests.keys()),
  });

  try {
    console.log("[Background] Attempting to decrypt...");
    const response = await parseNIP46Response(event as SignedEvent, session);
    console.log("[Background] Decrypted response:", response);

    // Handle connect response for nostrconnect flow
    // NIP-46: result is "ack" OR the secret value we sent
    const isConnectResponse = pendingNostrConnect && (
      response.result === "ack" ||
      (session.secret && response.result === session.secret)
    );

    if (isConnectResponse) {
      console.log("[Background] Got connect response for nostrconnect!");
      // Amber connected! Store the remote pubkey
      session.remotePubkey = event.pubkey!;

      // Get the user's pubkey
      console.log("[Background] Requesting user pubkey...");
      const pubkey = (await sendRequest("get_public_key", [])) as string;
      console.log("[Background] Got user pubkey:", pubkey);
      remotePubkey = pubkey;
      connectionState = "connected";
      nostrConnectUri = null;

      // Store session
      await chrome.storage.local.set({
        [STORAGE_KEY_SESSION]: session,
        [STORAGE_KEY_PUBKEY]: pubkey,
      });

      pendingNostrConnect.resolve(pubkey);
      clearTimeout(pendingNostrConnect.timeout);
      pendingNostrConnect = null;
      console.log("[Background] NostrConnect successful, pubkey:", pubkey);
      return;
    }

    // Handle normal request responses
    if (event.pubkey !== session.remotePubkey) {
      console.log(
        "[Background] Event from unknown pubkey, expected:",
        session.remotePubkey,
      );
      return;
    }

    const pending = pendingRequests.get(response.id);
    console.log(
      "[Background] Looking for pending request:",
      response.id,
      "found:",
      !!pending,
    );

    if (pending) {
      pendingRequests.delete(response.id);

      if (response.error) {
        console.log("[Background] Response has error:", response.error);
        pending.reject(new Error(response.error));
      } else {
        console.log("[Background] Response success:", response.result);
        pending.resolve(response.result);
      }
    }
  } catch (e) {
    // Log decryption errors for debugging
    console.log(
      "[Background] Failed to parse event from",
      event.pubkey,
      ":",
      e,
    );
  }
}

/**
 * Send a NIP-46 request and wait for response
 */
async function sendRequest(
  method: string,
  params: string[],
  timeoutMs = 60000,
): Promise<unknown> {
  if (!session || !relayPool) {
    throw new Error("Not connected");
  }

  console.log("[Background] Sending NIP-46 request:", { method, params });

  const { event, requestId } = await createNIP46Request(
    session,
    method,
    params,
  );

  console.log("[Background] Created event:", {
    id: event.id,
    pubkey: event.pubkey,
    kind: event.kind,
    tags: event.tags,
    contentLength: event.content.length,
  });

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingRequests.delete(requestId);
      console.log("[Background] Request timed out:", requestId);
      reject(new Error("Request timeout"));
    }, timeoutMs);

    pendingRequests.set(requestId, {
      resolve: (v) => {
        clearTimeout(timeout);
        resolve(v);
      },
      reject: (e) => {
        clearTimeout(timeout);
        reject(e);
      },
    });

    console.log(
      "[Background] Publishing event, waiting for response with id:",
      requestId,
    );
    relayPool!.publish(event);
  });
}

/**
 * Connect to Amber using bunker URI
 */
async function connect(bunkerUri: string): Promise<{ pubkey: string }> {
  const params = parseBunkerUri(bunkerUri);
  console.log("[Background] Parsed bunker URI:", {
    remotePubkey: params.remotePubkey,
    relayUrls: params.relayUrls,
    hasSecret: !!params.secret,
    secretLength: params.secret?.length,
  });

  const keypair = await generateSessionKeypair();

  session = {
    localPrivkey: keypair.privkey,
    localPubkey: keypair.pubkey,
    remotePubkey: params.remotePubkey,
    relayUrls: params.relayUrls,
    secret: params.secret,
  };

  await connectToRelays();

  // Send connect request to Amber
  // NIP-46: connect params are [<remote-signer-pubkey>, <optional_secret>, <optional_perms>]
  const connectParams = params.secret
    ? [params.remotePubkey, params.secret]
    : [params.remotePubkey];
  console.log("[Background] Connect params:", connectParams);
  await sendRequest("connect", connectParams);

  // Get the remote user's pubkey
  const pubkey = (await sendRequest("get_public_key", [])) as string;
  remotePubkey = pubkey;

  // Store session (without sensitive data exposed)
  await chrome.storage.local.set({
    [STORAGE_KEY_SESSION]: session,
    [STORAGE_KEY_PUBKEY]: pubkey,
  });

  console.log("[Background] Connected to Amber, pubkey:", pubkey);
  return { pubkey };
}

/**
 * Default relay for nostrconnect if none specified
 */
const DEFAULT_RELAYS = ["wss://relay.nsec.app"];

/**
 * Start nostrconnect flow - generate URI for QR code
 */
async function startNostrConnect(
  relays?: string[],
): Promise<{ uri: string; secret: string }> {
  // Clean up any existing session
  if (relayPool) {
    relayPool.close();
  }

  const keypair = await generateSessionKeypair();
  const relayUrls = relays && relays.length > 0 ? relays : DEFAULT_RELAYS;

  // Generate a random secret for authentication
  const secretBytes = new Uint8Array(16);
  crypto.getRandomValues(secretBytes);
  const secret = Array.from(secretBytes).map((b) =>
    b.toString(16).padStart(2, "0")
  ).join("");

  // Create session without remote pubkey (will be set when Amber connects)
  session = {
    localPrivkey: keypair.privkey,
    localPubkey: keypair.pubkey,
    remotePubkey: "", // Will be set when Amber responds
    relayUrls,
    secret,
  };

  // Connect to relays and subscribe for connect requests
  relayPool = new RelayPool(relayUrls);
  await relayPool.connect();

  // Subscribe for incoming connect requests addressed to us
  relayPool.subscribe(
    "nip46-responses",
    [
      {
        kinds: [24133],
        "#p": [keypair.pubkey],
        since: Math.floor(Date.now() / 1000) - 10,
      },
    ],
    handleRelayEvent,
  );

  // Build nostrconnect URI
  // Format: nostrconnect://<client-pubkey>?relay=<relay>&metadata=<json>&secret=<secret>
  const metadata = JSON.stringify({
    name: "Remote NIP-07",
    description: "NIP-07 browser extension",
  });

  const params = new URLSearchParams();
  for (const relay of relayUrls) {
    params.append("relay", relay);
  }
  params.append("secret", secret);
  params.append("metadata", metadata);

  const uri = `nostrconnect://${keypair.pubkey}?${params.toString()}`;

  // Update state
  connectionState = "awaiting_connection";
  nostrConnectUri = uri;

  console.log("[Background] NostrConnect URI generated:", uri);
  return { uri, secret };
}

/**
 * Wait for Amber to connect via nostrconnect
 */
function awaitNostrConnect(timeoutMs = 300000): Promise<{ pubkey: string }> {
  return new Promise((resolve, reject) => {
    if (!session) {
      reject(new Error("No pending nostrconnect session"));
      return;
    }

    const timeout = setTimeout(() => {
      pendingNostrConnect = null;
      reject(new Error("Connection timeout - no response from Amber"));
    }, timeoutMs);

    pendingNostrConnect = {
      resolve: (pubkey: string) => resolve({ pubkey }),
      reject,
      timeout,
    };
  });
}

/**
 * Cancel pending nostrconnect
 */
function cancelNostrConnect(): void {
  if (pendingNostrConnect) {
    clearTimeout(pendingNostrConnect.timeout);
    pendingNostrConnect.reject(new Error("Cancelled"));
    pendingNostrConnect = null;
  }
  if (relayPool && !remotePubkey) {
    relayPool.close();
    relayPool = null;
  }
  session = null;
  connectionState = "idle";
  nostrConnectUri = null;
}

/**
 * Disconnect and clear session
 */
async function disconnect(): Promise<void> {
  if (relayPool) {
    relayPool.close();
    relayPool = null;
  }

  session = null;
  remotePubkey = null;
  connectionState = "idle";
  nostrConnectUri = null;

  await chrome.storage.local.remove([STORAGE_KEY_SESSION, STORAGE_KEY_PUBKEY]);
  console.log("[Background] Disconnected");
}

/**
 * Get public key (NIP-07: getPublicKey)
 */
async function getPublicKey(): Promise<string> {
  if (!remotePubkey) {
    throw new Error("Not connected");
  }
  return remotePubkey;
}

/**
 * Sign event (NIP-07: signEvent)
 */
async function signEvent(event: UnsignedEvent): Promise<SignedEvent> {
  if (!session) {
    throw new Error("Not connected");
  }

  const result = (await sendRequest("sign_event", [
    JSON.stringify(event),
  ])) as string;

  return JSON.parse(result) as SignedEvent;
}

/**
 * Get connection status
 */
function getStatus(): {
  state: ConnectionState;
  pubkey: string | null;
  relays: string[];
  nostrConnectUri: string | null;
} {
  return {
    state: connectionState,
    pubkey: remotePubkey,
    relays: session?.relayUrls || [],
    nostrConnectUri,
  };
}

// Message types
interface ExtensionMessage {
  type: string;
  bunkerUri?: string;
  event?: UnsignedEvent;
  relays?: string[];
}

/**
 * Message handler for content script communication
 */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const message = msg as ExtensionMessage;
  const handleAsync = async () => {
    try {
      switch (message.type) {
        case "connect":
          return await connect(message.bunkerUri!);

        case "startNostrConnect":
          return await startNostrConnect(message.relays);

        case "awaitNostrConnect":
          return await awaitNostrConnect();

        case "cancelNostrConnect":
          cancelNostrConnect();
          return { success: true };

        case "disconnect":
          await disconnect();
          return { success: true };

        case "getStatus":
          return getStatus();

        case "getPublicKey":
          return await getPublicKey();

        case "signEvent":
          return await signEvent(message.event!);

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

// Keep service worker alive with periodic alarm
chrome.alarms.create("keepalive", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "keepalive") {
    console.log("[Background] Keepalive tick");
  }
});
