import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const CSV_PARSE_IMPORT = /(?:from|import)\s*['"]csv-parse(?:\/[^'"]*)?['"]/;
const SERVER_PARSE_IMPORT = /(?:from|import)\s*['"][^'"]*server\/imports\/parsePropertyCsv['"]/;
const BUFFER_USE = /\bBuffer\b/;

/**
 * Regression: demo/browser must not pull Node CSV parsing (Buffer) into the Vite client bundle.
 * That caused production white-screen: Uncaught ReferenceError: Buffer is not defined.
 */
describe('CSV import browser boundary', () => {
  it('operationsApi does not import Node CSV parse modules', () => {
    const source = readFileSync(resolve(__dirname, 'operationsApi.ts'), 'utf8');
    expect(source).not.toMatch(CSV_PARSE_IMPORT);
    expect(source).not.toMatch(SERVER_PARSE_IMPORT);
  });

  it('shared browser parser does not import Node CSV libraries or Buffer', () => {
    const source = readFileSync(resolve(__dirname, '../../shared/parsePropertyImportCsv.ts'), 'utf8');
    expect(source).not.toMatch(CSV_PARSE_IMPORT);
    expect(source).not.toMatch(BUFFER_USE);
  });

  it('shared finalize helper does not import Node CSV libraries or Buffer', () => {
    const source = readFileSync(resolve(__dirname, '../../shared/finalizePropertyImportRecords.ts'), 'utf8');
    expect(source).not.toMatch(CSV_PARSE_IMPORT);
    expect(source).not.toMatch(BUFFER_USE);
  });

  it('production client assets (if present) do not embed csv-parse Buffer.from newline probes', () => {
    const assetsDir = resolve(__dirname, '../../dist/assets');
    let jsFiles: string[] = [];
    try {
      jsFiles = readdirSync(assetsDir).filter((name) => name.endsWith('.js'));
    } catch {
      return;
    }
    if (jsFiles.length === 0) return;

    // Signature from csv-parse/sync when bundled for browser (module-init Buffer.from for newlines).
    const csvParseBufferProbe = /Buffer\.from\(`\\n`\)|Buffer\.from\(`\n`\)|Buffer\.from\("\\n"\)/;
    for (const name of jsFiles) {
      const bundle = readFileSync(resolve(assetsDir, name), 'utf8');
      expect(bundle, `${name} must not embed csv-parse Buffer newline probes`).not.toMatch(csvParseBufferProbe);
    }
  });
});
