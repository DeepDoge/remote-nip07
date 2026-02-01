/**
 * Injected Script - runs in page context
 * Exposes window.nostr (NIP-07 interface)
 */

interface UnsignedEvent {
  created_at?: number;
  kind: number;
  tags: string[][];
  content: string;
}

interface SignedEvent extends UnsignedEvent {
  id: string;
  pubkey: string;
  sig: string;
  created_at: number;
}

// Pending requests waiting for response from content script
const pendingRequests: Map<
  string,
  { resolve: (v: unknown) => void; reject: (e: Error) => void }
> = new Map();

// Generate unique request IDs
let requestId = 0;
function nextRequestId(): string {
  return `nip07-${Date.now()}-${++requestId}`;
}

// Send request to content script and wait for response
function sendRequest<T>(method: string, params: unknown[] = []): Promise<T> {
  return new Promise((resolve, reject) => {
    const id = nextRequestId();

    pendingRequests.set(id, {
      resolve: resolve as (v: unknown) => void,
      reject,
    });

    window.postMessage(
      {
        direction: "from-page",
        id,
        method,
        params,
      },
      "*",
    );

    // Timeout after 5 minutes (signing on phone can take time)
    setTimeout(() => {
      if (pendingRequests.has(id)) {
        pendingRequests.delete(id);
        reject(new Error("Request timeout"));
      }
    }, 300000);
  });
}

// Listen for responses from content script
window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  if (!event.data || event.data.direction !== "from-extension") return;

  const { id, result, error } = event.data;
  const pending = pendingRequests.get(id);

  if (pending) {
    pendingRequests.delete(id);

    if (error) {
      pending.reject(new Error(error));
    } else {
      pending.resolve(result);
    }
  }
});

// NIP-07 interface
const nostr = {
  /**
   * Get the user's public key (hex)
   */
  async getPublicKey(): Promise<string> {
    return sendRequest<string>("getPublicKey");
  },

  /**
   * Sign an event
   */
  async signEvent(event: UnsignedEvent): Promise<SignedEvent> {
    // Ensure created_at is set
    const eventWithTimestamp = {
      ...event,
      created_at: event.created_at ?? Math.floor(Date.now() / 1000),
    };
    return sendRequest<SignedEvent>("signEvent", [eventWithTimestamp]);
  },

  /**
   * Get relay list (NIP-07 optional)
   * We return empty - relays are managed by Amber
   */
  async getRelays(): Promise<
    Record<string, { read: boolean; write: boolean }>
  > {
    return sendRequest<Record<string, { read: boolean; write: boolean }>>(
      "getRelays",
    );
  },

  /**
   * NIP-04 encryption (not supported - throws)
   */
  nip04: {
    async encrypt(_pubkey: string, _plaintext: string): Promise<string> {
      throw new Error("NIP-04 encryption is not supported by this signer");
    },
    async decrypt(_pubkey: string, _ciphertext: string): Promise<string> {
      throw new Error("NIP-04 decryption is not supported by this signer");
    },
  },

  /**
   * NIP-44 encryption (not supported - throws)
   */
  nip44: {
    async encrypt(_pubkey: string, _plaintext: string): Promise<string> {
      throw new Error("NIP-44 encryption is not supported by this signer");
    },
    async decrypt(_pubkey: string, _ciphertext: string): Promise<string> {
      throw new Error("NIP-44 decryption is not supported by this signer");
    },
  },
};

// Freeze to prevent tampering
Object.freeze(nostr);
Object.freeze(nostr.nip04);
Object.freeze(nostr.nip44);

// Expose on window
Object.defineProperty(window, "nostr", {
  value: nostr,
  writable: false,
  configurable: false,
});

console.log("[NIP-07] Remote signer ready");
