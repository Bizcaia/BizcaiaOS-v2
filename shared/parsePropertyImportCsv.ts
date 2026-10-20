import { parse } from 'csv-parse/sync';
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
 * Parse UTF-8 CSV text/bytes into normalized property import rows.
 * Uses csv-parse (not a hand-rolled parser). Header = row 1; first data = row 2.
 */
export function parsePropertyImportCsv(input: string | Uint8Array): ParsedPropertyCsv {
  let text: string;
  try {
    text = typeof input === 'string' ? input : new TextDecoder('utf-8', { fatal: false }).decode(input);
  } catch {
    return {
      ok: false,
      error: { code: 'FILE_ENCODING', message: PROPERTY_IMPORT_ERROR_MESSAGES.FILE_ENCODING },
    };
  }

  let records: string[][];
  try {
    records = parse(text, {
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
