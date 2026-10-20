import { PROPERTY_IMPORT_CSV_MAX_BYTES_DEFAULT } from '../../shared/propertyCsvContract.js';

export function loadPropertyImportCsvMaxBytes(): number {
  const raw = process.env.PROPERTY_IMPORT_CSV_MAX_BYTES;
  if (raw === undefined || raw === '') return PROPERTY_IMPORT_CSV_MAX_BYTES_DEFAULT;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return PROPERTY_IMPORT_CSV_MAX_BYTES_DEFAULT;
  return Math.floor(value);
}
