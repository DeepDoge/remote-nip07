# Privacy Policy

**Remote NIP-07** doesn't collect any personal data, doesn't track websites you
visit, doesn't collect any form of usage analytics, and doesn't send any
information to any service operated by us -- in fact, we don't even have a
server anywhere, it's just an extension installed in your browser.

The only places **Remote NIP-07** sends information to are the Nostr relay
servers used for NIP-46 communication (by default `wss://relay.nsec.app`). These
relays facilitate the signing protocol between this extension and your remote
signer app (such as Amber). The extension assumes these relays are public
infrastructure you choose to use.

**Remote NIP-07** stores only the information necessary to maintain your signing
sessions:

- Website domains where you've connected your Nostr identity
- Session keypairs generated locally for NIP-46 communication
- Your Nostr public key (npub) for each connected site

That information is only stored in your own browser, using the _local_ storage
mode, not the _synced_ storage mode that saves data to a browser-determined sync
server. So if the guarantees offered by the browser itself hold true, _that
information never leaves your browser_.

**Your private key (nsec) never enters the browser.** All signing is performed
on your remote signer (e.g., Amber on your phone).

For more information on the browser guarantees on which **Remote NIP-07**
depends, please read Google Chrome's
[Privacy Policy](https://policies.google.com/privacy) and
[Terms of Service](https://ssl.gstatic.com/chrome/webstore/intl/en-US/gallery_tos.html).
