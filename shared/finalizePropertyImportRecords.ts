import {
  PROPERTY_IMPORT_CSV_HEADERS,
  PROPERTY_IMPORT_ERROR_MESSAGES,
  PROPERTY_IMPORT_MAX_DATA_ROWS,
  type PropertyImportCsvHeader,
  type PropertyImportFieldError,
  type PropertyImportFileError,
  type PropertyImportNormalizedRow,
  validateHeaders,
  validateImportDataRow,
} from './propertyCsvContract.js';

export type ParsedPropertyCsv =
  | {
      ok: true;
      rows: PropertyImportNormalizedRow[];
      fieldErrors: Map<number, PropertyImportFieldError[]>;
    }
  | { ok: false; error: PropertyImportFileError };

/**
 * Shared post-parse validation used by both the server (csv-parse) and browser-safe parsers.
 * Header = row 1; first data = row 2.
 */
export function finalizePropertyImportRecords(records: string[][]): ParsedPropertyCsv {
  if (records.length === 0) {
    return {
      ok: false,
      error: { code: 'FILE_NO_DATA_ROWS', message: PROPERTY_IMPORT_ERROR_MESSAGES.FILE_NO_DATA_ROWS },
    };
  }

  const headerRow = records[0] ?? [];
  const headerError = validateHeaders(headerRow.map((cell) => String(cell)));
  if (headerError) {
    return { ok: false, error: headerError };
  }

  const dataRecords = records.slice(1);
  if (dataRecords.length === 0) {
    return {
      ok: false,
      error: { code: 'FILE_NO_DATA_ROWS', message: PROPERTY_IMPORT_ERROR_MESSAGES.FILE_NO_DATA_ROWS },
    };
  }
  if (dataRecords.length > PROPERTY_IMPORT_MAX_DATA_ROWS) {
    return {
      ok: false,
      error: { code: 'FILE_TOO_MANY_ROWS', message: PROPERTY_IMPORT_ERROR_MESSAGES.FILE_TOO_MANY_ROWS },
    };
  }

  const rows: PropertyImportNormalizedRow[] = [];
  const fieldErrors = new Map<number, PropertyImportFieldError[]>();

  for (let index = 0; index < dataRecords.length; index += 1) {
    const record = dataRecords[index] ?? [];
    if (record.length !== PROPERTY_IMPORT_CSV_HEADERS.length) {
      return {
        ok: false,
        error: { code: 'FILE_MALFORMED', message: PROPERTY_IMPORT_ERROR_MESSAGES.FILE_MALFORMED },
      };
    }
    const rowNumber = index + 2;
    const cells = Object.fromEntries(
      PROPERTY_IMPORT_CSV_HEADERS.map((header, columnIndex) => [header, String(record[columnIndex] ?? '')]),
    ) as Record<PropertyImportCsvHeader, string>;
    const validated = validateImportDataRow(rowNumber, cells);
    rows.push(validated.row);
    if (validated.errors.length > 0) {
      fieldErrors.set(rowNumber, validated.errors);
    }
  }

  return { ok: true, rows, fieldErrors };
}

export function decodePropertyImportCsvText(input: string | Uint8Array):
  | { ok: true; text: string }
  | { ok: false; error: PropertyImportFileError } {
  try {
    const text = typeof input === 'string' ? input : new TextDecoder('utf-8', { fatal: false }).decode(input);
    return { ok: true, text };
  } catch {
    return {
      ok: false,
      error: { code: 'FILE_ENCODING', message: PROPERTY_IMPORT_ERROR_MESSAGES.FILE_ENCODING },
    };
  }
}
