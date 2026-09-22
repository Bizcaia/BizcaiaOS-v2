import { createReadStream } from 'node:fs';
import { access, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { DocumentStorage, StoredFile } from './documentStorage.js';

/**
 * Development/test storage only (per the Documents technical contract). Not
 * wired to any production deployment claim -- files live on local disk and do
 * not survive redeploys on most container/PaaS platforms.
 */
export class LocalDiskDocumentStorage implements DocumentStorage {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  async put(params: {
    organizationId: string;
    propertyId: string;
    documentId: string;
    filename: string;
    contentType: string;
    data: Buffer;
  }): Promise<StoredFile> {
    const key = buildKey(params.organizationId, params.propertyId, params.documentId, params.filename);
    const filePath = this.resolveKeyPath(key);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, params.data);
    return { key, size: params.data.byteLength };
  }

  async getReadStream(key: string): Promise<NodeJS.ReadableStream> {
    const filePath = this.resolveKeyPath(key);
    // Stat first so a missing file rejects this promise rather than emitting
    // an unhandled 'error' event on a stream the caller hasn't attached to yet.
    await access(filePath);
    return createReadStream(filePath);
  }

  async remove(key: string): Promise<void> {
    await rm(this.resolveKeyPath(key), { force: true });
  }

  /**
   * Only ever joins keys this class generated itself (via buildKey). Never
   * accepts a caller-supplied path, so there is no traversal surface here
   * even though buildKey also sanitizes its inputs defensively.
   */
  private resolveKeyPath(key: string): string {
    const filePath = resolve(this.root, key);
    if (filePath !== this.root && !filePath.startsWith(this.root + '/') && !filePath.startsWith(this.root + '\\')) {
      throw new Error('Resolved document storage path escaped the storage root');
    }
    return filePath;
  }
}

function buildKey(organizationId: string, propertyId: string, documentId: string, filename: string): string {
  // Always forward-slash, regardless of OS: this is a logical storage key
  // (and eventually a DB column value), not a filesystem path.
  return [organizationId, propertyId, documentId, sanitizeFilename(filename)].join('/');
}

function sanitizeFilename(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? 'file';
  const cleaned = base.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^\.+/, '_');
  return cleaned.length > 0 ? cleaned.slice(0, 200) : 'file';
}
