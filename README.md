# Remote NIP-07

A browser extension bridging NIP-07 to NIP-46. Let's you connect to NIP-07 only sites with NIP-46.

## How It Works

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   Website   │────▶│  Extension  │────▶│   Relay     │────▶│   Amber     │
│ (NIP-07)    │◀────│  (NIP-46)   │◀────│             │◀────│  (Phone)    │
└─────────────┘     └─────────────┘     └─────────────┘     └─────────────┘
```

1. Website calls `window.nostr.getPublicKey()` or `window.nostr.signEvent()`
2. Extension detects the site and checks for an existing connection
3. If no connection exists, a QR code popup is shown for Amber
4. Amber signs on your phone
5. Extension returns the result to the website

## Features

- ⚡ **No keys in browser** - Your nsec stays on your phone
- 🔒 **Per-site connections** - Each website gets its own Amber session
- 📱 **Amber integration** - Works with the Amber Android app
- 🌐 **NIP-07 compatible** - Works with any NIP-07 website
- 🎯 **Site management** - View and remove connected sites from the popup

## Per-Site Connections

This extension creates a **separate NIP-46 session for each website (host)**.

This means:

- Each site appears as a separate connection in Amber
- You can revoke access to individual sites
- Sites cannot share signing sessions
- The popup shows all connected sites with their pubkeys

## Supported Methods

| Method                  | Status       |
| ----------------------- | ------------ |
| `getPublicKey()`        | ✅ Supported |
| `signEvent(event)`      | ✅ Supported |
| `getRelays()`           | ⚠️ Returns empty |
| `nip04.encrypt/decrypt` | ✅ Supported |
| `nip44.encrypt/decrypt` | ✅ Supported |

## Usage

### First Connection

1. Visit any NIP-07 website (e.g., Snort, Coracle, Nostrudel)
2. The site calls `getPublicKey()` or attempts to sign
3. A QR code popup automatically appears
4. Scan the QR code with Amber on your phone
5. Approve the connection in Amber
6. You're connected! The site now has access.

### Managing Sites

1. Click the extension icon to open the popup
2. See all connected sites with their pubkeys
3. Click **Remove** to disconnect a site
4. The site will need to reconnect next time

### Reconnecting

If you remove a site or it expires:

1. The next signing request from that site triggers a new QR code
2. Scan with Amber to reconnect

## Technical Details

### Per-Site NIP-46 Sessions

1. When a site first requests signing, extension generates a unique keypair
2. A nostrconnect:// QR code is shown to the user
3. User scans with Amber, creating a dedicated connection for that site
4. Each site has its own ephemeral keypair and relay subscriptions
5. Sessions are persisted to storage and restored on extension load

### Security

- Private keys never touch the browser
- Each site gets a unique ephemeral keypair
- Sessions are isolated per-origin (host)
- Connection can be revoked from extension popup or Amber
- No shared state between sites

## License

[GPL v2](LICENSE)
