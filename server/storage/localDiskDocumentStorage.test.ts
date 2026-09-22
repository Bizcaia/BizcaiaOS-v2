import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalDiskDocumentStorage } from './localDiskDocumentStorage.js';

describe('LocalDiskDocumentStorage', () => {
  let root: string;
  let storage: LocalDiskDocumentStorage;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'bizcaiaos-documents-'));
    storage = new LocalDiskDocumentStorage(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('round-trips a written file through put, getReadStream, and remove', async () => {
    const organizationId = randomUUID();
    const propertyId = randomUUID();
    const documentId = randomUUID();
    const data = Buffer.from('title deed contents');

    const stored = await storage.put({
      organizationId,
      propertyId,
      documentId,
      filename: 'title-deed.pdf',
      contentType: 'application/pdf',
      data,
    });

    expect(stored.size).toBe(data.byteLength);
    expect(stored.key).toBe(`${organizationId}/${propertyId}/${documentId}/title-deed.pdf`);

    const stream = await storage.getReadStream(stored.key);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(chunk as Buffer);
    }
    expect(Buffer.concat(chunks).toString('utf8')).toBe('title deed contents');

    await storage.remove(stored.key);
    await expect(storage.getReadStream(stored.key)).rejects.toThrow();
  });

  it('sanitizes filenames with path separators and unsafe characters', async () => {
    const organizationId = randomUUID();
    const propertyId = randomUUID();
    const documentId = randomUUID();

    const stored = await storage.put({
      organizationId,
      propertyId,
      documentId,
      filename: '../../etc/passwd; rm -rf.txt',
      contentType: 'text/plain',
      data: Buffer.from('safe'),
    });

    // Only the final path segment survives the split on / and \, then unsafe
    // characters (';', spaces) are replaced -- '..' segments never reach the key.
    expect(stored.key).not.toContain('..');
    expect(stored.key.endsWith('passwd__rm_-rf.txt')).toBe(true);

    const entries = await readdir(join(root, organizationId, propertyId, documentId));
    expect(entries).toEqual([stored.key.split('/').pop()]);
  });

  it('never writes outside the configured storage root', async () => {
    const organizationId = randomUUID();
    const propertyId = randomUUID();
    const documentId = randomUUID();

    const stored = await storage.put({
      organizationId,
      propertyId,
      documentId,
      filename: 'notes.txt',
      contentType: 'text/plain',
      data: Buffer.from('inside root'),
    });

    const entries = await readdir(root);
    expect(entries).toEqual([organizationId]);
    expect(stored.key.startsWith('..')).toBe(false);
  });
});
