/**
 * Smoke-сторожа фичи «единица закупки — списком + авторасчёт черновика»
 * (07.08.2026). Текстовые проверки исходников, как в соседних smoke.
 *
 * Что фиксируем:
 *   1. Единицы строки материала выбираются СЕЛЕКТАМИ (норма и закупка
 *      отдельно), свободного текстового ввода единицы больше нет.
 *   2. Словарь опций живёт в shared (`purchase-units.ts`) и согласован с
 *      пересчётом: сравнение написаний — той же `normalizeUnit`, что в
 *      `norm-purchase.ts`; subpath задекларирован в exports-карте пакета.
 *   3. Черновик пачки умеет уезжать сразу расщеплённым (`normUnit` в
 *      payload) и показывает закупку до сохранения.
 *   4. Смена единицы строки потребности обесценивает закупочный блок:
 *      цена/«К закупке»/упаковка вводились за старую единицу и сбрасываются
 *      (тот же принцип, что у carry-ключа пересчёта).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const repoRoot = path.resolve(__dirname, '..', '..');

function readSrc(rel: string): string {
  return readFileSync(path.join(repoRoot, rel), 'utf8');
}

describe('единица закупки — списком', () => {
  test('единицы строки выбираются селектами, свободный ввод убран', () => {
    const src = readSrc(
      'apps/web/components/orders/colorways/colorway-spec.tsx',
    );
    // По селекту нормы и закупки у сохранённой строки И у черновика.
    expect(src.match(/aria-label="Единица закупки"/g) ?? []).toHaveLength(2);
    expect(src.match(/aria-label="Единица нормы"/g) ?? []).toHaveLength(2);
    expect(src).toMatch(/getPurchaseUnitOptions\(/);
    expect(src).toMatch(/getNormUnitOptions\(/);
    // Свободный текстовый ввод единицы черновика убран вместе с плейсхолдером.
    expect(src).not.toMatch(/placeholder="ед\."/);
  });

  test('словарь единиц живёт в shared и согласован с пересчётом', () => {
    const units = readSrc('packages/shared/src/purchase-units.ts');
    expect(units).toMatch(/export function getPurchaseUnitOptions/);
    expect(units).toMatch(/export function getNormUnitOptions/);
    // Сравнение написаний — той же нормализацией, что у пересчёта.
    expect(units).toMatch(/import \{ normalizeUnit \} from '\.\/norm-purchase'/);
    expect(readSrc('packages/shared/src/norm-purchase.ts')).toMatch(
      /export function normalizeUnit/,
    );
    // Subpath задекларирован: tsc по paths прошёл бы и без него, а runtime —
    // нет (прецедент — сторож pattern-categories).
    const pkg = JSON.parse(readSrc('packages/shared/package.json')) as {
      exports: Record<string, string>;
    };
    expect(pkg.exports['./purchase-units']).toBe('./src/purchase-units.ts');
  });

  test('черновик уезжает расщеплённым и показывает закупку до сохранения', () => {
    const src = readSrc(
      'apps/web/components/orders/colorways/colorway-spec.tsx',
    );
    // payload пачки шлёт normUnit, когда единицы разошлись.
    expect(src).toMatch(/normUnit: needsPurchaseConversion\(d\.normUnit, d\.unit\)/);
    // Живой предпросчёт закупки у черновика: совпали единицы — число,
    // разошлись — честный прочерк (ширины и плотности ещё нет).
    expect(src).toMatch(/needsPurchaseConversion\(d\.normUnit, d\.unit\)/);
    expect(src).toMatch(/draftSplit/);
  });

  test('смена единицы потребности сбрасывает закупочный блок', () => {
    const src = readSrc(
      'apps/api/src/modules/workshop-needs/workshop-needs.service.ts',
    );
    const body = src.slice(
      src.indexOf('async update('),
      src.indexOf('async cancel('),
    );
    // Смысловая смена единицы — НОРМАЛИЗОВАННО («м пог» ≡ «м пог.»),
    // косметическая правка написания цену не трогает.
    expect(body).toMatch(
      /normalizeUnit\(dto\.unit\) !== normalizeUnit\(existing\.unit\)/,
    );
    // Блок сброса закупочного блока при смене единицы.
    expect(body).toMatch(/if \(compositionChanged\.unit\)/);
    expect(body).toMatch(/data\[field\] = null/);
    expect(body).toMatch(/resetField\('purchaseQty'/);
    expect(body).toMatch(/resetField\('packSize'/);
    expect(body).toMatch(/resetField\('quotedPrice'/);
    // Валюта гасится только если её не переписали этим же запросом.
    expect(body).toMatch(/dto\.quotedCurrency === undefined/);
    expect(body).toMatch(/resetByUnitChange/);
  });
});
