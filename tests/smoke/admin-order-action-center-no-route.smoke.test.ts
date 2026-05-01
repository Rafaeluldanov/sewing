/**
 * Smoke-тест алерта «Маршрут не выбран — операции не рассчитаются»
 * в `OrderActionCenter` карточки заказа `/admin/orders/[id]`.
 *
 * Этап «План операций до запуска» (см. ТЗ «Подтягивать операции при
 * выборе маршрута, не ждать IN_PRODUCTION»):
 *   - источник истины — `Order.routeTemplateId` (поле в DTO);
 *   - алерт показываем только для статусов, где маршрут ещё имеет
 *     смысл проставить (DRAFT) или его отсутствие реально мешает
 *     закрыть расчёт (CALCULATION/CALCULATION_DONE);
 *   - после `start()` (`IN_PRODUCTION`) маршрут уже не выбрать —
 *     алерт сознательно не дублируем (план immutable, ADR-0006);
 *   - на DONE/CANCELLED не шумим;
 *   - CTA для DRAFT — открыть редактирование заказа (форма выбирает
 *     шаблон), для остальных — вкладку «Операции».
 *
 * ActionCenter — только actionable-задачи (см. JSDoc компонента),
 * поэтому этот алерт прямо ведёт пользователя к действию, а не к
 * абстрактному status dashboard.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const repoRoot = path.resolve(__dirname, '..', '..');

function read(rel: string): string {
  return readFileSync(path.join(repoRoot, rel), 'utf8');
}

const src = read('apps/web/components/orders/view/order-action-center.tsx');

describe('OrderActionCenter — алерт «Маршрут не выбран»', () => {
  test('алерт имеет id `no-route` и заголовок про маршрут/операции', () => {
    expect(src).toMatch(/id:\s*'no-route'/);
    expect(src).toMatch(
      /title:\s*'Маршрут не выбран — операции не рассчитаются'/,
    );
  });

  test('источник истины — order.routeTemplateId', () => {
    expect(src).toMatch(/!order\.routeTemplateId/);
  });

  test('алерт активен для DRAFT / CALCULATION / CALCULATION_DONE и НЕ для IN_PRODUCTION/DONE/CANCELLED', () => {
    const condIdx = src.indexOf("id: 'no-route'");
    expect(condIdx).toBeGreaterThan(0);
    const start = src.lastIndexOf('!order.routeTemplateId', condIdx);
    expect(start).toBeGreaterThan(0);
    const block = src.slice(start, condIdx);
    expect(block).toMatch(/'DRAFT'/);
    expect(block).toMatch(/'CALCULATION'/);
    expect(block).toMatch(/'CALCULATION_DONE'/);
    // Не показываем после запуска: маршрут уже неизменяем (ADR-0006).
    expect(block).not.toMatch(/'IN_PRODUCTION'/);
    expect(block).not.toMatch(/'DONE'/);
    expect(block).not.toMatch(/'CANCELLED'/);
  });

  test('CTA для DRAFT ведёт в редактирование заказа', () => {
    // Точная строка живёт в конструкции template literal; ищем
    // подстроку `/admin/orders/${order.id}/edit`.
    expect(src).toMatch(
      /label:\s*'Открыть редактирование'[\s\S]*?\/admin\/orders\/\$\{order\.id\}\/edit/,
    );
  });

  test('CTA для CALCULATION/CALCULATION_DONE отсутствует (cta: null)', () => {
    // Этап «edge cases после переноса OrderRouteStep[] snapshot в
    // DRAFT»: ранее CTA вёл во вкладку «Операции» — это вводило
    // менеджера в заблуждение, потому что вкладка read-only и не
    // даёт сменить маршрут. Поле `routeTemplateId` в форме edit
    // тоже `disabled={!isDraft}`. Поэтому теперь алерт остаётся
    // информационным без CTA: явная проблема, без ложного CTA.
    // Источник: `apps/web/components/orders/view/order-action-center.tsx`
    // (alert id `no-route`), и edit-form
    // `apps/web/app/admin/orders/[id]/edit/admin-edit-order-form.tsx`
    // (`disabled={!isDraft}` на routeTemplateId-селекте).
    const condIdx = src.indexOf("id: 'no-route'");
    expect(condIdx).toBeGreaterThan(0);
    // Берём кусок ровно до конца блока `no-route` alert (граница —
    // закрытие `alerts.push({ ... });`). Без этой границы slice
    // зацепил бы следующий алерт `operation-plan-stale`, у которого
    // CTA «Открыть операции» легитимный.
    const closeIdx = src.indexOf('});', condIdx);
    expect(closeIdx).toBeGreaterThan(condIdx);
    const block = src.slice(condIdx, closeIdx);
    // В non-DRAFT ветке CTA = null (тернарник по `status === 'DRAFT'`).
    expect(block).toMatch(
      /cta:\s*\n?\s*status\s*===\s*'DRAFT'\s*\?\s*\{[\s\S]*?\}\s*:\s*null/,
    );
    // CTA «Открыть операции» из ЭТОГО алерта удалён — иначе менеджер
    // тыкается в read-only вкладку.
    expect(block).not.toMatch(/Открыть операции/);
  });

  test('hint в CALCULATION/CALCULATION_DONE объясняет, что маршрут уже нельзя сменить', () => {
    // Объяснение, почему нет CTA: после расчёта routeTemplateId
    // редактировать нельзя (ORDER_LOCKED). Менеджер должен видеть,
    // что путь — отменить заказ и завести новый, а не искать
    // несуществующую кнопку «выбрать маршрут».
    expect(src).toMatch(/Сменить маршрут уже нельзя/);
  });

  test('DRAFT помечен как `warning`, CALCULATION/CALCULATION_DONE — `danger` (там это блокирует расчёт себестоимости)', () => {
    expect(src).toMatch(
      /tone:\s*status\s*===\s*'DRAFT'\s*\?\s*'warning'\s*:\s*'danger'/,
    );
  });
});
