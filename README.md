# Remote NIP-07

A Chrome extension that acts as a **NIP-07 → NIP-46 bridge**, allowing you to
use NIP-07-only websites without ever exposing your `nsec`.

## How It Works

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   Website   │────▶│  Extension  │────▶│   Relay     │────▶│   Amber     │
│ (NIP-07)    │◀────│  (NIP-46)   │◀────│             │◀────│  (Phone)    │
└─────────────┘     └─────────────┘     └─────────────┘     └─────────────┘
```

1. Website calls `window.nostr.getPublicKey()` or `window.nostr.signEvent()`
2. Extension forwards request to Amber via NIP-46 (remote signing)
3. Amber signs on your phone
4. Extension returns the result to the website

## Features

- ⚡ **No keys in browser** - Your nsec stays on your phone
- 🔒 **NIP-46 protocol** - Secure remote signing via relays
- 📱 **Amber integration** - Works with the Amber Android app
- 🌐 **NIP-07 compatible** - Works with any NIP-07 website

## Supported Methods

| Method                  | Status           |
| ----------------------- | ---------------- |
| `getPublicKey()`        | ✅ Supported     |
| `signEvent(event)`      | ✅ Supported     |
| `getRelays()`           | ⚠️ Returns empty |
| `nip04.encrypt/decrypt` | ❌ Not supported |
| `nip44.encrypt/decrypt` | ❌ Not supported |

## Installation

### Prerequisites

- [Deno](https://deno.land/) 1.40+
- Chrome/Chromium browser
- [Amber](https://github.com/greenart7c3/Amber) on your Android phone

### Build

```bash
# Install dependencies and build
deno task build

# Or watch for changes
deno task build:watch
```

### Load Extension

1. Open `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked**
4. Select the `./dist` folder

## Usage

### Connect to Amber

1. Open Amber on your phone
2. Go to **Settings** → **Nostr Connect**
3. Tap **Create Connection** or copy your bunker URI
4. Click the extension icon in Chrome
5. Paste the bunker URI and click **Connect**

### Using Websites

Once connected, any website that uses NIP-07 will automatically work:

- Signing requests will be forwarded to Amber
- You'll get a notification on your phone to approve
- The signed event is returned to the website

## Development

```bash
# Type check
deno task check

# Format code
deno task fmt

# Lint
deno task lint

# Build with watch
deno task build:watch
```

## Project Structure

```
src/
├── background.ts     # Service worker - NIP-46 client
├── content.ts        # Content script - bridges page ↔ background
├── injected.ts       # Injected script - window.nostr provider
├── popup.html        # Extension popup UI
├── popup.ts          # Popup logic
├── manifest.json     # Chrome extension manifest (v3)
└── lib/
    ├── nostr.ts      # Nostr types and utilities
    ├── nip46.ts      # NIP-46 encryption and messages
    └── relay.ts      # WebSocket relay pool
```

## Technical Details

### NIP-46 Flow

1. Extension generates ephemeral keypair on first connect
2. Sends `connect` request to Amber's pubkey via relay
3. Amber approves connection and stores client pubkey
4. All subsequent requests use NIP-44 encryption

### Security

- Private keys never touch the browser
- Only session data (ephemeral keypair) is stored
- Each site sees the same pubkey (Amber's user pubkey)
- Connection can be revoked from Amber at any time

## License

MIT
