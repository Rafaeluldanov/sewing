/**
 * Smoke-сторожа блока «Материалы (спецификация)» карточки номенклатуры —
 * этап 1 плана «техкарты → номенклатура» (анализ 11.08.2026).
 *
 * Полноценного React-рендерера в vitest нет — идём текстовыми проверками
 * исходников, как соседние smoke. Фиксируем:
 *
 *   1. Карточка `/admin/patterns/[id]` рендерит блок и передаёт форме
 *      данные из DTO (`materialSpecLines` / `specParameters` /
 *      параметры категории для предзаполнения).
 *   2. Форма шлёт динамические строки под ключами `specline[...]` /
 *      `specparam[...]` — ровно их разбирает server action.
 *   3. Единицы строки — селекты из `@sewing/shared/purchase-units`
 *      (та же механика, что в спецификации расцветки заказа), а
 *      характеристика — общий `CharacteristicCombobox`.
 *   4. Server action валидирует полезную нагрузку общей схемой
 *      `ReplacePatternItemMaterialSpecSchema` и после успеха
 *      ревалидирует карточку.
 *   5. Контракт шарится с техкартой, а не копируется: строка
 *      спецификации собрана из `TechCardMaterialLineInputBaseSchema`
 *      (+ `normUnit`) — при удалении техкарт (этап 5) базовая схема
 *      переедет, но не разъедется.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const repoRoot = path.resolve(__dirname, '..', '..');

function readSrc(rel: string): string {
  return readFileSync(path.join(repoRoot, rel), 'utf8');
}

describe('карточка номенклатуры — блок «Материалы (спецификация)»', () => {
  test('страница рендерит блок и кормит форму данными DTO', () => {
    const src = readSrc('apps/web/app/admin/patterns/[id]/page.tsx');
    expect(src).toContain('Материалы (спецификация)');
    expect(src).toContain('PatternMaterialSpecForm');
    expect(src).toContain('pattern.materialSpecLines');
    expect(src).toContain('pattern.specParameters');
    expect(src).toContain('pattern.category?.parameters');
  });

  test('форма шлёт строки/слоты под ключами specline/specparam', () => {
    const src = readSrc(
      'apps/web/app/admin/patterns/[id]/material-spec-form.tsx',
    );
    expect(src).toContain('specline[${row.key}][materialRole]');
    expect(src).toContain('specline[${row.key}][normUnit]');
    expect(src).toContain('specline[${row.key}][unit]');
    expect(src).toContain('specparam[${p.key}][key]');
    // Привязка «ячейка → параметр» едет через formKey строки, как в
    // форме техкарты.
    expect(src).toContain('specline[${row.key}][formKey]');
  });

  test('единицы — из shared/purchase-units, характеристика — общий комбобокс', () => {
    const src = readSrc(
      'apps/web/app/admin/patterns/[id]/material-spec-form.tsx',
    );
    expect(src).toContain("from '@sewing/shared/purchase-units'");
    expect(src).toContain('getNormUnitOptions');
    expect(src).toContain('getPurchaseUnitOptions');
    expect(src).toContain('CharacteristicCombobox');
    // Предзаполнение из группы — клиентское, по параметрам категории
    // карточки (server action не нужен).
    expect(src).toContain('handlePullFromCategory');
    expect(src).toContain("p.inputType !== 'TEXT_ONLY'");
  });

  test('server action валидирует общей схемой и ревалидирует карточку', () => {
    const src = readSrc('apps/web/app/admin/patterns/actions.ts');
    expect(src).toContain('replacePatternItemMaterialSpecAction');
    expect(src).toContain('ReplacePatternItemMaterialSpecSchema.safeParse');
    expect(src).toContain('replacePatternItemMaterialSpec(patternId');
    expect(src).toContain('revalidatePath(`/admin/patterns/${patternId}`)');
  });

  test('shared-контракт наследует строку техкарты, а не копирует её', () => {
    const src = readSrc('packages/shared/src/pattern-item-spec.ts');
    expect(src).toContain('TechCardMaterialLineInputBaseSchema.extend');
    expect(src).toContain('normUnit');
    expect(src).toContain('withParameterCrossChecks');
  });

  test('backend: ручка PUT material-spec и спецификация в детальном DTO', () => {
    const controller = readSrc(
      'apps/api/src/modules/patterns/patterns.controller.ts',
    );
    expect(controller).toContain("@Put(':id/material-spec')");
    const service = readSrc(
      'apps/api/src/modules/patterns/patterns.service.ts',
    );
    expect(service).toContain('replaceMaterialSpec');
    expect(service).toContain('materialSpecLines');
    // Клонирование обязано копировать спецификацию — иначе копия
    // молча теряла бы состав.
    expect(service).toContain('patternItemMaterialLine.createMany');
  });
});
