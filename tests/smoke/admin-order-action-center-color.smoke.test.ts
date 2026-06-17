/**
 * Smoke-тест алерта «Указать цвет» в `OrderActionCenter` карточки
 * заказа `/admin/orders/[id]` (этап «Указать в заказе», см. ТЗ §4).
 *
 * Архитектурное правило (см. JSDoc `OrderMaterialColorsCard` и
 * `MaterialColorForm`):
 *
 *   - Source of truth по «цвету позиции в заказе» —
 *     `OrderMaterialRequirement.selectedColorText` (поле в snapshot
 *     `OrderDetailDto.materialRequirements[]`).
 *   - `WorkshopNeed` намеренно НЕ source of truth — поэтому
 *     ActionCenter смотрит на `order.materialRequirements`, а НЕ на
 *     `WorkshopNeed[]`.
 *   - CTA ведёт на вкладку «Производство» к anchor-блоку
 *     `#order-material-colors`, где живёт primary-edit (reusable
 *     `MaterialColorForm`). Раньше блок был во вкладке «План».
 *   - Алерт показываем для статусов, где действие имеет смысл
 *     (DRAFT / CALCULATION / CALCULATION_DONE / IN_PRODUCTION).
 *     На DONE / CANCELLED не шумим.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const repoRoot = path.resolve(__dirname, '..', '..');

function read(rel: string): string {
  return readFileSync(path.join(repoRoot, rel), 'utf8');
}

const src = read('apps/web/components/orders/view/order-action-center.tsx');

describe('OrderActionCenter — алерт «По строкам техкарты нужно указать цвет»', () => {
  test('читает source of truth — order.materialRequirements (а не WorkshopNeed)', () => {
    expect(src).toMatch(/order\.materialRequirements\.some\(/);
    expect(src).toMatch(/requiresColorSelection\s*===\s*true/);
    expect(src).toMatch(/!r\.selectedColorText/);
    expect(src).toMatch(/!r\.resolvedColorText/);
    // Сознательно: WorkshopNeed внутри ActionCenter не дёргаем —
    // это derived view + warning, не source of truth. JSDoc может
    // упоминать имя в пояснении, поэтому проверяем именно
    // value-обращения (импорт / вызов / .property), а не строку.
    expect(src).not.toMatch(/from '@sewing\/shared\/workshop-needs'/);
    expect(src).not.toMatch(/getOrderWorkshopNeeds\b/);
    expect(src).not.toMatch(/\bworkshopNeeds\.\w/);
  });

  test('алерт имеет id `material-color-missing` и заголовок про цвет', () => {
    expect(src).toMatch(/id:\s*'material-color-missing'/);
    expect(src).toMatch(
      /title:\s*'По строкам техкарты нужно указать цвет для заказа'/,
    );
  });

  test('CTA ведёт на вкладку «Производство» к anchor #order-material-colors', () => {
    // Принимаем оба эквивалентных варианта склейки строки —
    // template literal `${orderTabHref('production')}#...` или
    // конкатенацию `orderTabHref('production') + '#...'`.
    expect(src).toMatch(
      /(?:\$\{orderTabHref\('production'\)\}#order-material-colors|orderTabHref\('production'\)\s*\+\s*'#order-material-colors')/,
    );
    expect(src).toMatch(/label:\s*'Указать цвет'/);
  });

  test('алерт показывается для DRAFT / CALCULATION / CALCULATION_DONE / IN_PRODUCTION', () => {
    // Все 4 статуса должны входить в условие — на DONE/CANCELLED
    // менеджеру уже нечего исправлять, не шумим.
    const condIdx = src.indexOf("id: 'material-color-missing'");
    expect(condIdx).toBeGreaterThan(0);
    // Окошко вокруг блока проверки — поищем условие непосредственно
    // перед alerts.push (в исходнике это `if (colorRequirementsMissing && (status === ...))`).
    const start = src.lastIndexOf('colorRequirementsMissing', condIdx);
    expect(start).toBeGreaterThan(0);
    const block = src.slice(start, condIdx);
    expect(block).toMatch(/'DRAFT'/);
    expect(block).toMatch(/'CALCULATION'/);
    expect(block).toMatch(/'CALCULATION_DONE'/);
    expect(block).toMatch(/'IN_PRODUCTION'/);
    expect(block).not.toMatch(/'DONE'/);
    expect(block).not.toMatch(/'CANCELLED'/);
  });

  test('IN_PRODUCTION помечен как `danger`, остальные — `warning` (не критический production-alert на DONE/CANCELLED)', () => {
    expect(src).toMatch(
      /tone:\s*status\s*===\s*'IN_PRODUCTION'\s*\?\s*'danger'\s*:\s*'warning'/,
    );
  });
});
