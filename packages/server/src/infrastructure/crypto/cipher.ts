import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
} from 'node:crypto';
import type { ISecretCipher } from '@sac/shared';

/**
 * AES-256-GCM secret cipher for the `*_enc` columns (marketplace access and
 * refresh tokens) and for any PII that must be reversible.
 *
 * Wire format (versioned so a key rotation can be staged):
 *   `v1:<keyId>:<ivB64>:<tagB64>:<cipherB64>`
 *
 * `hash()` is a deterministic HMAC-SHA256 over a HKDF-derived lookup key. It is
 * used for equality lookups (e.g. `buyer_contact_hash`) without exposing the
 * plaintext or reusing the encryption key directly (domain separation).
 */

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH_BYTES = 12;
const AUTH_TAG_LENGTH_BYTES = 16;
const KEY_LENGTH_BYTES = 32;
const FORMAT_VERSION = 'v1';
const LOOKUP_HKDF_INFO = 'sac:pii:lookup:v1';

export class EncryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EncryptionError';
    Object.setPrototypeOf(this, EncryptionError.prototype);
  }
}

export interface SecretCipherSettings {
  /** base64-encoded 32-byte master key (ENCRYPTION_MASTER_KEY). */
  masterKey: string;
  /** Key id embedded in the payload (ENCRYPTION_KEY_ID). */
  keyId: string;
  /**
   * Optional previous keys for rotation, keyed by key id. New encryptions always
   * use `masterKey`; old payloads decrypt while their key id is in the ring.
   */
  keyring?: Record<string, string>;
}

function decodeMasterKey(encoded: string, label: string): Buffer {
  const key = Buffer.from(encoded, 'base64');
  if (key.length !== KEY_LENGTH_BYTES) {
    throw new EncryptionError(
      `${label} must be a base64-encoded ${KEY_LENGTH_BYTES}-byte key (got ${key.length} bytes)`,
    );
  }
  return key;
}

function deriveLookupKey(masterKey: Buffer): Buffer {
  const derived = hkdfSync(
    'sha256',
    masterKey,
    Buffer.alloc(0),
    LOOKUP_HKDF_INFO,
    KEY_LENGTH_BYTES,
  );
  return Buffer.from(derived);
}

export class SecretCipher implements ISecretCipher {
  public readonly keyId: string;

  private readonly key: Buffer;
  private readonly lookupKey: Buffer;
  private readonly keyring: Map<string, Buffer>;

  constructor(settings: SecretCipherSettings) {
    if (!settings.keyId || settings.keyId.trim().length === 0) {
      throw new EncryptionError('ENCRYPTION_KEY_ID is required');
    }
    this.keyId = settings.keyId;
    this.key = decodeMasterKey(settings.masterKey, 'ENCRYPTION_MASTER_KEY');
    this.lookupKey = deriveLookupKey(this.key);
    this.keyring = new Map<string, Buffer>();
    for (const [keyId, encoded] of Object.entries(settings.keyring ?? {})) {
      this.keyring.set(keyId, decodeMasterKey(encoded, `keyring[${keyId}]`));
    }
  }

  encrypt(plaintext: string): string {
    if (typeof plaintext !== 'string') {
      throw new EncryptionError('encrypt() expects a string plaintext');
    }
    const iv = randomBytes(IV_LENGTH_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.key, iv, {
      authTagLength: AUTH_TAG_LENGTH_BYTES,
    });
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [
      FORMAT_VERSION,
      this.keyId,
      iv.toString('base64'),
      tag.toString('base64'),
      ciphertext.toString('base64'),
    ].join(':');
  }

  decrypt(ciphertext: string): string {
    if (typeof ciphertext !== 'string' || ciphertext.length === 0) {
      throw new EncryptionError('decrypt() expects a non-empty ciphertext string');
    }

    const parts = ciphertext.split(':');
    if (parts.length !== 5) {
      throw new EncryptionError(
        'Malformed ciphertext: expected "v1:<keyId>:<ivB64>:<tagB64>:<cipherB64>"',
      );
    }

    const [version, keyId, ivB64, tagB64, payloadB64] = parts as [string, string, string, string, string];
    if (version !== FORMAT_VERSION) {
      throw new EncryptionError(`Unsupported ciphertext version "${version}"`);
    }

    const key = this.resolveKey(keyId);
    const iv = Buffer.from(ivB64, 'base64');
    const tag = Buffer.from(tagB64, 'base64');
    const payload = Buffer.from(payloadB64, 'base64');

    if (iv.length !== IV_LENGTH_BYTES || tag.length !== AUTH_TAG_LENGTH_BYTES) {
      throw new EncryptionError('Malformed ciphertext: invalid IV or authentication tag length');
    }

    try {
      const decipher = createDecipheriv(ALGORITHM, key, iv, {
        authTagLength: AUTH_TAG_LENGTH_BYTES,
      });
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(payload), decipher.final()]).toString('utf8');
    } catch {
      throw new EncryptionError(
        `Failed to decrypt payload (key id "${keyId}"): wrong key or corrupted ciphertext`,
      );
    }
  }

  /** Deterministic HMAC-SHA256 (hex) for equality lookups on encrypted data. */
  hash(value: string): string {
    return createHmac('sha256', this.lookupKey).update(value, 'utf8').digest('hex');
  }

  private resolveKey(keyId: string): Buffer {
    if (keyId === this.keyId) return this.key;
    const rotated = this.keyring.get(keyId);
    if (rotated) return rotated;
    throw new EncryptionError(
      `Unknown encryption key id "${keyId}"; add it to the keyring to decrypt legacy payloads`,
    );
  }
}
