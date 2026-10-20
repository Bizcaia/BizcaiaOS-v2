import type { PoolClient } from 'pg';
import type { Request, Response } from 'express';
import multer from 'multer';
import {
  PROPERTY_IMPORT_ERROR_MESSAGES,
  propertyExportDataLine,
  propertyExportFilename,
  propertyExportHeaderLine,
  propertyImportTemplateCsv,
  type PropertyExportSourceRow,
  type PropertyImportPreviewResult,
} from '../../shared/propertyCsvContract.js';
import { evaluatePropertyImport } from './evaluatePropertyImport.js';
import { parsePropertyImportCsv } from './parsePropertyCsv.js';
import { loadPropertyImportCsvMaxBytes } from './propertyImportConfig.js';

export function contentDispositionFilename(name: string): string {
  return name.replace(/[\r\n"]/g, '_');
}

function parseImportUpload(request: Request, response: Response, maxBytes: number): Promise<{ buffer: Buffer; size: number } | undefined> {
  const middleware = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxBytes },
  }).single('file');
  return new Promise((resolve, reject) => {
    middleware(request, response, (error: unknown) => {
      if (!error) {
        const file = request.file;
        resolve(file ? { buffer: file.buffer, size: file.size } : undefined);
        return;
      }
      if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
        const limited = Object.assign(new Error(PROPERTY_IMPORT_ERROR_MESSAGES.FILE_TOO_LARGE), {
          status: 400,
          code: 'FILE_TOO_LARGE',
        });
        reject(limited);
        return;
      }
      reject(error);
    });
  });
}

export async function readPropertyImportCsvFile(request: Request, response: Response): Promise<Buffer> {
  const maxBytes = loadPropertyImportCsvMaxBytes();
  const file = await parseImportUpload(request, response, maxBytes);
  if (!file?.buffer?.length) {
    throw Object.assign(new Error(PROPERTY_IMPORT_ERROR_MESSAGES.FILE_MISSING), {
      status: 400,
      code: 'FILE_MISSING',
    });
  }
  if (file.size > maxBytes || file.buffer.byteLength > maxBytes) {
    throw Object.assign(new Error(PROPERTY_IMPORT_ERROR_MESSAGES.FILE_TOO_LARGE), {
      status: 400,
      code: 'FILE_TOO_LARGE',
    });
  }
  return file.buffer;
}

export async function loadProjectCodeMap(client: PoolClient, organizationId: string, codes: string[]) {
  const unique = [...new Set(codes.filter(Boolean))];
  const map = new Map<string, string>();
  if (unique.length === 0) return map;
  const result = await client.query<{ id: string; code: string }>(
    `select id, code from public.projects where organization_id = $1 and code = any($2::text[])`,
    [organizationId, unique],
  );
  for (const row of result.rows) {
    map.set(row.code, row.id);
  }
  return map;
}

export async function loadExistingPropertyReferences(client: PoolClient, organizationId: string, references: string[]) {
  const unique = [...new Set(references.filter(Boolean))];
  const existing = new Set<string>();
  if (unique.length === 0) return existing;
  const result = await client.query<{ property_reference: string }>(
    `select property_reference from public.properties where organization_id = $1 and property_reference = any($2::text[])`,
    [organizationId, unique],
  );
  for (const row of result.rows) {
    existing.add(row.property_reference);
  }
  return existing;
}

export async function buildPropertyImportPreview(
  client: PoolClient,
  organizationId: string,
  buffer: Buffer,
): Promise<PropertyImportPreviewResult | { fileError: { code: string; message: string } }> {
  const parsed = parsePropertyImportCsv(buffer);
  if (!parsed.ok) {
    return { fileError: parsed.error };
  }
  const projectIdsByCode = await loadProjectCodeMap(
    client,
    organizationId,
    parsed.rows.map((row) => row.projectCode),
  );
  const existingReferences = await loadExistingPropertyReferences(
    client,
    organizationId,
    parsed.rows.map((row) => row.propertyReference),
  );
  return evaluatePropertyImport({
    rows: parsed.rows,
    fieldErrors: parsed.fieldErrors,
    projectIdsByCode,
    existingReferences,
  });
}

export function publicPreviewPayload(preview: PropertyImportPreviewResult) {
  return {
    totalRows: preview.totalRows,
    validCount: preview.validCount,
    rejectedCount: preview.rejectedCount,
    canCommit: preview.canCommit,
    rows: preview.rows,
  };
}

export async function insertImportedProperties(
  client: PoolClient,
  organizationId: string,
  accepted: NonNullable<PropertyImportPreviewResult['accepted']>,
) {
  const created: Array<Record<string, unknown>> = [];
  for (const row of accepted) {
    const result = await client.query(
      `insert into public.properties (
         organization_id, project_id, property_reference, title_number, tax_declaration, lot_number,
         area_hectares, municipality, province, barangay, acquisition_stage,
         assigned_negotiator_id, assigned_manager_id, risk
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'identified',null,null,$11)
       returning *`,
      [
        organizationId,
        row.projectId,
        row.propertyReference,
        row.titleNumber,
        row.taxDeclaration,
        row.lotNumber,
        row.areaHectares,
        row.municipality,
        row.province,
        row.barangay,
        row.risk,
      ],
    );
    created.push(result.rows[0]!);
  }
  return created;
}

export function writePropertyImportTemplate(response: Response) {
  const body = propertyImportTemplateCsv();
  response.setHeader('Content-Type', 'text/csv; charset=utf-8');
  response.setHeader('Content-Disposition', `attachment; filename="property-import-template.csv"`);
  response.status(200).send(body);
}

export function propertyListFilterClauses(query: {
  organizationId: string;
  projectId?: string;
  stage?: string;
  search?: string;
}) {
  const values: unknown[] = [query.organizationId];
  const where = ['p.organization_id=$1'];
  if (query.projectId) {
    values.push(query.projectId);
    where.push(`p.project_id=$${values.length}`);
  }
  if (query.stage) {
    values.push(query.stage);
    where.push(`p.acquisition_stage=$${values.length}`);
  }
  if (query.search) {
    values.push(`%${query.search}%`);
    where.push(
      `(p.property_reference ilike $${values.length} or coalesce(p.lot_number,'') ilike $${values.length} or coalesce(p.municipality,'') ilike $${values.length} or coalesce(p.barangay,'') ilike $${values.length})`,
    );
  }
  return { values, where };
}

export function exportSafetyMaxRows(): number | null {
  const raw = process.env.PROPERTY_EXPORT_SAFETY_MAX_ROWS;
  if (raw === undefined || raw === '') return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.floor(value);
}

export async function streamPropertiesExport(
  client: PoolClient,
  query: { organizationId: string; projectId?: string; stage?: string; search?: string },
  response: Response,
) {
  const { values, where } = propertyListFilterClauses(query);
  const safetyMax = exportSafetyMaxRows();
  if (safetyMax !== null) {
    const countResult = await client.query<{ count: string }>(
      `select count(*)::text as count from public.properties p where ${where.join(' and ')}`,
      values,
    );
    const count = Number(countResult.rows[0]?.count ?? 0);
    if (count > safetyMax) {
      throw Object.assign(
        new Error(
          `Export exceeds the server safety limit of ${safetyMax} rows. Narrow filters or raise PROPERTY_EXPORT_SAFETY_MAX_ROWS.`,
        ),
        { status: 422, code: 'EXPORT_SAFETY_LIMIT' },
      );
    }
  }

  const result = await client.query<PropertyExportSourceRow>(
    `select p.id, p.property_reference, pr.code as project_code, pr.name as project_name,
            p.title_number, p.tax_declaration, p.lot_number, p.area_hectares,
            p.municipality, p.province, p.barangay, p.acquisition_stage, p.acquisition_status,
            p.risk, p.legal_status, p.documentation_status, p.payment_status, p.readiness_percent,
            u.display_name as negotiator_name, m.display_name as manager_name,
            p.updated_at, p.created_at
       from public.properties p
       join public.projects pr on pr.id = p.project_id
       left join public.app_users u on u.id = p.assigned_negotiator_id
       left join public.app_users m on m.id = p.assigned_manager_id
      where ${where.join(' and ')}
      order by p.updated_at desc, p.id`,
    values,
  );

  const filename = contentDispositionFilename(propertyExportFilename(query.organizationId));
  response.setHeader('Content-Type', 'text/csv; charset=utf-8');
  response.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  response.write(propertyExportHeaderLine());
  for (const row of result.rows) {
    response.write(propertyExportDataLine(row));
  }
  response.end();
}
