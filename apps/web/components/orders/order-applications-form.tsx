'use client';

/**
 * `OrderApplicationsForm` — форма редактирования списка нанесений
 * в DRAFT-карточке заказа (`/admin/orders/[id]`).
 *
 * Используется только когда заказ в `DRAFT` (см. backend-инвариант
 * `ORDER_APPLICATION_ORDER_LOCKED`). Семантика — full replace списка
 * через `PUT /api/orders/:id/applications`.
 *
 * Архитектура:
 *   - сама форма — это лёгкая обёртка над общим клиентским
 *     `OrderApplicationsEditor` (см. `order-applications-editor.tsx`):
 *     editor владеет локальным state-ом строк и пишет hidden input
 *     `applicationsJson` с сериализованным массивом.
 *   - submit идёт через **стандартный** `<form action={formAction}>`
 *     + `useFormState`: это надёжный путь для server actions с
 *     FormData в Next.js 14 (нативное multipart-енкодирование, без
 *     ручного `new FormData(currentTarget)` и `startTransition`).
 *     До перехода на этот pattern форма теряла submit при некоторых
 *     рендерах — клиент вызывал server action напрямую через
 *     `startTransition`, и FormData не доходил до сервера в нужном
 *     виде.
 *   - `saveOrderApplicationsAction` делает `formData.get(
 *     'applicationsJson')`, парсит через
 *     `ReplaceOrderApplicationsSchema` и вызывает PUT-эндпоинт.
 *
 * UX:
 *   - кнопка «Добавить нанесение» (внутри editor-а) добавляет
 *     пустую строку с дефолтами `stage = CUT_PARTS`,
 *     `type = SCREEN_PRINT`, `status = PLANNED`, `unit = шт`;
 *   - кнопка «Сохранить нанесение» — submit формы (server action);
 *   - после успеха показываем `success-box`, после ошибки —
 *     `error-box` с сообщением и кодом из backend-а.
 */

import { useFormState, useFormStatus } from 'react-dom';
import { CheckCircle, Save, XCircle } from 'lucide-react';
import type { OrderApplicationDto } from '@sewing/shared/order-applications';
import {
  saveOrderApplicationsAction,
  initialOrderApplicationsFormState,
  type OrderApplicationsFormState,
} from '@/app/admin/orders/[id]/applications-actions';
import {
  OrderApplicationsEditor,
  applicationRowFromDto,
} from './order-applications-editor';

interface Props {
  orderId: string;
  initial: OrderApplicationDto[];
  /**
   * Размеры заказа для адресации нанесения «на выбранные размеры»
   * (этап «Нанесение по размерам»). Прокидываются в редактор.
   */
  availableSizes?: { id: string; code: string }[];
}

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className="admin-btn admin-btn--primary"
      disabled={pending}
    >
      <Save size={14} strokeWidth={1.6} aria-hidden />
      {pending ? 'Сохраняем…' : 'Сохранить нанесение'}
    </button>
  );
}

export function OrderApplicationsForm({
  orderId,
  initial,
  availableSizes = [],
}: Props) {
  // bind(null, orderId) — стандартный паттерн server-actions с
  // дополнительным id-параметром (см. `material-areas-form.tsx`,
  // `replacePatternMaterialAreasAction.bind(null, patternId)`).
  // Так Next.js встраивает orderId в action-id и FormData идёт
  // напрямую через `<form action>`, без manual-encoding на клиенте.
  const [state, formAction] = useFormState<OrderApplicationsFormState, FormData>(
    saveOrderApplicationsAction.bind(null, orderId),
    initialOrderApplicationsFormState,
  );

  return (
    <form
      action={formAction}
      className="admin-order-applications-form"
      style={{ display: 'flex', flexDirection: 'column', gap: 12 }}
    >
      <OrderApplicationsEditor
        initial={initial.map(applicationRowFromDto)}
        availableSizes={availableSizes}
      />

      <div
        style={{
          display: 'flex',
          gap: 8,
          flexWrap: 'wrap',
          alignItems: 'center',
        }}
      >
        <SubmitButton />
      </div>

      {state.error && (
        <div className="error-box" role="alert">
          <XCircle size={14} strokeWidth={1.6} aria-hidden /> {state.error}
        </div>
      )}
      {state.ok && state.successMessage && (
        <div className="success-box" role="status">
          <CheckCircle size={14} strokeWidth={1.6} aria-hidden />{' '}
          {state.successMessage}
        </div>
      )}
    </form>
  );
}
