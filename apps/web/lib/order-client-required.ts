/**
 * Этап «Клиент — обязательный атрибут заказа».
 *
 * Один текст ошибки и один гейт на все формы заказа (создание
 * `/admin/orders/new`, правка `/admin/orders/[id]/edit`, блок «Основное»
 * в карточке, легаси `/orders/*`), чтобы менеджер видел одну и ту же
 * формулировку независимо от того, откуда сохранял.
 *
 * Живёт отдельным lib-модулем, а не в `apps/web/app/orders/actions.ts`,
 * потому что из `'use server'`-файла можно экспортировать только
 * async-функции (Next 14) — константу оттуда переиспользовать нельзя.
 *
 * Контур обязательности целиком:
 *   - формы: `required`-селект «Клиент» без варианта «без клиента»;
 *   - server actions: этот гейт (`fieldErrors.clientId`);
 *   - backend: `OrdersService.startCalculation` → 400
 *     `ORDER_CLIENT_REQUIRED` (заказ без клиента не уедет дальше DRAFT)
 *     и `OrdersService.update` → тот же код на попытку снять клиента.
 */

export const CLIENT_REQUIRED_MESSAGE =
  'Выберите клиента — это обязательное поле заказа.';

export interface ClientRequiredError {
  error: string;
  fieldErrors: Record<string, string>;
}

/**
 * Проверяет FormData формы заказа на заполненность клиента.
 *
 * Различаем два случая:
 *   - поля `clientId` в FormData НЕТ → `null` (пропускаем). Так ходят
 *     пути без селекта клиента (прямой POST, CUTTER_ASSISTANT-flow);
 *     ломать их здесь нельзя — обязательность добьёт бизнес-гейт
 *     `startCalculation`;
 *   - поле есть и пустое → адресная ошибка на поле `clientId`. Для
 *     PATCH-путей это ещё и «попытка снять клиента», которую backend
 *     отбил бы кодом `ORDER_CLIENT_REQUIRED` — но лучше не ходить за
 *     этим в API.
 *
 * Нужен именно server-side гейт, а не только `required` в разметке:
 * часть путей собирает `new FormData(el)` без submit-а формы (опт-ин
 * «Настроить материалы» на `/admin/orders/new`), и нативная валидация
 * там не срабатывает.
 */
export function clientRequiredError(
  form: FormData,
): ClientRequiredError | null {
  const raw = form.get('clientId');
  if (raw === null) return null;
  if (String(raw).trim() !== '') return null;
  return {
    error: CLIENT_REQUIRED_MESSAGE,
    fieldErrors: { clientId: CLIENT_REQUIRED_MESSAGE },
  };
}
