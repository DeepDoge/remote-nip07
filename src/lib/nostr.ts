/**
 * Nostr types and utilities
 */

export interface NostrEvent {
  id?: string;
  pubkey?: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig?: string;
}

export interface UnsignedEvent {
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
}

export interface SignedEvent extends NostrEvent {
  id: string;
  pubkey: string;
  sig: string;
}

/**
 * NIP-19 bech32 utilities
 */
const ALPHABET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

function bech32Polymod(values: number[]): number {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const b = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) {
      if ((b >> i) & 1) chk ^= GEN[i];
    }
  }
  return chk;
}

function bech32HrpExpand(hrp: string): number[] {
  const ret: number[] = [];
  for (let i = 0; i < hrp.length; i++) {
    ret.push(hrp.charCodeAt(i) >> 5);
  }
  ret.push(0);
  for (let i = 0; i < hrp.length; i++) {
    ret.push(hrp.charCodeAt(i) & 31);
  }
  return ret;
}

function convertBits(
  data: Uint8Array,
  fromBits: number,
  toBits: number,
  pad: boolean,
): number[] {
  let acc = 0;
  let bits = 0;
  const ret: number[] = [];
  const maxv = (1 << toBits) - 1;

  for (const value of data) {
    acc = (acc << fromBits) | value;
    bits += fromBits;
    while (bits >= toBits) {
      bits -= toBits;
      ret.push((acc >> bits) & maxv);
    }
  }

  if (pad) {
    if (bits > 0) {
      ret.push((acc << (toBits - bits)) & maxv);
    }
  }

  return ret;
}

export function bech32Encode(hrp: string, data: Uint8Array): string {
  const values = convertBits(data, 8, 5, true);
  const chk =
    bech32Polymod([...bech32HrpExpand(hrp), ...values, 0, 0, 0, 0, 0, 0]) ^ 1;
  const checksum: number[] = [];
  for (let i = 0; i < 6; i++) {
    checksum.push((chk >> (5 * (5 - i))) & 31);
  }
  return hrp + "1" + [...values, ...checksum].map((d) => ALPHABET[d]).join("");
}

export function bech32Decode(str: string): { hrp: string; data: Uint8Array } {
  const pos = str.lastIndexOf("1");
  const hrp = str.slice(0, pos).toLowerCase();
  const dataStr = str.slice(pos + 1).toLowerCase();

  const data5bit: number[] = [];
  for (const char of dataStr) {
    const idx = ALPHABET.indexOf(char);
    if (idx === -1) throw new Error("Invalid bech32 character");
    data5bit.push(idx);
  }

  // Remove checksum (last 6 chars)
  const dataWithoutChecksum = data5bit.slice(0, -6);

  // Convert 5-bit to 8-bit
  let acc = 0;
  let bits = 0;
  const ret: number[] = [];

  for (const value of dataWithoutChecksum) {
    acc = (acc << 5) | value;
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      ret.push((acc >> bits) & 0xff);
    }
  }

  return { hrp, data: new Uint8Array(ret) };
}

export function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function npubToHex(npub: string): string {
  const { hrp, data } = bech32Decode(npub);
  if (hrp !== "npub") throw new Error("Invalid npub");
  return bytesToHex(data);
}

export function hexToNpub(hex: string): string {
  return bech32Encode("npub", hexToBytes(hex));
}
