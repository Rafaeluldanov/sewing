/**
 * Source-level smoke-тесты этапа «Исправить формирование Потребности
 * цеха» (см. ТЗ «Исправить формирование "Потребности цеха" после
 * внедрения категорий, погонных метров и подтягивания данных в
 * техкарту»).
 *
 * Покрытие:
 *   1. Source recon: какие `sourceType`-ы создают `WorkshopNeed`.
 *   2. Shared `getWorkshopNeedKind` теперь учитывает `materialRole`:
 *      - PACKAGING → HARDWARE;
 *      - THREAD / FILLER / MAIN_FABRIC / RIB / LINING / INTERLINING /
 *        ADDITIONAL_FABRIC / MARKING → MATERIAL;
 *      - APPLICATION → APPLICATION.
 *   3. WorkshopNeedDto содержит новые опциональные поля
 *      (`hardwareSizeText`, `hardwareMaterialText`, `materialImageUrl`,
 *      `selectedColorText`, `requiresColorSelection`).
 *   4. Backend service пропускает техкартовый источник для
 *      category-driven заказов и обогащает PATTERN_PARAMETER_NORM /
 *      PATTERN_MATERIAL_AREA данными из техкарты.
 *   5. UI `/admin/workshop-needs` рендерит secondary-блок с
 *      hardware-метаданными и warning «Цвет нужно указать в заказе».
 *   6. Слово «Упаковка» по-прежнему не показывается, отдельной роли
 *      `HARDWARE` не появилось.
 *
 * Все проверки — source-level (без поднятия БД).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

import {
  WORKSHOP_NEED_SOURCE_TYPES,
  getWorkshopNeedKind,
} from '@sewing/shared/workshop-needs';

const repoRoot = path.resolve(__dirname, '..', '..');

function read(rel: string): string {
  return readFileSync(path.join(repoRoot, rel), 'utf8');
}

// ---------------------------------------------------------------------------
// 1. Shared: source-recon list, kind classifier
// ---------------------------------------------------------------------------

describe('Shared workshop-needs — source recon + classification', () => {
  test('WORKSHOP_NEED_SOURCE_TYPES перечисляет все sourceType-ы, включая PATTERN_MATERIAL_AREA', () => {
    expect(WORKSHOP_NEED_SOURCE_TYPES).toEqual([
      'TECH_CARD_MATERIAL_LINE',
      'ORDER_MATERIAL_REQUIREMENT',
      'ORDER_APPLICATION',
      'PATTERN_PARAMETER_NORM',
      'PATTERN_SIZE_PARAMETER_VALUE',
      'PATTERN_MATERIAL_AREA',
    ]);
  });

  test('getWorkshopNeedKind: PACKAGING → HARDWARE независимо от sourceType', () => {
    expect(
      getWorkshopNeedKind({
        sourceType: 'PATTERN_PARAMETER_NORM',
        calculationMethod: 'QTY_PER_UNIT',
        materialRole: 'PACKAGING',
      }),
    ).toBe('HARDWARE');
    // Тот же roleKey из техкарты тоже в HARDWARE.
    expect(
      getWorkshopNeedKind({
        sourceType: 'TECH_CARD_MATERIAL_LINE',
        calculationMethod: 'QTY_PER_UNIT',
        materialRole: 'PACKAGING',
      }),
    ).toBe('HARDWARE');
  });

  test('getWorkshopNeedKind: THREAD / FILLER / MAIN_FABRIC / LINING → MATERIAL даже для PATTERN_PARAMETER_NORM/QTY_PER_UNIT', () => {
    for (const role of [
      'THREAD',
      'FILLER',
      'INTERLINING',
      'MAIN_FABRIC',
      'ADDITIONAL_FABRIC',
      'RIB',
      'LINING',
      'MARKING',
    ] as const) {
      expect(
        getWorkshopNeedKind({
          sourceType: 'PATTERN_PARAMETER_NORM',
          calculationMethod: 'QTY_PER_UNIT',
          materialRole: role,
        }),
        `expected role=${role} to classify as MATERIAL`,
      ).toBe('MATERIAL');
    }
  });

  test('getWorkshopNeedKind: APPLICATION-роль / sourceType ORDER_APPLICATION → APPLICATION', () => {
    expect(
      getWorkshopNeedKind({
        sourceType: 'ORDER_APPLICATION',
        calculationMethod: 'QTY_PER_UNIT',
      }),
    ).toBe('APPLICATION');
    expect(
      getWorkshopNeedKind({
        sourceType: 'TECH_CARD_MATERIAL_LINE',
        calculationMethod: 'QTY_PER_UNIT',
        materialRole: 'APPLICATION',
      }),
    ).toBe('APPLICATION');
  });

  test('getWorkshopNeedKind: PATTERN_MATERIAL_AREA с MAIN_FABRIC → MATERIAL', () => {
    expect(
      getWorkshopNeedKind({
        sourceType: 'PATTERN_MATERIAL_AREA',
        calculationMethod: 'AREA_DENSITY',
        materialRole: 'MAIN_FABRIC',
      }),
    ).toBe('MATERIAL');
  });

  test('getWorkshopNeedKind: legacy строка без materialRole → fallback по sourceType', () => {
    expect(
      getWorkshopNeedKind({
        sourceType: 'TECH_CARD_MATERIAL_LINE',
        calculationMethod: 'QTY_PER_UNIT',
      }),
    ).toBe('MATERIAL');
    expect(
      getWorkshopNeedKind({
        sourceType: 'PATTERN_PARAMETER_NORM',
        calculationMethod: 'QTY_PER_UNIT',
      }),
    ).toBe('OTHER');
  });
});

// ---------------------------------------------------------------------------
// 2. Shared DTO: новые поля enrichment
// ---------------------------------------------------------------------------

describe('WorkshopNeedDto — новые поля enrichment', () => {
  const src = read('packages/shared/src/workshop-needs.ts');

  test('DTO объявляет hardwareSizeText / hardwareMaterialText / materialImageUrl / selectedColorText / requiresColorSelection', () => {
    expect(src).toMatch(/hardwareSizeText\?:\s*string\s*\|\s*null/);
    expect(src).toMatch(/hardwareMaterialText\?:\s*string\s*\|\s*null/);
    expect(src).toMatch(/materialImageUrl\?:\s*string\s*\|\s*null/);
    expect(src).toMatch(/selectedColorText\?:\s*string\s*\|\s*null/);
    expect(src).toMatch(/requiresColorSelection\?:\s*boolean/);
  });

  test('WorkshopNeedKindInput пробрасывает materialRole', () => {
    expect(src).toMatch(/materialRole\?:\s*WorkshopNeedDto\['materialRole'\]/);
  });

  test('PATTERN_MATERIAL_AREA задокументирован в WORKSHOP_NEED_SOURCE_TYPES', () => {
    expect(src).toMatch(/PATTERN_MATERIAL_AREA/);
  });
});

// ---------------------------------------------------------------------------
// 3. Backend service: category-driven detection + enrichment
// ---------------------------------------------------------------------------

describe('WorkshopNeedsService — category-driven + enrichment', () => {
  const src = read(
    'apps/api/src/modules/workshop-needs/workshop-needs.service.ts',
  );

  test('Сервис вычисляет isCategoryDriven по categoryId + наличию параметров', () => {
    expect(src).toMatch(/const isCategoryDriven = Boolean\(/);
    expect(src).toMatch(/order\.patternItem\?\.categoryId/);
    expect(src).toMatch(/parameterNorms\?\.length/);
    expect(src).toMatch(/sizeParameterValues\?\.length/);
    expect(src).toMatch(/materialAreas\?\.length/);
  });

  test('Техкарта НЕ создаёт standalone WorkshopNeed для category-driven заказа', () => {
    // Цикл по sourceLines обёрнут в `if (!isCategoryDriven)`.
    expect(src).toMatch(
      /if\s*\(!isCategoryDriven\)\s*\{[\s\S]*?for\s*\(const line of sourceLines\)/,
    );
  });

  test('PATTERN_MATERIAL_AREA создаётся ТОЛЬКО для category-driven заказа', () => {
    expect(src).toMatch(
      /if\s*\(isCategoryDriven\)\s*\{[\s\S]*?areasByRole/,
    );
    expect(src).toMatch(/computeMaterialAreaByRole/);
    expect(src).toMatch(/sourceType:\s*'PATTERN_MATERIAL_AREA'/);
  });

  test('PATTERN_PARAMETER_NORM получает enrichment из техкарты', () => {
    // computeParameterNorm теперь принимает matchedLine + orderColor.
    expect(src).toMatch(
      /computeParameterNorm\(\s*[\s\S]*?matchedLine:\s*SourceLine\s*\|\s*null,\s*orderColor:\s*string\s*\|\s*null/,
    );
    // Используется findEnrichmentLine.
    expect(src).toMatch(/findEnrichmentLine\({[\s\S]*?roleKey: norm\.roleKey/);
    // Description строится из labelSnapshot + hardwareSizeText + hardwareMaterialText + цвета.
    expect(src).toMatch(/hardwareSizeText/);
    expect(src).toMatch(/hardwareMaterialText/);
    expect(src).toMatch(/цвет \$\{resolvedColor\}/);
    // Warning «Цвет нужно указать в заказе» для ORDER_SELECTED_COLOR без selectedColorText.
    expect(src).toMatch(/'Цвет нужно указать в заказе'/);
    expect(src).toMatch(/colorRule === 'ORDER_SELECTED_COLOR'/);
  });

  test('findEnrichmentLine реализует exact + single-role match', () => {
    expect(src).toMatch(/private findEnrichmentLine\(/);
    // Exact match по нормализованному name/fabricType.
    expect(src).toMatch(/normalized\(c\.fabricType\)\s*===\s*target/);
    expect(src).toMatch(/normalized\(c\.name\)\s*===\s*target/);
    // Single-role fallback.
    expect(src).toMatch(/if\s*\(candidates\.length === 1\)\s*return\s+candidates\[0\]/);
    // Нормализация ё→е.
    expect(src).toMatch(/replace\(\/ё\/g,\s*'е'\)/);
  });

  test('toDto обогащает потребность hardware-полями из materialRequirements / techCard.materialLines', () => {
    expect(src).toMatch(/resolveWorkshopNeedEnrichment/);
    // include подтягивает snapshot + live техкарту с hardware-полями.
    expect(src).toMatch(/materialRequirements:\s*\{\s*select:[\s\S]*?hardwareSizeText:\s*true/);
    expect(src).toMatch(/techCard:\s*\{\s*select:\s*\{\s*materialLines/);
    // DTO включает enrichment.
    expect(src).toMatch(
      /hardwareSizeText:\s*enrichment\.hardwareSizeText/,
    );
    expect(src).toMatch(
      /requiresColorSelection:\s*enrichment\.requiresColorSelection/,
    );
  });

  test('SourceLine расширен полями hardware/image/color', () => {
    expect(src).toMatch(/hardwareSizeText:\s*string\s*\|\s*null/);
    expect(src).toMatch(/hardwareMaterialText:\s*string\s*\|\s*null/);
    expect(src).toMatch(/materialImageUrl:\s*string\s*\|\s*null/);
    expect(src).toMatch(/selectedColorText:\s*string\s*\|\s*null/);
    expect(src).toMatch(/requiresColorSelection:\s*boolean/);
  });

  test('audit log сохраняет isCategoryDriven и счётчик PATTERN_MATERIAL_AREA', () => {
    expect(src).toMatch(/isCategoryDriven,/);
    expect(src).toMatch(/PATTERN_MATERIAL_AREA:\s*methodMaterialArea/);
  });
});

// ---------------------------------------------------------------------------
// 4. UI: secondary block + color warning + materialRole в kind
// ---------------------------------------------------------------------------

describe('/admin/workshop-needs UI — enrichment + warning', () => {
  const inline = read(
    'apps/web/app/admin/workshop-needs/inline-edit-row.tsx',
  );
  const page = read('apps/web/app/admin/workshop-needs/page.tsx');

  test('классификация секции (getWorkshopNeedKind) живёт в page.tsx, а не в строке', () => {
    // Бейдж типа убран из строки вместе с построчным режимом —
    // классификацию по секциям (Материалы/Фурнитура/...) делает
    // только page.tsx (OrderNeedGroupCard).
    expect(inline).not.toMatch(/getWorkshopNeedKind/);
  });

  test('page.tsx (OrderNeedGroupCard) передаёт materialRole в getWorkshopNeedKind', () => {
    expect(page).toMatch(
      /getWorkshopNeedKind\({[\s\S]*?materialRole:\s*need\.materialRole/,
    );
  });

  test('inline-edit-row рисует secondary-строку (size · material · цвет)', () => {
    // В зональной строке вторичная подпись — зона «Расчёт», класс
    // `wn-desc__meta`, собирается из descSecondaryParts.
    expect(inline).toMatch(/wn-desc__meta/);
    expect(inline).toMatch(/need\.hardwareSizeText/);
    expect(inline).toMatch(/need\.hardwareMaterialText/);
    expect(inline).toMatch(/need\.selectedColorText/);
    // Использует разделитель «·».
    expect(inline).toMatch(/descSecondaryParts\.join\(' · '\)/);
  });

  test('inline-edit-row рисует preview изображения материала', () => {
    expect(inline).toMatch(/need\.materialImageUrl/);
    expect(inline).toMatch(/wn-desc__img/);
  });

  test('inline-edit-row показывает warning «Цвет нужно указать в заказе»', () => {
    expect(inline).toMatch(
      /need\.requiresColorSelection\s*&&\s*!need\.selectedColorText/,
    );
    expect(inline).toMatch(/Цвет нужно указать в заказе/);
    expect(inline).toMatch(/wn-desc__warning/);
  });
});

// ---------------------------------------------------------------------------
// 5. Anti-regressions: «Упаковка» + HARDWARE roleKey не появляются
// ---------------------------------------------------------------------------

describe('Anti-regressions: "Упаковка" не показывается, HARDWARE-роли нет', () => {
  test('Не появилось материальной роли HARDWARE', () => {
    const roles = read('packages/shared/src/material-roles.ts');
    expect(roles).not.toMatch(/'HARDWARE'/);
    const groups = read('packages/shared/src/pattern-categories.ts');
    expect(groups).not.toMatch(/roleKey:\s*'HARDWARE'/);
  });

  test('PACKAGING в UI лейблах остаётся "Фурнитура"', () => {
    const groups = read('packages/shared/src/pattern-categories.ts');
    expect(groups).toMatch(
      /roleKey:\s*'PACKAGING'[\s\S]*?label:\s*'Фурнитура'/,
    );
  });

  test('getTechCardMaterialRoleLabel НЕ возвращает "Упаковка"', () => {
    const tc = read('packages/shared/src/tech-cards.ts');
    expect(tc).toMatch(/legacy === 'Упаковка' \? 'Фурнитура' : legacy/);
  });
});
