'use client';

/**
 * Bulk-toolbar «Создать заказ поставщику» для списка
 * `/admin/workshop-needs` (Этап 6А).
 *
 * Поведение:
 *   - в таблицу добавляется отдельная колонка checkbox-ов (см.
 *     `BulkCreatePoCheckbox`);
 *   - тулбар (`BulkCreatePoToolbar`) появляется фиксированной
 *     полоской снизу, когда выбрано ≥1 строки;
 *   - в тулбаре — счётчик и кнопка «Создать заказ поставщику».
 *
 * Frontend-валидация минимальная: показываем подсказку, если в
 * выборке встречаются разные supplier-ы или разные orderId, чтобы
 * менеджер сразу понимал, почему backend вернёт 422
 * (`PURCHASE_ORDER_NEEDS_DIFFERENT_*`). Сами проверки делает
 * `PurchaseOrdersService.createFromNeeds`.
 *
 * Используем React Context, чтобы checkbox-ы внутри RSC-таблицы
 * могли «дотянуться» до состояния выбора без props-drilling через
 * каждую ячейку.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { useFormState, useFormStatus } from 'react-dom';
import { useRouter } from 'next/navigation';
import { CheckCircle, ShoppingCart, XCircle } from 'lucide-react';
import type { WorkshopNeedListItemDto } from '@sewing/shared/workshop-needs';
import { createPurchaseOrderFromNeedsAction } from '../purchase-orders/actions';
import { initialCreatePurchaseOrderFromNeedsState } from '../purchase-orders/form-state';

interface SelectableNeed {
  id: string;
  orderId: string;
  selectedSupplierId: string | null;
  status: string;
  purchaseQty: string | null;
}

interface BulkContextShape {
  selectedIds: ReadonlySet<string>;
  toggle: (id: string) => void;
  isEligible: (need: SelectableNeed) => boolean;
}

const BulkCtx = createContext<BulkContextShape | null>(null);

function isEligible(need: SelectableNeed): boolean {
  if (need.status === 'CANCELLED' || need.status === 'ORDERED') return false;
  if (!need.selectedSupplierId) return false;
  if (!need.purchaseQty) return false;
  return true;
}

export function BulkCreatePoProvider({
  needs,
  children,
}: {
  needs: WorkshopNeedListItemDto[];
  children: ReactNode;
}) {
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );

  // Сбрасываем выбор, если набор показанных строк изменился (например,
  // менеджер сменил фильтр или открыл другую страницу пагинации).
  // Привязываемся к стабильному `key = ids.join(',')`, чтобы не
  // ловить лишние ре-рендеры на одинаковом наборе.
  const idsKey = needs.map((n) => n.id).join(',');
  useEffect(() => {
    setSelectedIds(new Set());
  }, [idsKey]);

  const toggle = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const value = useMemo<BulkContextShape>(
    () => ({ selectedIds, toggle, isEligible }),
    [selectedIds, toggle],
  );

  // Считаем «множественную правомерность»: один поставщик и один заказ
  // покупателя. Используется в тулбаре для показа предупреждения и
  // дизаблинга кнопки.
  const selected = needs.filter((n) => selectedIds.has(n.id));
  const supplierIds = new Set(
    selected.map((n) => n.selectedSupplierId).filter((v): v is string => !!v),
  );
  const orderIds = new Set(selected.map((n) => n.orderId));
  const sameSupplier = supplierIds.size <= 1;
  const sameCustomerOrder = orderIds.size <= 1;
  const allEligible = selected.length > 0 && selected.every(isEligible);
  const canSubmit =
    selected.length > 0 && allEligible && sameSupplier && sameCustomerOrder;

  return (
    <BulkCtx.Provider value={value}>
      {children}
      <BulkCreatePoToolbar
        selectedCount={selected.length}
        selectedIds={Array.from(selectedIds)}
        canSubmit={canSubmit}
        sameSupplier={sameSupplier}
        sameCustomerOrder={sameCustomerOrder}
        allEligible={allEligible}
      />
    </BulkCtx.Provider>
  );
}

export function BulkCreatePoCheckbox({
  need,
}: {
  need: WorkshopNeedListItemDto;
}) {
  const ctx = useContext(BulkCtx);
  if (!ctx) return null;
  const sel: SelectableNeed = {
    id: need.id,
    orderId: need.orderId,
    selectedSupplierId: need.selectedSupplierId,
    status: need.status,
    purchaseQty: need.purchaseQty,
  };
  const eligible = ctx.isEligible(sel);
  const checked = ctx.selectedIds.has(need.id);
  return (
    <input
      type="checkbox"
      aria-label={
        eligible
          ? 'Выбрать для заказа поставщику'
          : 'Нельзя добавить в заказ поставщику'
      }
      checked={checked}
      disabled={!eligible}
      onChange={() => ctx.toggle(need.id)}
      title={
        eligible
          ? undefined
          : 'Нет поставщика из справочника, не заполнено «К закупке», или строка уже заказана/отменена.'
      }
    />
  );
}

function SubmitButton({
  count,
  canSubmit,
}: {
  count: number;
  canSubmit: boolean;
}) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className="admin-btn admin-btn--primary"
      disabled={pending || !canSubmit || count === 0}
    >
      <ShoppingCart size={16} strokeWidth={1.6} aria-hidden />
      {pending
        ? 'Создаём…'
        : count > 1
          ? `Создать заказ поставщику (${count})`
          : 'Создать заказ поставщику'}
    </button>
  );
}

function BulkCreatePoToolbar({
  selectedCount,
  selectedIds,
  canSubmit,
  sameSupplier,
  sameCustomerOrder,
  allEligible,
}: {
  selectedCount: number;
  selectedIds: string[];
  canSubmit: boolean;
  sameSupplier: boolean;
  sameCustomerOrder: boolean;
  allEligible: boolean;
}) {
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

  if (selectedCount === 0) return null;

  const warnings: string[] = [];
  if (!sameSupplier) {
    warnings.push('В выборке разные поставщики — нужен один.');
  }
  if (!sameCustomerOrder) {
    warnings.push(
      'В выборке потребности из разных заказов покупателя — на MVP запрещено.',
    );
  }
  if (!allEligible) {
    warnings.push(
      'Хотя бы одна строка не подходит (нет поставщика, нет «К закупке», или уже заказана/отменена).',
    );
  }

  return (
    <div
      style={{
        position: 'sticky',
        bottom: 0,
        marginTop: 12,
        padding: 12,
        background: 'var(--admin-bg, #fff)',
        borderTop: '1px solid rgba(0,0,0,0.08)',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        zIndex: 5,
      }}
    >
      <form action={action} style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        {selectedIds.map((id) => (
          <input key={id} type="hidden" name="workshopNeedIds" value={id} />
        ))}
        <span style={{ fontWeight: 600 }}>Выбрано: {selectedCount}</span>
        <SubmitButton count={selectedCount} canSubmit={canSubmit} />
      </form>

      {warnings.length > 0 && (
        <div className="admin-muted" style={{ fontSize: '0.82rem' }}>
          {warnings.join(' ')}
        </div>
      )}

      {state.error && (
        <div className="error-box" role="alert">
          <XCircle size={16} strokeWidth={1.6} aria-hidden /> {state.error}
        </div>
      )}
      {state.ok && (
        <div className="success-box" role="status">
          <CheckCircle size={16} strokeWidth={1.6} aria-hidden /> Заказ
          поставщику создан, переходим…
        </div>
      )}
    </div>
  );
}
