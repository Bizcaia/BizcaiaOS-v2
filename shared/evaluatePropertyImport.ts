import {
  PROPERTY_IMPORT_ERROR_MESSAGES,
  buildPreviewResult,
  findIntraFileDuplicateReferences,
  type PropertyImportFieldError,
  type PropertyImportNormalizedRow,
  type PropertyImportPreviewResult,
  type PropertyImportPreviewRow,
} from './propertyCsvContract.js';

export type ProjectCodeMap = Map<string, string>;

/**
 * Apply intra-file duplicates, project resolution, and existing-reference conflicts
 * on top of field validation from parsePropertyImportCsv.
 */
export function evaluatePropertyImport(params: {
  rows: PropertyImportNormalizedRow[];
  fieldErrors: Map<number, PropertyImportFieldError[]>;
  projectIdsByCode: ProjectCodeMap;
  existingReferences: Set<string>;
}): PropertyImportPreviewResult {
  const { rows, fieldErrors, projectIdsByCode, existingReferences } = params;
  const duplicateRowNumbers = findIntraFileDuplicateReferences(rows);

  const previewRows: PropertyImportPreviewRow[] = [];
  const accepted: Array<PropertyImportNormalizedRow & { projectId: string }> = [];

  for (const row of rows) {
    const errors: PropertyImportFieldError[] = [...(fieldErrors.get(row.rowNumber) ?? [])];

    if (duplicateRowNumbers.has(row.rowNumber) && row.propertyReference) {
      errors.push({
        code: 'PROPERTY_REFERENCE_DUPLICATE_IN_FILE',
        message: PROPERTY_IMPORT_ERROR_MESSAGES.PROPERTY_REFERENCE_DUPLICATE_IN_FILE,
        column: 'propertyReference',
        originalValue: row.propertyReference,
      });
    }

    let projectId: string | null = null;
    if (row.projectCode) {
      const resolved = projectIdsByCode.get(row.projectCode);
      if (resolved) {
        projectId = resolved;
      } else if (!errors.some((error) => error.code === 'PROJECT_CODE_MISSING' || error.code === 'PROJECT_CODE_INVALID')) {
        errors.push({
          code: 'PROJECT_NOT_FOUND',
          message: PROPERTY_IMPORT_ERROR_MESSAGES.PROJECT_NOT_FOUND,
          column: 'projectCode',
          originalValue: row.projectCode,
        });
      }
    }

    if (
      row.propertyReference &&
      existingReferences.has(row.propertyReference) &&
      !errors.some((error) => error.code === 'PROPERTY_REFERENCE_DUPLICATE_IN_FILE')
    ) {
      errors.push({
        code: 'PROPERTY_REFERENCE_EXISTS',
        message: PROPERTY_IMPORT_ERROR_MESSAGES.PROPERTY_REFERENCE_EXISTS,
        column: 'propertyReference',
        originalValue: row.propertyReference,
      });
    }

    const rejected = errors.length > 0;
    previewRows.push({
      rowNumber: row.rowNumber,
      status: rejected ? 'rejected' : 'would_create',
      wouldCreate: !rejected,
      rejected,
      propertyReference: row.propertyReference,
      projectCode: row.projectCode,
      projectId,
      errors,
    });

    if (!rejected && projectId) {
      accepted.push({ ...row, projectId });
    }
  }

  return buildPreviewResult(previewRows, accepted);
}
