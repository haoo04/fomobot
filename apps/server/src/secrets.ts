import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { AppDatabase } from './database.js';
import { secretStore } from './schema.js';

const algorithm = 'aes-256-gcm';
const keyVersion = 1;
const authTagLength = 16;

export function saveSecret(
  database: AppDatabase,
  keyBase64: string,
  value: string,
): string {
  const id = randomUUID();
  const nonce = randomBytes(12);
  const cipher = createCipheriv(
    algorithm,
    Buffer.from(keyBase64, 'base64'),
    nonce,
    { authTagLength },
  );
  cipher.setAAD(Buffer.from(id));
  const cipherText = Buffer.concat([
    cipher.update(value, 'utf8'),
    cipher.final(),
  ]);

  database
    .insert(secretStore)
    .values({
      id,
      algorithm,
      keyVersion,
      nonce: nonce.toString('base64'),
      cipherText: cipherText.toString('base64'),
      authTag: cipher.getAuthTag().toString('base64'),
      createdAtMs: Date.now(),
    })
    .run();
  return id;
}

export function readSecret(
  database: AppDatabase,
  keyBase64: string,
  id: string,
): string | null {
  const record = database
    .select()
    .from(secretStore)
    .where(eq(secretStore.id, id))
    .get();
  if (!record) return null;
  if (record.algorithm !== algorithm || record.keyVersion !== keyVersion) {
    throw new Error('Unsupported secret format');
  }

  const decipher = createDecipheriv(
    algorithm,
    Buffer.from(keyBase64, 'base64'),
    Buffer.from(record.nonce, 'base64'),
    { authTagLength },
  );
  decipher.setAAD(Buffer.from(id));
  decipher.setAuthTag(Buffer.from(record.authTag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(record.cipherText, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}
