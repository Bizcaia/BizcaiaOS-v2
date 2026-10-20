import { parse } from 'csv-parse/sync';
import { PROPERTY_IMPORT_ERROR_MESSAGES } from '../../shared/propertyCsvContract.js';
import {
  decodePropertyImportCsvText,
  finalizePropertyImportRecords,
  type ParsedPropertyCsv,
} from '../../shared/finalizePropertyImportRecords.js';

export type { ParsedPropertyCsv };

/**
 * Authoritative live/server CSV parser using csv-parse.
 * Browser/demo must not import this module (it pulls Node Buffer via csv-parse).
 */
export function parsePropertyImportCsv(input: string | Uint8Array): ParsedPropertyCsv {
  const decoded = decodePropertyImportCsvText(input);
  if (!decoded.ok) return decoded;

  let records: string[][];
  try {
    records = parse(decoded.text, {
      bom: true,
      columns: false,
      relax_column_count: false,
      skip_empty_lines: true,
      trim: false,
      relax_quotes: false,
    }) as string[][];
  } catch {
    return {
      ok: false,
      error: { code: 'FILE_MALFORMED', message: PROPERTY_IMPORT_ERROR_MESSAGES.FILE_MALFORMED },
    };
  }

  return finalizePropertyImportRecords(records);
}
