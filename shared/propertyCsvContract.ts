/**
 * Browser-safe CSV Property Import/Export contract and helpers.
 * Authoritative live parsing lives in server/imports/parsePropertyCsv.ts.
 * Demo/browser parsing uses shared/parsePropertyImportCsv.ts (no Node globals).
 */

export const PROPERTY_IMPORT_CSV_HEADERS = [
  'projectCode',
  'propertyReference',
  'titleNumber',
  'taxDeclaration',
  'lotNumber',
  'areaHectares',
  'municipality',
  'province',
  'barangay',
  'risk',
] as const;

export type PropertyImportCsvHeader = (typeof PROPERTY_IMPORT_CSV_HEADERS)[number];

export const PROPERTY_IMPORT_MAX_DATA_ROWS = 5000;

/** Default / authorized ceiling: 5 MiB. Override via PROPERTY_IMPORT_CSV_MAX_BYTES on the server. */
export const PROPERTY_IMPORT_CSV_MAX_BYTES_DEFAULT = 5_242_880;

export const PROPERTY_IMPORT_RISK_VALUES = ['low', 'medium', 'high'] as const;
export type PropertyImportRisk = (typeof PROPERTY_IMPORT_RISK_VALUES)[number];

export const PROPERTY_EXPORT_CSV_HEADERS = [
  'propertyReference',
  'projectCode',
  'projectName',
  'titleNumber',
  'taxDeclaration',
  'lotNumber',
  'areaHectares',
  'municipality',
  'province',
  'barangay',
  'acquisitionStage',
  'acquisitionStatus',
  'risk',
  'legalStatus',
  'documentationStatus',
  'paymentStatus',
  'readinessPercent',
  'negotiatorName',
  'managerName',
  'updatedAt',
  'createdAt',
  'id',
] as const;

export const PROPERTY_IMPORT_ERROR_CSV_HEADERS = [
  'rowNumber',
  'propertyReference',
  'projectCode',
  'errorCode',
  'errorMessage',
  'column',
  'originalValue',
] as const;

export type PropertyImportErrorCode =
  | 'FILE_MISSING'
  | 'FILE_MALFORMED'
  | 'FILE_ENCODING'
  | 'FILE_TOO_LARGE'
  | 'FILE_TOO_MANY_ROWS'
  | 'FILE_NO_DATA_ROWS'
  | 'HEADERS_INVALID'
  | 'PROJECT_CODE_MISSING'
  | 'PROJECT_CODE_INVALID'
  | 'PROJECT_NOT_FOUND'
  | 'PROPERTY_REFERENCE_MISSING'
  | 'PROPERTY_REFERENCE_INVALID'
  | 'PROPERTY_REFERENCE_DUPLICATE_IN_FILE'
  | 'PROPERTY_REFERENCE_EXISTS'
  | 'TITLE_NUMBER_INVALID'
  | 'TAX_DECLARATION_INVALID'
  | 'LOT_NUMBER_INVALID'
  | 'AREA_HECTARES_INVALID'
  | 'MUNICIPALITY_INVALID'
  | 'PROVINCE_INVALID'
  | 'BARANGAY_INVALID'
  | 'RISK_INVALID'
  | 'COMMIT_HAS_REJECTED_ROWS'
  | 'COMMIT_FAILED'
  | 'FORBIDDEN'
  | 'UNAUTHORIZED';

export const PROPERTY_IMPORT_ERROR_MESSAGES: Record<PropertyImportErrorCode, string> = {
  FILE_MISSING: 'A CSV file is required.',
  FILE_MALFORMED: 'The file could not be parsed as CSV.',
  FILE_ENCODING: 'The file must be UTF-8 encoded.',
  FILE_TOO_LARGE: 'The file exceeds the maximum upload size.',
  FILE_TOO_MANY_ROWS: 'Imports are limited to 5,000 data rows.',
  FILE_NO_DATA_ROWS: 'The CSV contains no data rows.',
  HEADERS_INVALID: 'CSV headers must exactly match the published template.',
  PROJECT_CODE_MISSING: 'projectCode is required.',
  PROJECT_CODE_INVALID: 'projectCode must be between 2 and 40 characters.',
  PROJECT_NOT_FOUND: 'No project with this code exists in your organization.',
  PROPERTY_REFERENCE_MISSING: 'propertyReference is required.',
  PROPERTY_REFERENCE_INVALID: 'propertyReference must be between 1 and 80 characters.',
  PROPERTY_REFERENCE_DUPLICATE_IN_FILE: 'propertyReference is duplicated in this file.',
  PROPERTY_REFERENCE_EXISTS: 'A property with this reference already exists in the organization.',
  TITLE_NUMBER_INVALID: 'titleNumber exceeds the maximum length.',
  TAX_DECLARATION_INVALID: 'taxDeclaration exceeds the maximum length.',
  LOT_NUMBER_INVALID: 'lotNumber exceeds the maximum length.',
  AREA_HECTARES_INVALID: 'areaHectares must be a non-negative number.',
  MUNICIPALITY_INVALID: 'municipality exceeds the maximum length.',
  PROVINCE_INVALID: 'province exceeds the maximum length.',
  BARANGAY_INVALID: 'barangay exceeds the maximum length.',
  RISK_INVALID: 'risk must be low, medium, or high.',
  COMMIT_HAS_REJECTED_ROWS: 'Import cannot be committed while any row is invalid.',
  COMMIT_FAILED: 'Import failed and no properties were created.',
  FORBIDDEN: 'You do not have permission for this operation.',
  UNAUTHORIZED: 'Authentication required.',
};

export type PropertyImportFieldError = {
  code: PropertyImportErrorCode;
  message: string;
  column?: PropertyImportCsvHeader | '';
  originalValue?: string;
};

export type PropertyImportNormalizedRow = {
  /** Spreadsheet row number (header = 1, first data = 2). */
  rowNumber: number;
  projectCode: string;
  propertyReference: string;
  titleNumber: string | null;
  taxDeclaration: string | null;
  lotNumber: string | null;
  areaHectares: number | null;
  municipality: string | null;
  province: string | null;
  barangay: string | null;
  risk: PropertyImportRisk;
  /** Raw cells after trim, for error CSV originalValue. */
  raw: Record<PropertyImportCsvHeader, string>;
};

export type PropertyImportRowStatus = 'would_create' | 'rejected';

export type PropertyImportPreviewRow = {
  rowNumber: number;
  status: PropertyImportRowStatus;
  wouldCreate: boolean;
  rejected: boolean;
  propertyReference: string;
  projectCode: string;
  projectId: string | null;
  errors: PropertyImportFieldError[];
};

export type PropertyImportPreviewResult = {
  totalRows: number;
  validCount: number;
  rejectedCount: number;
  canCommit: boolean;
  rows: PropertyImportPreviewRow[];
  /** Present only when every row passed field validation; used by commit inserts. */
  accepted?: Array<PropertyImportNormalizedRow & { projectId: string }>;
};

export type PropertyImportFileError = {
  code: PropertyImportErrorCode;
  message: string;
};

export function propertyImportTemplateCsv(): string {
  return `${PROPERTY_IMPORT_CSV_HEADERS.join(',')}\r\n`;
}

export function trimCell(value: string | undefined | null): string {
  return (value ?? '').trim();
}

export function blankToNull(value: string): string | null {
  return value === '' ? null : value;
}

export function validateHeaders(headers: string[]): PropertyImportFileError | null {
  if (
    headers.length !== PROPERTY_IMPORT_CSV_HEADERS.length ||
    PROPERTY_IMPORT_CSV_HEADERS.some((expected, index) => headers[index] !== expected)
  ) {
    return {
      code: 'HEADERS_INVALID',
      message: PROPERTY_IMPORT_ERROR_MESSAGES.HEADERS_INVALID,
    };
  }
  return null;
}

function optionalMaxLength(
  value: string,
  max: number,
  code: PropertyImportErrorCode,
  column: PropertyImportCsvHeader,
): PropertyImportFieldError | null {
  if (value === '') return null;
  if (value.length > max) {
    return {
      code,
      message: PROPERTY_IMPORT_ERROR_MESSAGES[code],
      column,
      originalValue: value,
    };
  }
  return null;
}

function parseAreaHectares(raw: string): { value: number | null; error?: PropertyImportFieldError } {
  if (raw === '') return { value: null };
  if (!/^\d+(\.\d+)?$/.test(raw)) {
    return {
      value: null,
      error: {
        code: 'AREA_HECTARES_INVALID',
        message: PROPERTY_IMPORT_ERROR_MESSAGES.AREA_HECTARES_INVALID,
        column: 'areaHectares',
        originalValue: raw,
      },
    };
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    return {
      value: null,
      error: {
        code: 'AREA_HECTARES_INVALID',
        message: PROPERTY_IMPORT_ERROR_MESSAGES.AREA_HECTARES_INVALID,
        column: 'areaHectares',
        originalValue: raw,
      },
    };
  }
  return { value };
}

/**
 * Field-level validation for one data row (cells already mapped by header name).
 * Does not resolve projects or check DB uniqueness.
 */
export function validateImportDataRow(
  rowNumber: number,
  cells: Record<string, string>,
): { row: PropertyImportNormalizedRow; errors: PropertyImportFieldError[] } {
  const raw = {
    projectCode: trimCell(cells.projectCode),
    propertyReference: trimCell(cells.propertyReference),
    titleNumber: trimCell(cells.titleNumber),
    taxDeclaration: trimCell(cells.taxDeclaration),
    lotNumber: trimCell(cells.lotNumber),
    areaHectares: trimCell(cells.areaHectares),
    municipality: trimCell(cells.municipality),
    province: trimCell(cells.province),
    barangay: trimCell(cells.barangay),
    risk: trimCell(cells.risk),
  } satisfies Record<PropertyImportCsvHeader, string>;

  const errors: PropertyImportFieldError[] = [];

  if (raw.projectCode === '') {
    errors.push({
      code: 'PROJECT_CODE_MISSING',
      message: PROPERTY_IMPORT_ERROR_MESSAGES.PROJECT_CODE_MISSING,
      column: 'projectCode',
      originalValue: '',
    });
  } else if (raw.projectCode.length < 2 || raw.projectCode.length > 40) {
    errors.push({
      code: 'PROJECT_CODE_INVALID',
      message: PROPERTY_IMPORT_ERROR_MESSAGES.PROJECT_CODE_INVALID,
      column: 'projectCode',
      originalValue: raw.projectCode,
    });
  }

  if (raw.propertyReference === '') {
    errors.push({
      code: 'PROPERTY_REFERENCE_MISSING',
      message: PROPERTY_IMPORT_ERROR_MESSAGES.PROPERTY_REFERENCE_MISSING,
      column: 'propertyReference',
      originalValue: '',
    });
  } else if (raw.propertyReference.length > 80) {
    errors.push({
      code: 'PROPERTY_REFERENCE_INVALID',
      message: PROPERTY_IMPORT_ERROR_MESSAGES.PROPERTY_REFERENCE_INVALID,
      column: 'propertyReference',
      originalValue: raw.propertyReference,
    });
  }

  for (const [column, code, max] of [
    ['titleNumber', 'TITLE_NUMBER_INVALID', 120],
    ['taxDeclaration', 'TAX_DECLARATION_INVALID', 120],
    ['lotNumber', 'LOT_NUMBER_INVALID', 120],
    ['municipality', 'MUNICIPALITY_INVALID', 120],
    ['province', 'PROVINCE_INVALID', 120],
    ['barangay', 'BARANGAY_INVALID', 120],
  ] as const) {
    const err = optionalMaxLength(raw[column], max, code, column);
    if (err) errors.push(err);
  }

  const area = parseAreaHectares(raw.areaHectares);
  if (area.error) errors.push(area.error);

  let risk: PropertyImportRisk = 'medium';
  if (raw.risk === '') {
    risk = 'medium';
  } else if ((PROPERTY_IMPORT_RISK_VALUES as readonly string[]).includes(raw.risk)) {
    risk = raw.risk as PropertyImportRisk;
  } else {
    errors.push({
      code: 'RISK_INVALID',
      message: PROPERTY_IMPORT_ERROR_MESSAGES.RISK_INVALID,
      column: 'risk',
      originalValue: raw.risk,
    });
  }

  const row: PropertyImportNormalizedRow = {
    rowNumber,
    projectCode: raw.projectCode,
    propertyReference: raw.propertyReference,
    titleNumber: blankToNull(raw.titleNumber),
    taxDeclaration: blankToNull(raw.taxDeclaration),
    lotNumber: blankToNull(raw.lotNumber),
    areaHectares: area.value,
    municipality: blankToNull(raw.municipality),
    province: blankToNull(raw.province),
    barangay: blankToNull(raw.barangay),
    risk,
    raw,
  };

  return { row, errors };
}

/** Mark every row that shares a trimmed propertyReference with another row. */
export function findIntraFileDuplicateReferences(
  rows: Array<{ rowNumber: number; propertyReference: string }>,
): Set<number> {
  const byRef = new Map<string, number[]>();
  for (const row of rows) {
    if (!row.propertyReference) continue;
    const list = byRef.get(row.propertyReference) ?? [];
    list.push(row.rowNumber);
    byRef.set(row.propertyReference, list);
  }
  const dupes = new Set<number>();
  for (const list of byRef.values()) {
    if (list.length > 1) {
      for (const rowNumber of list) dupes.add(rowNumber);
    }
  }
  return dupes;
}

export function buildPreviewResult(
  rows: PropertyImportPreviewRow[],
  accepted?: Array<PropertyImportNormalizedRow & { projectId: string }>,
): PropertyImportPreviewResult {
  const validCount = rows.filter((row) => row.wouldCreate).length;
  const rejectedCount = rows.filter((row) => row.rejected).length;
  return {
    totalRows: rows.length,
    validCount,
    rejectedCount,
    canCommit: rejectedCount === 0 && validCount > 0,
    rows,
    ...(accepted && rejectedCount === 0 ? { accepted } : {}),
  };
}

export function csvEscapeCell(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replaceAll('"', '""')}"`;
  }
  return value;
}

/** Prefix spreadsheet formula-leading characters so Excel/Sheets do not evaluate them. */
export function sanitizeSpreadsheetFormula(value: string): string {
  if (value.length === 0) return value;
  const first = value[0];
  if (first === '=' || first === '+' || first === '-' || first === '@') {
    return `'${value}`;
  }
  return value;
}

export function rowsToCsv(headers: readonly string[], rows: string[][]): string {
  const lines = [headers.map((h) => csvEscapeCell(h)).join(',')];
  for (const row of rows) {
    lines.push(row.map((cell) => csvEscapeCell(cell)).join(','));
  }
  return `${lines.join('\r\n')}\r\n`;
}

export function buildPropertyImportErrorCsv(preview: PropertyImportPreviewResult): string {
  const dataRows: string[][] = [];
  for (const row of preview.rows) {
    if (!row.rejected || row.errors.length === 0) continue;
    for (const error of row.errors) {
      dataRows.push([
        String(row.rowNumber),
        row.propertyReference,
        row.projectCode,
        error.code,
        error.message,
        error.column ?? '',
        error.originalValue ?? '',
      ]);
    }
  }
  return rowsToCsv(PROPERTY_IMPORT_ERROR_CSV_HEADERS, dataRows);
}

export function propertyImportErrorFilename(at: Date = new Date()): string {
  const y = at.getUTCFullYear();
  const m = String(at.getUTCMonth() + 1).padStart(2, '0');
  const d = String(at.getUTCDate()).padStart(2, '0');
  const hh = String(at.getUTCHours()).padStart(2, '0');
  const mm = String(at.getUTCMinutes()).padStart(2, '0');
  const ss = String(at.getUTCSeconds()).padStart(2, '0');
  return `property-import-errors-${y}${m}${d}-${hh}${mm}${ss}Z.csv`;
}

export function propertyExportFilename(organizationId: string, at: Date = new Date()): string {
  const y = at.getUTCFullYear();
  const m = String(at.getUTCMonth() + 1).padStart(2, '0');
  const d = String(at.getUTCDate()).padStart(2, '0');
  const hh = String(at.getUTCHours()).padStart(2, '0');
  const mm = String(at.getUTCMinutes()).padStart(2, '0');
  const ss = String(at.getUTCSeconds()).padStart(2, '0');
  return `properties-export-${organizationId}-${y}${m}${d}-${hh}${mm}${ss}Z.csv`;
}

export type PropertyExportSourceRow = {
  property_reference: string;
  project_code: string;
  project_name: string;
  title_number: string | null;
  tax_declaration: string | null;
  lot_number: string | null;
  area_hectares: string | number | null;
  municipality: string | null;
  province: string | null;
  barangay: string | null;
  acquisition_stage: string;
  acquisition_status: string;
  risk: string;
  legal_status: string;
  documentation_status: string;
  payment_status: string;
  readiness_percent: number;
  negotiator_name: string | null;
  manager_name: string | null;
  updated_at: string | Date;
  created_at: string | Date;
  id: string;
};

function exportCell(value: string | number | Date | null | undefined): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object' && value instanceof Date) {
    return sanitizeSpreadsheetFormula(value.toISOString());
  }
  return sanitizeSpreadsheetFormula(String(value));
}

function exportTimestamp(value: string | Date): string {
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

export function propertyExportRowCells(row: PropertyExportSourceRow): string[] {
  return [
    exportCell(row.property_reference),
    exportCell(row.project_code),
    exportCell(row.project_name),
    exportCell(row.title_number),
    exportCell(row.tax_declaration),
    exportCell(row.lot_number),
    exportCell(row.area_hectares === null || row.area_hectares === undefined ? '' : String(row.area_hectares)),
    exportCell(row.municipality),
    exportCell(row.province),
    exportCell(row.barangay),
    exportCell(row.acquisition_stage),
    exportCell(row.acquisition_status),
    exportCell(row.risk),
    exportCell(row.legal_status),
    exportCell(row.documentation_status),
    exportCell(row.payment_status),
    exportCell(String(row.readiness_percent)),
    exportCell(row.negotiator_name),
    exportCell(row.manager_name),
    exportCell(exportTimestamp(row.updated_at)),
    exportCell(exportTimestamp(row.created_at)),
    exportCell(row.id),
  ];
}

export function propertyExportHeaderLine(): string {
  return `${PROPERTY_EXPORT_CSV_HEADERS.map((h) => csvEscapeCell(h)).join(',')}\r\n`;
}

export function propertyExportDataLine(row: PropertyExportSourceRow): string {
  return `${propertyExportRowCells(row).map((c) => csvEscapeCell(c)).join(',')}\r\n`;
}
