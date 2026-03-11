/**
 * Injected Script - runs in page context
 * Exposes window.nostr (NIP-07 interface)
 *
 * Mirrors the nos2x provider shape so sites that access internal
 * properties like _requests, _pubkey, or _call() keep working.
 */

// deno-lint-ignore no-explicit-any
(window as any).nostr = {
  _requests: {} as Record<
    string,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >,
  _pubkey: null as string | null,

  async getPublicKey(): Promise<string> {
    // deno-lint-ignore no-explicit-any
    const self = (window as any).nostr;
    if (self._pubkey) return self._pubkey;
    self._pubkey = await self._call("getPublicKey", {});
    return self._pubkey;
  },

  async signEvent(event: Record<string, unknown>) {
    // Ensure created_at is set
    if (!event.created_at) {
      event.created_at = Math.floor(Date.now() / 1000);
    }
    // deno-lint-ignore no-explicit-any
    return (window as any).nostr._call("signEvent", { event });
  },

  async getRelays(): Promise<
    Record<string, { read: boolean; write: boolean }>
  > {
    return {};
  },

  nip04: {
    async encrypt(peer: string, plaintext: string): Promise<string> {
      // deno-lint-ignore no-explicit-any
      return (window as any).nostr._call("nip04.encrypt", {
        peer,
        plaintext,
      });
    },
    async decrypt(peer: string, ciphertext: string): Promise<string> {
      // deno-lint-ignore no-explicit-any
      return (window as any).nostr._call("nip04.decrypt", {
        peer,
        ciphertext,
      });
    },
  },

  nip44: {
    async encrypt(peer: string, plaintext: string): Promise<string> {
      // deno-lint-ignore no-explicit-any
      return (window as any).nostr._call("nip44.encrypt", {
        peer,
        plaintext,
      });
    },
    async decrypt(peer: string, ciphertext: string): Promise<string> {
      // deno-lint-ignore no-explicit-any
      return (window as any).nostr._call("nip44.decrypt", {
        peer,
        ciphertext,
      });
    },
  },

  _call(
    type: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const id = Math.random().toString().slice(-4);
    // deno-lint-ignore no-explicit-any
    const self = (window as any).nostr;
    return new Promise((resolve, reject) => {
      self._requests[id] = { resolve, reject };
      window.postMessage(
        {
          direction: "from-page",
          id,
          method: type,
          params,
        },
        "*",
      );

      // Timeout after 5 minutes (signing on phone can take time)
      setTimeout(() => {
        if (self._requests[id]) {
          delete self._requests[id];
          reject(new Error("Request timeout"));
        }
      }, 300000);
    });
  },
};

// Listen for responses from content script
window.addEventListener("message", (event: MessageEvent) => {
  if (event.source !== window) return;
  if (!event.data || event.data.direction !== "from-extension") return;

  const { id, result, error } = event.data;
  // deno-lint-ignore no-explicit-any
  const self = (window as any).nostr;
  if (!self._requests[id]) return;

  if (error) {
    const err = new Error(error);
    self._requests[id].reject(err);
  } else {
    self._requests[id].resolve(result);
  }

  delete self._requests[id];
});

// Replace nostr: scheme links with web URLs
let replacing: boolean | null = null;
document.addEventListener("mousedown", replaceNostrSchemeLink);
async function replaceNostrSchemeLink(e: MouseEvent) {
  const target = e.target as HTMLAnchorElement;
  if (target.tagName !== "A" || !target.href?.startsWith("nostr:")) return;
  if (replacing === false) return;

  try {
    // deno-lint-ignore no-explicit-any
    const response = await (window as any).nostr._call("replaceURL", {
      url: target.href,
    });
    if (response === false) {
      replacing = false;
      return;
    }
    target.href = response as string;
  } catch {
    // silently ignore if not supported
  }
}

console.log("[NIP-07] Remote signer ready");
