/**
 * Управленческие валюты MVP (см.
 * `docs/recon-soft-integration.md §«Себестоимость заказа»`,
 * `prisma/schema.prisma::OrderCostEstimate`,
 * `apps/api/src/modules/orders/orders.service.ts::completeCalculation`).
 *
 * На MVP закупщик выбирает валюту строки `WorkshopNeed` только из
 * двух фиксированных значений:
 *   - `RUB` — рубли (default-валюта учёта);
 *   - `USD` — доллары; при завершении расчёта закупщик руками
 *     указывает курс `usdRateRub`, и `OrderCostEstimateLine.lineTotalRub`
 *     считается как `purchaseQty × quotedPrice × usdRateRub`.
 *
 * Других валют сознательно нет — никаких exchange-rate API, никаких
 * тянущих курс из интернета (это явный non-goal задачи). Расширение
 * списка делается:
 *   1. добавить значение в `MONEY_CURRENCIES` ниже;
 *   2. добавить лейбл в `MONEY_CURRENCY_LABELS`;
 *   3. (если нужно) расширить расчёт `lineTotalRub` в
 *      `OrdersService.completeCalculation` — на MVP линейная
 *      конвертация только USD→RUB.
 */

import { z } from 'zod';

/**
 * Источник истины для allowed-валют. Используется и для Zod-валидации
 * (`MoneyCurrencySchema`), и для UI-селектов (`MONEY_CURRENCY_LABELS`).
 */
export const MONEY_CURRENCIES = ['RUB', 'USD'] as const;
export type MoneyCurrency = (typeof MONEY_CURRENCIES)[number];

/**
 * Человекочитаемые лейблы для select-а валюты в UI закупщика. Иконки
 * валюты «зашиты» в начало строки, чтобы select был самодостаточен и
 * не требовал отдельного компонента.
 */
export const MONEY_CURRENCY_LABELS: Record<MoneyCurrency, string> = {
  RUB: '₽ Рубли',
  USD: '$ Доллары',
};

/**
 * Zod-enum «допустимая валюта». Применяется в `WorkshopNeed`-PATCH
 * (`UpdateWorkshopNeedSchema.quotedCurrency`), `OrderCostEstimate`-DTO
 * и в любых будущих местах, где пользователь выбирает валюту.
 */
export const MoneyCurrencySchema = z.enum(MONEY_CURRENCIES);

/**
 * Optional + nullable variant: используем там, где валюта может
 * приходить как `null` (поле очищено) или вовсе отсутствовать в DTO
 * (поле не передано → backend оставляет колонку как есть).
 *
 * Пустую строку нормализуем в `null` — это удобно для select-ов с
 * опцией «Не выбрано», которые шлют `''` вместо отсутствия ключа.
 */
export const OptionalMoneyCurrencySchema = z
  .preprocess((v) => {
    if (v === undefined) return undefined;
    if (v === null) return null;
    if (typeof v === 'string') {
      const trimmed = v.trim();
      return trimmed === '' ? null : trimmed.toUpperCase();
    }
    return v;
  }, MoneyCurrencySchema.nullable().optional()) as unknown as z.ZodType<
    MoneyCurrency | null | undefined
  >;
