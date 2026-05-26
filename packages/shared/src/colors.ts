/**
 * Канонизация поля «цвет» (Passport.color, Order.color и связанных).
 *
 * Причина: цвет — свободный текст, и пользователи вводят его в разных
 * регистрах / с лишними пробелами («Белый» / «белый» / « Белый »).
 * До нормализации это ломало однородность коробок в `PackingService`
 * (ADR-0011 §3, точное сравнение строк) и фильтры остатков WIP/FG.
 *
 * Канонический вид: `toLocaleLowerCase('ru')` после `.trim()` и
 * схлопывания внутренних пробелов. Буква «ё» НЕ заменяется на «е» —
 * это другая буква, и shopfloor-дисплей уже умеет сводить варианты
 * «черный»/«чёрный» к единому label на чтении (`normalizeColor` в
 * `apps/api/src/modules/shopfloor/shopfloor-projection.ts`).
 *
 * Используется и на входе (Zod-схемы, см. `CreateOrderSchema`,
 * `UpdateOrderSchema`, `UpdateOrderMaterialRequirementColorSchema`,
 * `CreateCutReleasePolicySchema`), и сервис-defensive (см.
 * `PassportsService.create` — копирование цвета из заказа/продукта).
 */
export function normalizeColor(input: string): string {
  return input
    .trim()
    .replace(/\s+/g, ' ')
    .toLocaleLowerCase('ru');
}

/**
 * То же, что `normalizeColor`, но принимает nullable-вход и схлопывает
 * пустую строку в `null`. Удобно для optional/nullable полей DTO и
 * сервисных fallbacks (`order.color ?? product.color`).
 */
export function normalizeColorOrNull(
  input: string | null | undefined,
): string | null {
  if (input === null || input === undefined) return null;
  const n = normalizeColor(input);
  return n === '' ? null : n;
}
