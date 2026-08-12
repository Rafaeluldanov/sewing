/**
 * Smoke-тест MVP-2 (ADR-0022 §«Cut-ready readiness»).
 *
 * Полноценного React-рендерера в vitest у нас нет, поэтому
 * фиксируем контракт между UI и backend текстовыми проверками
 * исходников:
 *   1. Shared DTO содержат `OutsourceTriggerType`, `triggerType`,
 *      `isReadyToOrder`, `readinessLabel`.
 *   2. Backend `OrdersService` снимает snapshot triggerType и
 *      деривит `isReadyToOrder` по `Passport.currentCellId`.
 *   3. Карточка заказа `/orders/[id]` читает derived поля и
 *      отображает обе фразы готовности.
 *   4. Admin-форма техкарты содержит `select` triggerType и
 *      обе человекочитаемые подписи.
 *   5. В блоке внешних потребностей карточки заказа по-прежнему
 *      нет edit-контролов (read-only).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const repoRoot = path.resolve(__dirname, '..', '..');
function readSrc(rel: string): string {
  return readFileSync(path.join(repoRoot, rel), 'utf8');
}

describe('shared DTO — OutsourceTriggerType / readiness', () => {
  test('tech-cards.ts объявляет enum и поле triggerType в DTO', () => {
    const src = readSrc('packages/shared/src/tech-cards.ts');
    expect(src).toMatch(/OUTSOURCE_TRIGGER_TYPES/);
    expect(src).toMatch(/'MANUAL'/);
    expect(src).toMatch(/'CUT_READY'/);
    expect(src).toMatch(/export type OutsourceTriggerType/);
    expect(src).toMatch(/triggerType:\s*OutsourceTriggerType/);
  });

  test('orders.ts реэкспортирует enum и расширяет OrderOutsourceRequirementDto', () => {
    const src = readSrc('packages/shared/src/orders.ts');
    expect(src).toMatch(/OutsourceTriggerType/);
    expect(src).toMatch(/triggerType:\s*OutsourceTriggerType/);
    expect(src).toMatch(/isReadyToOrder:\s*boolean/);
    expect(src).toMatch(/readinessLabel:\s*string \| null/);
  });

  test('Prisma schema содержит enum OutsourceTriggerType и поля triggerType', () => {
    const src = readSrc('prisma/schema.prisma');
    expect(src).toMatch(/enum OutsourceTriggerType/);
    expect(src).toMatch(/MANUAL/);
    expect(src).toMatch(/CUT_READY/);
    // Этап 5 «техкарты → номенклатура»: template-строк больше нет,
    // поле живёт в snapshot заказа (исторические данные + статусы).
    const matches = src.match(
      /triggerType\s+OutsourceTriggerType\s+@default\(MANUAL\)/g,
    );
    expect(matches?.length ?? 0).toBeGreaterThanOrEqual(1);
  });
});

describe('backend — orders.service derives readiness', () => {

  test('OrdersService.toDetailDto() считает isCutReadyForOrder и маппит обе фразы', () => {
    const src = readSrc('apps/api/src/modules/orders/orders.service.ts');
    expect(src).toMatch(/isCutReadyForOrder/);
    expect(src).toMatch(/order\.passports\.every/);
    expect(src).toMatch(/currentCellId\s*!==\s*null/);
    expect(src).toMatch(/'Готово к заказу'/);
    expect(src).toMatch(/'Ожидает размещения кроя'/);
  });
});

describe('order detail page — readiness indicator', () => {
  test('страница читает triggerType / isReadyToOrder / readinessLabel', () => {
    const src = readSrc('apps/web/app/orders/[id]/page.tsx');
    expect(src).toMatch(/triggerType\s*===\s*'CUT_READY'/);
    expect(src).toMatch(/isReadyToOrder/);
    expect(src).toMatch(/readinessLabel/);
  });

  test('блок Внешние потребности не содержит inline edit-контролов (MVP-3, ADR-0022)', () => {
    // MVP-3 добавил две кнопки-action-а под строкой («Отметить как
    // заказано» / «Отметить как получено»), но они вынесены в
    // отдельный client-компонент `OutsourceStatusActions`. В самой
    // карточке `OutsourceSnapshotCard` (RSC) по-прежнему нет
    // <input>/<form>/<select>/<onChange>: vendor/qty/note остаются
    // read-only, никаких dropdown-ов «выбрать новый статус» в
    // карточке нет. Контракт «не превращаем в ERP-форму».
    const src = readSrc('apps/web/app/orders/[id]/page.tsx');
    const idx = src.indexOf('function OutsourceSnapshotCard');
    expect(idx).toBeGreaterThan(0);
    const end = src.indexOf('\n}\n', idx);
    expect(end).toBeGreaterThan(idx);
    const block = src.slice(idx, end);
    expect(block).not.toMatch(/<input/);
    expect(block).not.toMatch(/<form/);
    expect(block).not.toMatch(/<select/);
    expect(block).not.toMatch(/onSubmit/);
    expect(block).not.toMatch(/onChange/);
  });
});

