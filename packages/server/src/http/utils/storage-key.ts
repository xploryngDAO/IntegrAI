import { ATTACHMENTS_KEY_PREFIX } from '../constants';

/**
 * Guard for client supplied object-storage keys (path traversal / scheme abuse).
 * Keys always address the attachments prefix created by `IFileService.upload`.
 */
export function isSafeAttachmentKey(key: string): boolean {
  if (key.length === 0 || key.length > 512) return false;
  if (!key.startsWith(ATTACHMENTS_KEY_PREFIX)) return false;
  if (key.startsWith('/')) return false;
  if (key.includes('..')) return false;
  if (key.includes('\\')) return false;
  if (key.includes('\u0000')) return false;
  if (key.includes('://')) return false;
  return true;
}
