import crypto from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';

function getEncryptionKey(): Buffer {
  const raw = process.env.APP_ENCRYPTION_KEY || 'dev-raqm-store-key-please-set-32-byte-hex-in-production';
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    return Buffer.from(raw, 'hex');
  }
  return crypto.createHash('sha256').update(raw).digest();
}

function getSessionSecret(): string {
  return process.env.SESSION_SIGNING_SECRET || 'raqm-session-signing-secret-change-in-production';
}

export function encryptSecret(plaintext: string): string {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

export function decryptSecret(ciphertext: string): string {
  const parts = ciphertext.split(':');
  if (parts.length !== 3) {
    throw new Error('Invalid encrypted secret format');
  }
  const [ivHex, tagHex, dataHex] = parts;
  const key = getEncryptionKey();
  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(dataHex, 'hex')),
    decipher.final(),
  ]);
  return decrypted.toString('utf8');
}

export function maskApiKey(apiKey: string): string {
  const trimmed = apiKey.trim();
  if (trimmed.length <= 8) {
    return '****';
  }
  return `${trimmed.slice(0, 6)}••••${trimmed.slice(-4)}`;
}

export function verifyHmacSha256(
  rawBody: string | Buffer,
  signatureHeader: string,
  secret: string,
  prefix = 'sha256='
): boolean {
  if (!signatureHeader || !secret) return false;
  const expected = prefix + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signatureHeader.trim(), 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export interface SignedSessionPayload {
  uid: string;
  userId: number;
  email: string;
  role: 'owner' | 'admin' | 'support' | 'customer';
  displayName: string;
  exp: number;
}

export function signSessionToken(payload: Omit<SignedSessionPayload, 'exp'>, ttlSeconds = 86400 * 7): string {
  const fullPayload: SignedSessionPayload = {
    ...payload,
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
  };
  const encoded = Buffer.from(JSON.stringify(fullPayload), 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', getSessionSecret()).update(encoded).digest('base64url');
  return `raqm.${encoded}.${sig}`;
}

export function verifySessionToken(token: string): SignedSessionPayload | null {
  if (!token.startsWith('raqm.')) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [, encoded, sig] = parts;
  const expectedSig = crypto.createHmac('sha256', getSessionSecret()).update(encoded).digest('base64url');
  const a = Buffer.from(sig, 'utf8');
  const b = Buffer.from(expectedSig, 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  try {
    const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as SignedSessionPayload;
    if (parsed.exp < Math.floor(Date.now() / 1000)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function generateUniqueRef(prefix: string): string {
  const rand = crypto.randomBytes(4).toString('hex').toUpperCase();
  const ts = Date.now().toString(36).toUpperCase();
  return `${prefix}-${ts}-${rand}`;
}
