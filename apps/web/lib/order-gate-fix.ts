/**
 * «Где исправить» для ошибок гейта перевода заказа в расчёт
 * (`OrdersService.startCalculation`, см. `apps/api/src/common/errors.ts`).
 *
 * Бэкенд отдаёт адресный код (`ORDER_CLIENT_REQUIRED`,
 * `ORDER_PATTERN_REQUIRED`, `ORDER_TECH_CARD_REQUIRED`,
 * `ORDER_ITEMS_REQUIRED`), а для пустой спецификации — ещё и `details`
 * с карточкой номенклатуры. Здесь этот контракт превращается в две
 * вещи для UI:
 *
 *   - `orderGateReturnStep` — на какой шаг мастера создания заказа
 *     вернуться (`/admin/orders/new`);
 *   - `orderGateFixLink` — внешняя ссылка, если лечится не в заказе,
 *     а в другой карточке (состав материалов живёт в номенклатуре:
 *     `/admin/patterns/:id`, раздел «Материалы (спецификация)»).
 *
 * Один модуль на оба потребителя — мастер (`wizard-actions.ts`) и
 * кнопку «Перевести в расчёт» в карточке заказа
 * (`app/orders/actions.ts::startCalculationOrderAction`), чтобы
 * маппинг код → место не расходился.
 */

import { ApiRequestError } from '@/lib/api';
import type { WizardStepId } from '@/app/admin/orders/new/wizard-steps';

/** Ссылка «где исправить» вне текущего экрана. */
export interface OrderGateFixLink {
  href: string;
  label: string;
}

/**
 * Шаг мастера, на котором закрывается гейт. Зеркало порядка проверок в
 * `OrdersService.startCalculation` и `calculationBlockCode` из
 * `@sewing/shared/order-transitions`.
 */
const RETURN_STEP_BY_CODE: Readonly<Record<string, WizardStepId>> = {
  ORDER_CLIENT_REQUIRED: 'client',
  ORDER_PATTERN_REQUIRED: 'product',
  ORDER_TECH_CARD_REQUIRED: 'product',
  ORDER_ITEMS_REQUIRED: 'colorways',
  ORDER_HAS_NO_ITEMS: 'colorways',
};

export function orderGateReturnStep(e: unknown): WizardStepId | null {
  if (!(e instanceof ApiRequestError) || !e.code) return null;
  return RETURN_STEP_BY_CODE[e.code] ?? null;
}

interface TechCardRequiredDetails {
  patternItemId: string;
  patternName: string;
  patternArticle: string | null;
}

function isTechCardDetails(d: unknown): d is TechCardRequiredDetails {
  if (!d || typeof d !== 'object') return false;
  const o = d as Record<string, unknown>;
  return (
    typeof o.patternItemId === 'string' &&
    o.patternItemId.length > 0 &&
    typeof o.patternName === 'string'
  );
}

/** Карточка номенклатуры, у которой надо заполнить спецификацию. */
export function patternSpecHref(patternItemId: string): string {
  return `/admin/patterns/${encodeURIComponent(patternItemId)}`;
}

export function orderGateFixLink(e: unknown): OrderGateFixLink | null {
  if (!(e instanceof ApiRequestError)) return null;
  if (e.code === 'ORDER_TECH_CARD_REQUIRED' && isTechCardDetails(e.details)) {
    return {
      href: patternSpecHref(e.details.patternItemId),
      label: `Открыть карточку «${e.details.patternName}»`,
    };
  }
  return null;
}
