/** Small helpers shared by the board's modules: ids, secrets, hashing, validation. */

const ID_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789'; // no 0/o, 1/l: ids are read aloud and typed

/** A random public id, e.g. for #idea=<id>. 10 characters ≈ 50 bits. */
export function newId(length = 10): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return [...bytes].map((b) => ID_ALPHABET[b % ID_ALPHABET.length]).join('');
}
export const isIdeaId = (s: unknown): s is string => typeof s === 'string' && /^[a-z2-9]{10}$/.test(s);

/** A random secret (receipts, session tokens, login codes): 32 bytes, base64url. */
export function newSecret(): string {
  return b64url(crypto.getRandomValues(new Uint8Array(32)));
}
export const isSecret = (s: unknown): s is string => typeof s === 'string' && /^[A-Za-z0-9_-]{43}$/.test(s);

export function b64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** SHA-256 as hex: only hashes of secrets are stored. */
export async function sha256Hex(text: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
/** SHA-256 as base64url: the PKCE-style challenge format (S256). */
export async function sha256B64url(text: string): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))));
}

/** Constant-time string comparison for secrets of equal format. */
export function sameSecret(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** An https URL without credentials, at most 300 characters; `host` limits it to one site (e.g. github.com). */
export function safeHttpsUrl(raw: unknown, host?: string): string | null {
  if (typeof raw !== 'string' || raw.length > 300) return null;
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== 'https:' || u.username || u.password) return null;
  if (host && u.hostname !== host) return null;
  return u.href;
}

/** Free text from the owner (reasons, notes): trimmed, single-line-ish, at most 300 characters. */
export function cleanNote(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const t = raw.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return t && t.length <= 300 ? t : null;
}
