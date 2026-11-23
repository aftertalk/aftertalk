// Provider API keys at rest (item 37c): AES-256-GCM with SECRETS_KEY. The stored value is the 12-byte
// nonce, then the ciphertext, then the 16-byte tag. A key is never returned to the browser after saving.
import 'server-only';

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import { env } from '@/env';

const NONCE = 12;
const TAG = 16;

const key = () => Buffer.from(env.SECRETS_KEY, 'base64');

export function encryptSecret(plain: string): Buffer {
  const nonce = randomBytes(NONCE);
  const cipher = createCipheriv('aes-256-gcm', key(), nonce);
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return Buffer.concat([nonce, body, cipher.getAuthTag()]);
}

/** Throws when the value was changed or was written with another SECRETS_KEY. */
export function decryptSecret(stored: Buffer): string {
  if (stored.length < NONCE + TAG) throw new Error('stored secret is too short');
  const decipher = createDecipheriv('aes-256-gcm', key(), stored.subarray(0, NONCE));
  decipher.setAuthTag(stored.subarray(stored.length - TAG));
  return Buffer.concat([decipher.update(stored.subarray(NONCE, stored.length - TAG)), decipher.final()]).toString(
    'utf8'
  );
}
