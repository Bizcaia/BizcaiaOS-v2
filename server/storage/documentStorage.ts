export type StoredFile = {
  key: string;
  size: number;
};

export interface DocumentStorage {
  put(params: {
    organizationId: string;
    propertyId: string;
    documentId: string;
    filename: string;
    contentType: string;
    data: Buffer;
  }): Promise<StoredFile>;
  getReadStream(key: string): Promise<NodeJS.ReadableStream>;
  remove(key: string): Promise<void>;
}

export type DocumentUploadConfig = {
  maxSizeBytes: number;
  acceptedMimeTypes: string[];
};

const DEFAULT_MAX_SIZE_BYTES = 25 * 1024 * 1024;
const DEFAULT_ACCEPTED_MIME_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
];

export function loadDocumentUploadConfig(): DocumentUploadConfig {
  const maxSizeBytes = Number(process.env.DOCUMENT_MAX_SIZE_BYTES ?? DEFAULT_MAX_SIZE_BYTES);
  const acceptedMimeTypes = (process.env.DOCUMENT_ACCEPTED_MIME_TYPES ?? DEFAULT_ACCEPTED_MIME_TYPES.join(','))
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  return {
    maxSizeBytes: Number.isFinite(maxSizeBytes) && maxSizeBytes > 0 ? maxSizeBytes : DEFAULT_MAX_SIZE_BYTES,
    acceptedMimeTypes: acceptedMimeTypes.length > 0 ? acceptedMimeTypes : DEFAULT_ACCEPTED_MIME_TYPES,
  };
}

/**
 * Declared-MIME-type validation only, no magic-byte content sniffing and no
 * malware scanning. Both are known limitations for v1 (see technical contract).
 */
export function assertAcceptedFile(
  file: { size: number; mimetype: string },
  config: DocumentUploadConfig,
): void {
  if (file.size > config.maxSizeBytes) {
    const error = new Error(
      `File exceeds the maximum allowed size of ${config.maxSizeBytes} bytes`,
    ) as Error & { status?: number; code?: string };
    error.status = 422;
    error.code = 'file_too_large';
    throw error;
  }
  if (!config.acceptedMimeTypes.includes(file.mimetype)) {
    const error = new Error(`File type ${file.mimetype} is not accepted`) as Error & {
      status?: number;
      code?: string;
    };
    error.status = 422;
    error.code = 'unsupported_file_type';
    throw error;
  }
}

let activeStorage: DocumentStorage | undefined;

export async function getDocumentStorage(): Promise<DocumentStorage> {
  if (activeStorage) return activeStorage;
  const provider = process.env.DOCUMENT_STORAGE_PROVIDER?.trim() || 'local';
  if (provider !== 'local') {
    throw new Error(
      `Unsupported DOCUMENT_STORAGE_PROVIDER "${provider}". Only "local" is implemented; a production ` +
        'storage adapter has not been built yet (see the Documents technical contract).',
    );
  }
  const { LocalDiskDocumentStorage } = await import('./localDiskDocumentStorage.js');
  activeStorage = new LocalDiskDocumentStorage(process.env.DOCUMENT_STORAGE_LOCAL_ROOT ?? './.data/documents');
  return activeStorage;
}

/** Test-only: reset the memoized storage singleton so tests can reconfigure env vars. */
export function resetDocumentStorageForTests() {
  activeStorage = undefined;
}
