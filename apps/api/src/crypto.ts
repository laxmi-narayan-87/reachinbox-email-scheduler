import crypto from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';

function getKey(): Buffer {
  const raw = process.env.CREDENTIAL_ENCRYPTION_KEY;
  if (!raw) throw new Error('CREDENTIAL_ENCRYPTION_KEY is required');
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) throw new Error('CREDENTIAL_ENCRYPTION_KEY must be a base64-encoded 32-byte key');
  return key;
}

export function encryptSecret(value: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString('base64url'), tag.toString('base64url'), encrypted.toString('base64url')].join('.');
}

export function decryptSecret(payload: string): string {
  const [ivRaw, tagRaw, dataRaw] = payload.split('.');
  if (!ivRaw || !tagRaw || !dataRaw) throw new Error('invalid encrypted secret');
  const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), Buffer.from(ivRaw, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagRaw, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(dataRaw, 'base64url')), decipher.final()]).toString('utf8');
}

export function verifyState(state: string, expected: string): boolean {
  return crypto.timingSafeEqual(Buffer.from(state), Buffer.from(expected));
}
