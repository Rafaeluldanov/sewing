'use client';

/**
 * Кнопка «Создать заказ поставщику» из карточки/строки потребности
 * цеха (Этап 6А, см. `apps/api/src/modules/purchase-orders/*`,
 * `docs/recon-soft-integration.md §«Этап 6А»`).
 *
 * Используется в двух местах:
 *   - `/admin/workshop-needs/[id]` — одиночная кнопка по одной
 *     потребности (см. `EditWorkshopNeedForm`-обёртка);
 *   - `/admin/workshop-needs` — bulk-обёртка с checkbox-ами на
 *     списке (см. `BulkCreatePoToolbar` ниже).
 *
 * Состояние и валидация лежат полностью на backend
 * (`CreatePurchaseOrderFromNeedsSchema` + `PurchaseOrdersService`).
 * Здесь только:
 *   - собираем `workshopNeedIds[]` в form-data;
 *   - показываем pending/error/success;
 *   - при `redirectTo` уходим на карточку созданного PO.
 *
 * Кнопка/тулбар сознательно ничего не знает про supplier/order —
 * frontend-проверки (один поставщик / один заказ покупателя)
 * минимальны (см. `BulkCreatePoToolbar.canSubmit`), детали
 * валидирует backend.
 */

import { useEffect } from 'react';
import { useFormState, useFormStatus } from 'react-dom';
import { useRouter } from 'next/navigation';
import { CheckCircle, ShoppingCart, XCircle } from 'lucide-react';
import type { WorkshopNeedDto } from '@sewing/shared/workshop-needs';
import { createPurchaseOrderFromNeedsAction } from '../purchase-orders/actions';
import { initialCreatePurchaseOrderFromNeedsState } from '../purchase-orders/form-state';

function SubmitButton({
  count,
  disabled,
}: {
  count: number;
  disabled?: boolean;
}) {
  const { pending } = useFormStatus();
  const label =
    count > 1
      ? `Создать заказ поставщику (${count})`
      : 'Создать заказ поставщику';
  return (
    <button
      type="submit"
      className="admin-btn admin-btn--primary"
      disabled={pending || disabled}
    >
      <ShoppingCart size={16} strokeWidth={1.6} aria-hidden />
      {pending ? 'Создаём…' : label}
    </button>
  );
}

export function CreatePoFromSingleNeed({ need }: { need: WorkshopNeedDto }) {
  const router = useRouter();
  const [state, action] = useFormState(
    createPurchaseOrderFromNeedsAction,
    initialCreatePurchaseOrderFromNeedsState,
  );

  useEffect(() => {
    if (state.ok && state.redirectTo) {
      router.push(state.redirectTo);
    }
  }, [state.ok, state.redirectTo, router]);

  // Условия из ТЗ §14: кнопка должна быть видна, только если у
  // потребности есть поставщик из справочника, заполнено purchaseQty
  // и потребность не отменена и не уже заказана. Сами проверки
  // дублирует backend (`PurchaseOrdersService.createFromNeeds`),
  // здесь — UX-гейт, чтобы менеджер не получил «422» в лоб.
  const blockedReason = explainBlocked(need);
  if (blockedReason) {
    return (
      <div
        className="admin-muted"
        style={{ fontSize: '0.85rem', marginBottom: 8 }}
      >
        {blockedReason}
      </div>
    );
  }

  return (
    <form action={action} style={{ marginBottom: 8 }}>
      <input type="hidden" name="workshopNeedIds" value={need.id} />
      {state.error && (
        <div className="error-box" role="alert" style={{ marginBottom: 8 }}>
          <XCircle size={16} strokeWidth={1.6} aria-hidden /> {state.error}
        </div>
      )}
      {state.ok && (
        <div className="success-box" role="status" style={{ marginBottom: 8 }}>
          <CheckCircle size={16} strokeWidth={1.6} aria-hidden /> Заказ
          поставщику создан, переходим…
        </div>
      )}
      <SubmitButton count={1} />
    </form>
  );
}

function explainBlocked(need: WorkshopNeedDto): string | null {
  if (need.status === 'CANCELLED') {
    return 'Потребность отменена — заказ поставщику не создаётся.';
  }
  if (need.status === 'ORDERED') {
    return 'По этой потребности уже есть активный заказ поставщику.';
  }
  if (!need.selectedSupplierId) {
    return 'Выберите поставщика из справочника, чтобы создать заказ поставщику.';
  }
  if (!need.purchaseQty) {
    return 'Заполните «К закупке», чтобы создать заказ поставщику.';
  }
  return null;
}
