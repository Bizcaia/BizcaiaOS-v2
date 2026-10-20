import { PROPERTY_IMPORT_ERROR_MESSAGES } from './propertyCsvContract.js';
import {
  decodePropertyImportCsvText,
  finalizePropertyImportRecords,
  type ParsedPropertyCsv,
} from './finalizePropertyImportRecords.js';

export type { ParsedPropertyCsv } from './finalizePropertyImportRecords.js';

/**
 * Browser-safe RFC4180 CSV parser for demo/client use.
 * Must not import Node CSV libraries or Node globals (process/fs/stream).
 * Live/server import remains authoritative via server/imports/parsePropertyCsv.ts.
 */
export function parsePropertyImportCsv(input: string | Uint8Array): ParsedPropertyCsv {
  const decoded = decodePropertyImportCsvText(input);
  if (!decoded.ok) return decoded;

  let records: string[][];
  try {
    records = parseRfc4180Records(decoded.text);
  } catch {
    return {
      ok: false,
      error: { code: 'FILE_MALFORMED', message: PROPERTY_IMPORT_ERROR_MESSAGES.FILE_MALFORMED },
    };
  }

  return finalizePropertyImportRecords(records);
}

/**
 * Minimal RFC4180 record splitter matching the csv-parse options used on the server:
 * bom stripped, comma delimiter, CRLF/LF, quoted commas, escaped quotes,
 * skip empty lines, trim:false, relax_quotes:false, relax_column_count:false (enforced later).
 */
function parseRfc4180Records(input: string): string[][] {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const records: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  let sawContentInRow = false;

  const endField = () => {
    row.push(field);
    field = '';
  };

  const endRow = () => {
    endField();
    const isEmptyLine = !sawContentInRow && row.length === 1 && row[0] === '';
    if (!isEmptyLine) {
      records.push(row);
    }
    row = [];
    sawContentInRow = false;
  };

  while (i < text.length) {
    const ch = text[i]!;

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      sawContentInRow = true;
      i += 1;
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      sawContentInRow = true;
      i += 1;
      continue;
    }

    if (ch === ',') {
      endField();
      sawContentInRow = true;
      i += 1;
      continue;
    }

    if (ch === '\n') {
      endRow();
      i += 1;
      continue;
    }

    if (ch === '\r') {
      endRow();
      i += text[i + 1] === '\n' ? 2 : 1;
      continue;
    }

    field += ch;
    sawContentInRow = true;
    i += 1;
  }

  if (inQuotes) {
    throw new Error('unclosed_quote');
  }

  if (sawContentInRow || field.length > 0 || row.length > 0) {
    endRow();
  }

  return records;
}
