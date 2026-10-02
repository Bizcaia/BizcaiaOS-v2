import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as operationsSchemas from './operationsSchemas.js';
import * as organizationSchemas from './schemas.js';

// Candidate E: every request body is a strict object. An unknown top-level key
// is refused with 400 validation_error (issue code unrecognized_keys); the
// free-form fields metadata, settings, and contactDetails keep nested keys.
// The schemas are read from the routes themselves, so a new body route that
// parses with a non-strict schema fails here.
const HERE = dirname(fileURLToPath(import.meta.url));
const schemas: Record<string, unknown> = { ...operationsSchemas, ...organizationSchemas };
type Parser = { safeParse(value: unknown): { success: boolean; error?: { issues: { code: string; keys?: string[]; path: PropertyKey[] }[] } } };

function bodySchemaNames(file: string): string[] {
  const source = readFileSync(join(HERE, file), 'utf8');
  return [
    ...[...source.matchAll(/\b(\w+Schema)\.parse\(request\.body\)/g)].map((match) => match[1]),
    ...[...source.matchAll(/\bparse\((\w+Schema), request\.body\)/g)].map((match) => match[1]),
  ];
}
const bodySchemas = [...bodySchemaNames('operationsRoutes.ts'), ...bodySchemaNames('routes.ts')];

describe('request bodies refuse unknown top-level keys', () => {
  it('finds every body parse site in the routes (9 PATCH, 18 POST with a body)', () => {
    expect(bodySchemas).toHaveLength(27);
    for (const name of bodySchemas) expect(schemas[name], name).toBeDefined();
  });

  it.each(bodySchemas)('%s reports an unknown key as unrecognized_keys at the top level', (name) => {
    const result = (schemas[name] as Parser).safeParse({ unexpectedKey: 1 });
    expect(result.success).toBe(false);
    expect(result.error!.issues).toContainEqual(expect.objectContaining({ code: 'unrecognized_keys', keys: ['unexpectedKey'], path: [] }));
  });

  it('lists every unknown key, including prototype-like names, in one issue', () => {
    const result = operationsSchemas.updateTaskSchema.safeParse(JSON.parse('{"title":"T","a":1,"__proto__":{"x":1},"constructor":{}}'));
    expect(result.success).toBe(false);
    expect(result.error!.issues).toEqual([expect.objectContaining({ code: 'unrecognized_keys', keys: ['a', '__proto__', 'constructor'] })]);
  });

  it('keeps known, optional, nullable, and omitted fields working', () => {
    expect(operationsSchemas.updatePropertySchema.parse({})).toEqual({});
    expect(operationsSchemas.updatePropertySchema.parse({ municipality: null, risk: 'low' })).toEqual({ municipality: null, risk: 'low' });
    expect(operationsSchemas.createTaskSchema.parse({ title: 'T' })).toEqual({ title: 'T', priority: 'normal' });
  });

  it('keeps the specific refusal for lifecycle fields on property updates', () => {
    const result = operationsSchemas.updatePropertySchema.safeParse({ acquisitionStage: 'signing' });
    expect(result.error!.issues.map((issue) => issue.message)).toEqual(['Use a stage transition to change the acquisition stage']);
  });

  it('keeps nested keys inside the free-form fields', () => {
    const nested = { anything: { deep: [1, { two: 2 }] }, flag: true };
    expect(operationsSchemas.updatePropertySchema.parse({ metadata: nested })).toEqual({ metadata: nested });
    expect(operationsSchemas.createNegotiationEventSchema.parse({ eventType: 'note', metadata: nested })).toMatchObject({ metadata: nested });
    expect(organizationSchemas.updateOrganizationSchema.parse({ settings: nested })).toEqual({ settings: nested });
    expect(
      operationsSchemas.createOwnerSchema.parse({ organizationId: '11111111-1111-4111-8111-111111111111', ownerType: 'individual', displayName: 'A', contactDetails: nested }),
    ).toMatchObject({ contactDetails: nested });
  });
});
