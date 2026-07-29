/**
 * Source-level smoke-тесты правила «материал убрали из спецификации заказа →
 * потребности по нему нет».
 *
 * Засада, которую они сторожат: количество для category-driven заказа берётся
 * из номенклатуры (`PatternItemParameterNorm`), а норма одна на ВСЕ заказы.
 * Удаление строки живёт только в снимке заказа (`OrderMaterialRequirement`),
 * поэтому цикл по нормам обязан спрашивать снимок — иначе удалённая в заказе
 * «Киперная лента» возвращается в потребность на первом же пересчёте
 * (заказ 02-00002, 29.07.2026).
 *
 * Все проверки — source-level (без поднятия БД).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const repoRoot = path.resolve(__dirname, '..', '..');

function read(rel: string): string {
  return readFileSync(path.join(repoRoot, rel), 'utf8');
}

const SERVICE = 'apps/api/src/modules/workshop-needs/workshop-needs.service.ts';

describe('потребности: убранный из заказа материал не возвращается', () => {
  test('цикл по нормам номенклатуры проверяет снимок заказа', () => {
    const src = read(SERVICE);
    expect(src).toContain('isNormRemovedFromSpec');

    const loopStart = src.indexOf('for (const norm of order.patternItem?.parameterNorms');
    expect(loopStart).toBeGreaterThan(-1);
    const loopBody = src.slice(loopStart, loopStart + 1600);
    // Гейт стоит ДО создания строки потребности.
    expect(loopBody.indexOf('isNormRemovedFromSpec')).toBeGreaterThan(-1);
    expect(loopBody.indexOf('isNormRemovedFromSpec')).toBeLessThan(
      loopBody.indexOf('computeParameterNorm('),
    );
  });

  test('решение опирается на явную привязку снимка к норме (qtySourceRef)', () => {
    const src = read(SERVICE);
    // Привязка доезжает из снимка в SourceLine…
    expect(src).toContain('qtySourceRef: r.qtySourceRef');
    // …и live-техкарта её не имеет (там правок заказа нет по определению).
    expect(src).toContain('qtySourceRef: null');
    // …и по ней принимается решение.
    expect(src).toMatch(/qtySourceRef === norm\.id/);
  });

  test('legacy-снимок без привязок работает как раньше', () => {
    const src = read(SERVICE);
    const start = src.indexOf('private isNormRemovedFromSpec');
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf('private findEnrichmentLine'));
    // Нет ни одной строки с привязкой → не считаем «убрали».
    expect(body).toMatch(/some\(\(l\) => l\.qtySourceRef\)\) return false/);
    // Строка снимка нашлась обогащением → не считаем «убрали».
    expect(body).toContain('if (matchedLine) return false');
    // Источник — только снимок заказа, live-техкарта не решает.
    expect(body).toContain("l.source === 'ORDER_MATERIAL_REQUIREMENT'");
  });
});
