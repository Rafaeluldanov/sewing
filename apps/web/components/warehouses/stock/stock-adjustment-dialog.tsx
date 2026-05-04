'use client';

/**
 * `StockAdjustmentDialog` — inline-форма ручной корректировки
 * остатка для вкладки «Остатки» в `/admin/warehouses?tab=balances`.
 *
 * UI-решение владельца проекта (см. ТЗ): не делать новую страницу /
 * новый пункт меню, а добавить inline-панель прямо над таблицей.
 * Открывается по `StockAdjustmentButton`, рендерится в той же
 * card-обёртке. После успешного submit панель закрывается и
 * `revalidatePath('/admin/warehouses')` перерисовывает balances и
 * movements (см. `createStockAdjustmentAction`).
 *
 * Контракт формы (см. backend
 * `apps/api/src/modules/stock/dto/create-stock-adjustment.dto.ts`):
 *   - select остатка из текущей страницы balances (MVP: корректируем
 *     только существующий `StockBalance`);
 *   - direction `IN` (увеличить) / `OUT` (уменьшить);
 *   - qty > 0 (text input с `inputMode="decimal"`);
 *   - unitCost виден и активен только при IN; для OUT поясняем,
 *     что складская оценка берётся из текущего `StockBalance.unitCost`;
 *   - comment обязателен (placeholder «Причина корректировки»);
 *   - `clientRequestId` — uuid, сгенерированный единожды на mount
 *     (защита от двойного submit; при ретрае с тем же id backend
 *     вернёт уже существующее движение и не задвоит).
 *
 * Сознательная простота:
 *   - inline-панель, без модального оверлея / focus-trap (тот же
 *     паттерн, что у `CreateMaterialIssueDialog`);
 *   - без раздельных field-errors — backend message-а достаточно
 *     для UI MVP. `MATERIAL_STOCK_INSUFFICIENT` (409) показываем как
 *     понятный текст, без raw JSON;
 *   - идемпотентный технический ключ движения пользователю не виден.
 */

import { useEffect, useMemo, useState } from 'react';
import { CheckCircle, X } from 'lucide-react';
import { createStockAdjustmentAction } from '@/app/admin/warehouses/actions';
import {
  initialStockAdjustmentState,
  type StockAdjustmentState,
} from '@/app/admin/warehouses/form-state';
import type { StockBalanceListItem } from '@/lib/stock-api';

interface Props {
  balances: StockBalanceListItem[];
  /** Если задан, форма открывается с уже выбранным остатком. */
  initialStockBalanceId?: string | null;
  onClose: () => void;
}

function makeClientRequestId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function formatBalanceLabel(b: StockBalanceListItem): string {
  const where = [b.warehouseName, b.cellCode]
    .filter((v): v is string => typeof v === 'string' && v.length > 0)
    .join(' / ');
  const qtyText = `${String(b.qty)} ${b.unit}`.trim();
  const tail = where.length > 0 ? ` · ${where}` : '';
  return `${b.description} — ${qtyText}${tail}`;
}

export function StockAdjustmentDialog({
  balances,
  initialStockBalanceId,
  onClose,
}: Props) {
  const initialId = useMemo(() => {
    if (
      initialStockBalanceId &&
      balances.some((b) => b.id === initialStockBalanceId)
    ) {
      return initialStockBalanceId;
    }
    return balances[0]?.id ?? '';
  }, [initialStockBalanceId, balances]);

  const [stockBalanceId, setStockBalanceId] = useState<string>(initialId);
  const [direction, setDirection] = useState<'IN' | 'OUT'>('IN');
  const [qty, setQty] = useState<string>('');
  const [unitCost, setUnitCost] = useState<string>('');
  const [comment, setComment] = useState<string>('');
  const [clientRequestId] = useState<string>(() => makeClientRequestId());
  const [submitting, setSubmitting] = useState(false);
  const [state, setState] = useState<StockAdjustmentState>(
    initialStockAdjustmentState,
  );

  // Если remote update изменил список balances и текущий id больше
  // не существует — переключаемся на первый доступный.
  useEffect(() => {
    if (balances.length === 0) return;
    if (!balances.some((b) => b.id === stockBalanceId)) {
      setStockBalanceId(balances[0].id);
    }
  }, [balances, stockBalanceId]);

  const selected = balances.find((b) => b.id === stockBalanceId) ?? null;

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (submitting) return;
    if (!stockBalanceId) {
      setState({ ok: false, error: 'Выберите остаток для корректировки.' });
      return;
    }
    const trimmedComment = comment.trim();
    if (trimmedComment.length < 2) {
      setState({ ok: false, error: 'Укажите причину корректировки (минимум 2 символа).' });
      return;
    }
    if (qty.trim() === '') {
      setState({ ok: false, error: 'Укажите количество корректировки.' });
      return;
    }

    setSubmitting(true);
    setState(initialStockAdjustmentState);
    try {
      const result = await createStockAdjustmentAction({
        stockBalanceId,
        direction,
        qty: qty.trim().replace(',', '.'),
        ...(direction === 'IN' && unitCost.trim().length > 0
          ? { unitCost: unitCost.trim().replace(',', '.') }
          : {}),
        comment: trimmedComment,
        clientRequestId,
      });
      setState(result);
      if (result.ok) {
        onClose();
      }
    } finally {
      setSubmitting(false);
    }
  }

  if (balances.length === 0) {
    return (
      <div
        className="stock-adjustment-dialog"
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          padding: 12,
          border: '1px solid var(--admin-border, #d4d4d8)',
          borderRadius: 6,
          background: 'rgba(0, 0, 0, 0.02)',
        }}
        role="dialog"
        aria-label="Корректировка остатка"
      >
        <div style={{ fontWeight: 600 }}>Корректировка остатка</div>
        <div className="admin-muted" style={{ fontSize: '0.85rem' }}>
          Нет остатков, доступных для корректировки на этой странице.
        </div>
        <div>
          <button
            type="button"
            className="admin-btn"
            onClick={onClose}
          >
            Закрыть
          </button>
        </div>
      </div>
    );
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="stock-adjustment-dialog"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        padding: 12,
        border: '1px solid var(--admin-border, #d4d4d8)',
        borderRadius: 6,
        background: 'rgba(0, 0, 0, 0.02)',
      }}
      role="dialog"
      aria-label="Корректировка остатка"
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
        }}
      >
        <div style={{ fontWeight: 600 }}>Корректировка остатка</div>
        <button
          type="button"
          className="admin-btn admin-btn--ghost"
          onClick={onClose}
          aria-label="Закрыть форму"
        >
          <X size={14} strokeWidth={1.6} aria-hidden />
        </button>
      </div>

      <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <span style={{ fontSize: '0.78rem', fontWeight: 500 }}>
          Остаток / материал
        </span>
        <select
          value={stockBalanceId}
          onChange={(e) => setStockBalanceId(e.target.value)}
          required
          style={{
            fontSize: '0.85rem',
            padding: '6px 8px',
            border: '1px solid var(--admin-border, #d4d4d8)',
            borderRadius: 4,
            fontFamily: 'inherit',
          }}
          name="stockBalanceId"
        >
          {balances.map((b) => (
            <option key={b.id} value={b.id}>
              {formatBalanceLabel(b)}
            </option>
          ))}
        </select>
      </label>

      <fieldset
        style={{
          display: 'flex',
          gap: 12,
          border: 'none',
          padding: 0,
          margin: 0,
        }}
      >
        <legend
          style={{
            fontSize: '0.78rem',
            fontWeight: 500,
            marginBottom: 4,
          }}
        >
          Тип корректировки
        </legend>
        <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <input
            type="radio"
            name="direction"
            value="IN"
            checked={direction === 'IN'}
            onChange={() => setDirection('IN')}
          />
          <span style={{ fontSize: '0.85rem' }}>Приход (увеличить)</span>
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <input
            type="radio"
            name="direction"
            value="OUT"
            checked={direction === 'OUT'}
            onChange={() => setDirection('OUT')}
          />
          <span style={{ fontSize: '0.85rem' }}>Расход (уменьшить)</span>
        </label>
      </fieldset>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: 8,
        }}
      >
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ fontSize: '0.78rem', fontWeight: 500 }}>
            Количество <span style={{ color: '#dc2626' }}>*</span>
          </span>
          <input
            type="text"
            inputMode="decimal"
            value={qty}
            onChange={(e) => setQty(e.target.value)}
            required
            placeholder="0.00"
            name="qty"
            style={{
              fontSize: '0.85rem',
              padding: '6px 8px',
              border: '1px solid var(--admin-border, #d4d4d8)',
              borderRadius: 4,
              fontFamily: 'inherit',
            }}
          />
          {selected && (
            <span
              className="admin-muted"
              style={{ fontSize: '0.72rem' }}
            >
              Текущий остаток: {String(selected.qty)} {selected.unit}
            </span>
          )}
        </label>

        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ fontSize: '0.78rem', fontWeight: 500 }}>
            Цена за единицу
          </span>
          <input
            type="text"
            inputMode="decimal"
            value={unitCost}
            onChange={(e) => setUnitCost(e.target.value)}
            disabled={direction === 'OUT'}
            placeholder={
              direction === 'IN'
                ? selected
                  ? String(selected.unitCost)
                  : '0.00'
                : '—'
            }
            name="unitCost"
            style={{
              fontSize: '0.85rem',
              padding: '6px 8px',
              border: '1px solid var(--admin-border, #d4d4d8)',
              borderRadius: 4,
              fontFamily: 'inherit',
              background:
                direction === 'OUT'
                  ? 'rgba(0,0,0,0.04)'
                  : undefined,
            }}
          />
          {direction === 'OUT' ? (
            <span
              className="admin-muted"
              style={{ fontSize: '0.72rem' }}
            >
              Для расходной корректировки используется текущая складская цена
              остатка.
            </span>
          ) : (
            <span
              className="admin-muted"
              style={{ fontSize: '0.72rem' }}
            >
              Если не указать, возьмём текущую цену остатка.
            </span>
          )}
        </label>
      </div>

      <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <span style={{ fontSize: '0.78rem', fontWeight: 500 }}>
          Комментарий <span style={{ color: '#dc2626' }}>*</span>
        </span>
        <textarea
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          required
          minLength={2}
          maxLength={500}
          placeholder="Причина корректировки"
          name="comment"
          rows={2}
          style={{
            fontSize: '0.85rem',
            padding: '6px 8px',
            border: '1px solid var(--admin-border, #d4d4d8)',
            borderRadius: 4,
            fontFamily: 'inherit',
            resize: 'vertical',
          }}
        />
      </label>

      {state.error && (
        <div className="error-box" role="alert" style={{ fontSize: '0.85rem' }}>
          {state.error}
          {state.errorRequestId && (
            <div className="admin-muted" style={{ fontSize: '0.72rem' }}>
              Request ID: {state.errorRequestId}
            </div>
          )}
        </div>
      )}

      <div style={{ display: 'flex', gap: 8 }}>
        <button
          type="submit"
          className="admin-btn admin-btn--primary"
          disabled={submitting}
        >
          <CheckCircle size={16} strokeWidth={1.6} aria-hidden />
          {submitting ? 'Сохраняем…' : 'Сохранить корректировку'}
        </button>
        <button
          type="button"
          className="admin-btn"
          onClick={onClose}
          disabled={submitting}
        >
          Отмена
        </button>
      </div>
    </form>
  );
}
