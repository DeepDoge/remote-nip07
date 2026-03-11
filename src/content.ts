/**
 * Content Script
 * Injects the NIP-07 provider into the page and bridges messages to background
 */

// Inject the NIP-07 script into the page context
function injectScript() {
  const script = document.createElement("script");
  script.src = chrome.runtime.getURL("injected.js");
  script.type = "module";
  (document.head || document.documentElement).appendChild(script);
  script.onload = () => script.remove();
}

// Handle messages from the injected script (page context)
window.addEventListener("message", async (event) => {
  if (event.source !== window) return;
  if (!event.data || event.data.direction !== "from-page") return;

  const { id, method, params } = event.data;

  try {
    let result: unknown;

    switch (method) {
      case "getPublicKey":
        result = await chrome.runtime.sendMessage({ type: "getPublicKey" });
        break;

      case "signEvent":
        result = await chrome.runtime.sendMessage({
          type: "signEvent",
          event: params.event,
        });
        break;

      case "getRelays":
        // Return empty object - we don't expose relay list
        result = {};
        break;

      case "nip04.encrypt":
        result = await chrome.runtime.sendMessage({
          type: "nip04.encrypt",
          peer: params.peer,
          plaintext: params.plaintext,
        });
        break;

      case "nip04.decrypt":
        result = await chrome.runtime.sendMessage({
          type: "nip04.decrypt",
          peer: params.peer,
          ciphertext: params.ciphertext,
        });
        break;

      case "nip44.encrypt":
        result = await chrome.runtime.sendMessage({
          type: "nip44.encrypt",
          peer: params.peer,
          plaintext: params.plaintext,
        });
        break;

      case "nip44.decrypt":
        result = await chrome.runtime.sendMessage({
          type: "nip44.decrypt",
          peer: params.peer,
          ciphertext: params.ciphertext,
        });
        break;

      case "replaceURL":
        // Not handled by background, return false
        result = false;
        break;

      default:
        throw new Error(`Unknown method: ${method}`);
    }

    // Handle response from background
    if (result && typeof result === "object" && "success" in result) {
      const response = result as {
        success: boolean;
        result?: unknown;
        error?: string;
      };
      if (response.success) {
        sendToPage(id, response.result, null);
      } else {
        sendToPage(id, null, response.error || "Unknown error");
      }
    } else {
      sendToPage(id, result, null);
    }
  } catch (e) {
    sendToPage(id, null, e instanceof Error ? e.message : "Unknown error");
  }
});

// Send response back to page
function sendToPage(id: string, result: unknown, error: string | null) {
  window.postMessage(
    {
      direction: "from-extension",
      id,
      result,
      error,
    },
    "*",
  );
}

// Inject on load
injectScript();
