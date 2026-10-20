import { describe, expect, it } from 'vitest';
import {
  PROPERTY_IMPORT_CSV_HEADERS,
  buildPropertyImportErrorCsv,
  findIntraFileDuplicateReferences,
  sanitizeSpreadsheetFormula,
  validateHeaders,
  validateImportDataRow,
} from './propertyCsvContract.js';
import { parsePropertyImportCsv } from './parsePropertyImportCsv.js';
import { evaluatePropertyImport } from './evaluatePropertyImport.js';

const header = PROPERTY_IMPORT_CSV_HEADERS.join(',');

describe('property CSV contract', () => {
  it('accepts exact headers only', () => {
    expect(validateHeaders([...PROPERTY_IMPORT_CSV_HEADERS])).toBeNull();
    expect(validateHeaders(['propertyReference', ...PROPERTY_IMPORT_CSV_HEADERS.slice(1)])?.code).toBe('HEADERS_INVALID');
    expect(validateHeaders([...PROPERTY_IMPORT_CSV_HEADERS].reverse())?.code).toBe('HEADERS_INVALID');
  });

  it('parses BOM, CRLF, quoted commas, and escaped quotes', () => {
    const csv =
      '\uFEFF' +
      `${header}\r\n` +
      `NCP,"REF-1","T,1",,,"1.5","City","Prov","Brgy",low\r\n` +
      `NCP,REF-2,"say ""hi""",,,,,,,\n`;
    const parsed = parsePropertyImportCsv(csv);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.rows[0]?.titleNumber).toBe('T,1');
    expect(parsed.rows[1]?.titleNumber).toBe('say "hi"');
    expect(parsed.rows[0]?.risk).toBe('low');
    expect(parsed.rows[1]?.risk).toBe('medium');
  });

  it('rejects unclosed quotes and inconsistent columns', () => {
    expect(parsePropertyImportCsv(`${header}\nNCP,REF-1,"open,,,,,,,\n`).ok).toBe(false);
    expect(parsePropertyImportCsv(`${header}\nNCP,REF-1\n`).ok).toBe(false);
  });

  it('rejects zero and too many data rows', () => {
    expect(parsePropertyImportCsv(`${header}\n`).ok).toBe(false);
    const many = [header, ...Array.from({ length: 5001 }, (_, i) => `NCP,REF-${i},,,,,,,,`)].join('\n');
    const parsed = parsePropertyImportCsv(many);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error.code).toBe('FILE_TOO_MANY_ROWS');
  });

  it('accepts 5000 data rows structurally', () => {
    const many = [header, ...Array.from({ length: 5000 }, (_, i) => `NCP,REF-${i},,,,,,,,`)].join('\n');
    const parsed = parsePropertyImportCsv(many);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.rows).toHaveLength(5000);
  });

  it('validates fields, trimming, and defaults', () => {
    const { row, errors } = validateImportDataRow(2, {
      projectCode: '  AB  ',
      propertyReference: '  R1  ',
      titleNumber: '',
      taxDeclaration: '',
      lotNumber: '',
      areaHectares: '-1',
      municipality: '',
      province: '',
      barangay: '',
      risk: '',
    });
    expect(row.projectCode).toBe('AB');
    expect(row.propertyReference).toBe('R1');
    expect(row.risk).toBe('medium');
    expect(errors.some((error) => error.code === 'AREA_HECTARES_INVALID')).toBe(true);
  });

  it('marks every intra-file duplicate after trim', () => {
    const dupes = findIntraFileDuplicateReferences([
      { rowNumber: 2, propertyReference: 'A' },
      { rowNumber: 3, propertyReference: 'A' },
      { rowNumber: 4, propertyReference: 'B' },
    ]);
    expect([...dupes].sort()).toEqual([2, 3]);
  });

  it('evaluates project and existing reference conflicts without disclosing cross-org', () => {
    const parsed = parsePropertyImportCsv(`${header}\nKNOWN,NEW-1,,,,,,,,\nOTHER,NEW-2,,,,,,,,\n`);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const preview = evaluatePropertyImport({
      rows: parsed.rows,
      fieldErrors: parsed.fieldErrors,
      projectIdsByCode: new Map([['KNOWN', 'project-1']]),
      existingReferences: new Set(['NEW-2']),
    });
    expect(preview.rows[0]?.wouldCreate).toBe(true);
    expect(preview.rows[1]?.errors.some((error) => error.code === 'PROJECT_NOT_FOUND')).toBe(true);
    expect(preview.canCommit).toBe(false);
  });

  it('builds error CSV with exact columns and sanitizes formulas', () => {
    expect(sanitizeSpreadsheetFormula('=1+1')).toBe("'=1+1");
    expect(sanitizeSpreadsheetFormula('ok')).toBe('ok');
    const csv = buildPropertyImportErrorCsv({
      totalRows: 1,
      validCount: 0,
      rejectedCount: 1,
      canCommit: false,
      rows: [
        {
          rowNumber: 2,
          status: 'rejected',
          wouldCreate: false,
          rejected: true,
          propertyReference: 'R1',
          projectCode: 'P',
          projectId: null,
          errors: [
            {
              code: 'PROJECT_NOT_FOUND',
              message: 'No project with this code exists in your organization.',
              column: 'projectCode',
              originalValue: 'P',
            },
          ],
        },
      ],
    });
    expect(csv.startsWith('rowNumber,propertyReference,projectCode,errorCode,errorMessage,column,originalValue')).toBe(true);
    expect(csv).toContain('PROJECT_NOT_FOUND');
  });
});
