/**
 * NIP-46 Remote Signing Protocol
 * Handles communication with Amber via bunker URI
 */

import { schnorr } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha256";
import * as nip44 from "nostr-tools/nip44";
import {
  bytesToHex,
  hexToBytes,
  type NostrEvent,
  type SignedEvent,
  type UnsignedEvent,
} from "./nostr.ts";

export interface BunkerParams {
  remotePubkey: string; // Amber's pubkey (hex)
  relayUrls: string[];
  secret?: string; // Optional connection secret
}

export interface NIP46Request {
  id: string;
  method: string;
  params: string[];
}

export interface NIP46Response {
  id: string;
  result?: string;
  error?: string;
}

export interface NIP46Session {
  localPrivkey: string; // Our ephemeral private key (hex)
  localPubkey: string; // Our ephemeral public key (hex)
  remotePubkey: string; // Amber's pubkey (hex)
  relayUrls: string[];
  secret?: string;
}

/**
 * Parse a bunker:// URI
 * Format: bunker://<remote-pubkey>?relay=<relay-url>&secret=<secret>
 */
export function parseBunkerUri(uri: string): BunkerParams {
  if (!uri.startsWith("bunker://")) {
    throw new Error("Invalid bunker URI: must start with bunker://");
  }

  const url = new URL(uri.replace("bunker://", "https://"));
  const remotePubkey = url.hostname || url.pathname.replace(/^\//, "");

  if (!/^[0-9a-f]{64}$/i.test(remotePubkey)) {
    throw new Error("Invalid bunker URI: pubkey must be 64 hex characters");
  }

  const relayUrls = url.searchParams.getAll("relay");
  if (relayUrls.length === 0) {
    throw new Error("Invalid bunker URI: at least one relay required");
  }

  const secret = url.searchParams.get("secret") || undefined;

  return {
    remotePubkey: remotePubkey.toLowerCase(),
    relayUrls,
    secret,
  };
}

/**
 * Generate a new ephemeral keypair for NIP-46 session
 */
export async function generateSessionKeypair(): Promise<{
  privkey: string;
  pubkey: string;
}> {
  const privkeyBytes = crypto.getRandomValues(new Uint8Array(32));
  const privkey = bytesToHex(privkeyBytes);
  // Use schnorr.getPublicKey for x-only pubkey (32 bytes)
  const pubkeyBytes = schnorr.getPublicKey(privkeyBytes);
  const pubkey = bytesToHex(pubkeyBytes);
  return { privkey, pubkey };
}

/**
 * NIP-44 encryption using nostr-tools
 */
export async function nip44Encrypt(
  plaintext: string,
  privkey: string,
  pubkey: string,
): Promise<string> {
  const conversationKey = nip44.getConversationKey(privkey, pubkey);
  return nip44.encrypt(plaintext, conversationKey);
}

/**
 * NIP-44 decryption using nostr-tools
 */
export async function nip44Decrypt(
  payload: string,
  privkey: string,
  pubkey: string,
): Promise<string> {
  const conversationKey = nip44.getConversationKey(privkey, pubkey);
  return nip44.decrypt(payload, conversationKey);
}

/**
 * Create a NIP-46 request event (kind 24133)
 */
export async function createNIP46Request(
  session: NIP46Session,
  method: string,
  params: string[],
): Promise<{ event: SignedEvent; requestId: string }> {
  const requestIdBytes = crypto.getRandomValues(new Uint8Array(16));
  const requestId = bytesToHex(requestIdBytes);

  const request: NIP46Request = {
    id: requestId,
    method,
    params,
  };

  const encryptedContent = await nip44Encrypt(
    JSON.stringify(request),
    session.localPrivkey,
    session.remotePubkey,
  );

  const event: UnsignedEvent = {
    created_at: Math.floor(Date.now() / 1000),
    kind: 24133,
    tags: [["p", session.remotePubkey]],
    content: encryptedContent,
  };

  const signedEvent = await signEvent(event, session.localPrivkey);

  return { event: signedEvent, requestId };
}

/**
 * Parse a NIP-46 response event (kind 24133)
 */
export async function parseNIP46Response(
  event: NostrEvent,
  session: NIP46Session,
): Promise<NIP46Response> {
  if (event.kind !== 24133) {
    throw new Error("Invalid event kind for NIP-46 response");
  }

  const decrypted = await nip44Decrypt(
    event.content,
    session.localPrivkey,
    event.pubkey!,
  );

  return JSON.parse(decrypted) as NIP46Response;
}

/**
 * Sign a Nostr event using Schnorr signatures (BIP-340)
 */
async function signEvent(
  event: UnsignedEvent,
  privkey: string,
): Promise<SignedEvent> {
  // Get x-only pubkey (32 bytes) for Nostr
  const pubkeyBytes = schnorr.getPublicKey(privkey);
  const pubkey = bytesToHex(pubkeyBytes);

  const eventWithPubkey = {
    ...event,
    pubkey,
  };

  const serialized = JSON.stringify([
    0,
    eventWithPubkey.pubkey,
    eventWithPubkey.created_at,
    eventWithPubkey.kind,
    eventWithPubkey.tags,
    eventWithPubkey.content,
  ]);

  const encoder = new TextEncoder();
  const hash = sha256(encoder.encode(serialized));
  const id = bytesToHex(hash);

  // Use Schnorr signature (BIP-340)
  const sig = schnorr.sign(hash, privkey);
  const sigHex = bytesToHex(sig);

  return {
    ...eventWithPubkey,
    id,
    sig: sigHex,
  };
}

/**
 * Verify a Nostr event signature (Schnorr/BIP-340)
 */
export async function verifyEvent(event: SignedEvent): Promise<boolean> {
  const serialized = JSON.stringify([
    0,
    event.pubkey,
    event.created_at,
    event.kind,
    event.tags,
    event.content,
  ]);

  const encoder = new TextEncoder();
  const hash = sha256(encoder.encode(serialized));
  const expectedId = bytesToHex(hash);

  if (event.id !== expectedId) {
    return false;
  }

  return schnorr.verify(hexToBytes(event.sig), hash, event.pubkey);
}
