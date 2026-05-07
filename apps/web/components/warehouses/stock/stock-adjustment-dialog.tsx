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
 * movements.
 *
 * Для пользователя «Корректировка» — одна общая складская операция.
 * Под капотом разные backend endpoint-ы:
 *   - MATERIAL → `POST /api/stock/adjustments`
 *     (`apps/api/src/modules/stock/dto/create-stock-adjustment.dto.ts`,
 *     `StockService.createAdjustment`);
 *   - FINISHED_GOOD → `POST /api/finished-goods/adjustments`
 *     (`apps/api/src/modules/finished-goods/dto/create-finished-goods-adjustment.dto.ts`,
 *     `FinishedGoodsService.createAdjustment`).
 * UI различает их по `kind` выбранного остатка и валидирует
 * количество соответствующим образом (decimal для материалов,
 * integer для готовой продукции). Для готовой продукции поле «Цена»
 * отключено — это не material cost.
 *
 * Контракт формы:
 *   - select остатка из объединённого списка материалов и готовой
 *     продукции (MVP: корректируем только существующий баланс);
 *   - direction `IN` (увеличить) / `OUT` (уменьшить);
 *   - qty > 0 (text input). Для FINISHED_GOOD `inputMode="numeric"`
 *     и frontend validation `Number.isInteger`;
 *   - unitCost виден только для MATERIAL и активен только при IN;
 *     для OUT и для FINISHED_GOOD поле задисейблено;
 *   - comment обязателен (placeholder «Причина корректировки»);
 *   - `clientRequestId` — uuid, сгенерированный единожды на mount
 *     (защита от двойного submit; при ретрае с тем же id backend
 *     вернёт уже существующее движение и не задвоит).
 */

import { useEffect, useMemo, useState } from 'react';
import { CheckCircle, X } from 'lucide-react';
import {
  createFinishedGoodsAdjustmentAction,
  createStockAdjustmentAction,
} from '@/app/admin/warehouses/actions';
import {
  initialStockAdjustmentState,
  type StockAdjustmentState,
} from '@/app/admin/warehouses/form-state';
import type { StockBalanceListItem } from '@/lib/stock-api';
import type { FinishedGoodsBalanceListItem } from '@/lib/finished-goods-api';

/**
 * Унифицированный source-вариант для select-а исходного остатка. UI
 * различает два контура только через `kind`; всё остальное (имя,
 * локация, единица, количество, цена) рассчитывается по
 * полю-источнику.
 */
type AdjustmentSourceOption =
  | {
      kind: 'MATERIAL';
      id: string;
      balance: StockBalanceListItem;
    }
  | {
      kind: 'FINISHED_GOOD';
      id: string;
      balance: FinishedGoodsBalanceListItem;
    };

interface Props {
  materialBalances: StockBalanceListItem[];
  finishedGoodsBalances: FinishedGoodsBalanceListItem[];
  /** Если задан, форма открывается с уже выбранным остатком
   * (формат: `material:<id>` / `finished-good:<id>`). */
  initialSourceOptionId?: string | null;
  onClose: () => void;
}

function makeClientRequestId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function formatMaterialLabel(b: StockBalanceListItem): string {
  const where = [b.warehouseName, b.cellCode]
    .filter((v): v is string => typeof v === 'string' && v.length > 0)
    .join(' / ');
  const qtyText = `${String(b.qty)} ${b.unit}`.trim();
  const tail = where.length > 0 ? ` · ${where}` : '';
  return `${b.description} — ${qtyText}${tail}`;
}

function formatFinishedGoodName(b: FinishedGoodsBalanceListItem): string {
  const product = b.productName ?? b.productId;
  const size = b.sizeCode ?? b.sizeId;
  const parts: string[] = [];
  if (product) parts.push(product);
  if (b.color) parts.push(b.color);
  if (size) parts.push(size);
  return parts.join(' / ');
}

function formatFinishedGoodLabel(b: FinishedGoodsBalanceListItem): string {
  const where = [b.warehouseName, b.cellCode]
    .filter((v): v is string => typeof v === 'string' && v.length > 0)
    .join(' / ');
  const qtyText = `${b.qty} шт`;
  const tail = where.length > 0 ? ` · ${where}` : '';
  return `${formatFinishedGoodName(b)} — ${qtyText}${tail}`;
}

export function StockAdjustmentDialog({
  materialBalances,
  finishedGoodsBalances,
  initialSourceOptionId,
  onClose,
}: Props) {
  const sourceOptions = useMemo<AdjustmentSourceOption[]>(() => {
    const opts: AdjustmentSourceOption[] = [];
    for (const b of materialBalances) {
      opts.push({
        kind: 'MATERIAL',
        id: `material:${b.id}`,
        balance: b,
      });
    }
    for (const b of finishedGoodsBalances) {
      opts.push({
        kind: 'FINISHED_GOOD',
        id: `finished-good:${b.id}`,
        balance: b,
      });
    }
    return opts;
  }, [materialBalances, finishedGoodsBalances]);

  const initialId = useMemo(() => {
    if (
      initialSourceOptionId &&
      sourceOptions.some((o) => o.id === initialSourceOptionId)
    ) {
      return initialSourceOptionId;
    }
    return sourceOptions[0]?.id ?? '';
  }, [initialSourceOptionId, sourceOptions]);

  const [sourceOptionId, setSourceOptionId] = useState<string>(initialId);
  const [direction, setDirection] = useState<'IN' | 'OUT'>('IN');
  const [qty, setQty] = useState<string>('');
  const [unitCost, setUnitCost] = useState<string>('');
  const [comment, setComment] = useState<string>('');
  const [clientRequestId] = useState<string>(() => makeClientRequestId());
  const [submitting, setSubmitting] = useState(false);
  const [state, setState] = useState<StockAdjustmentState>(
    initialStockAdjustmentState,
  );

  // Если remote update изменил список options и текущий id больше
  // не существует — переключаемся на первый доступный.
  useEffect(() => {
    if (sourceOptions.length === 0) return;
    if (!sourceOptions.some((o) => o.id === sourceOptionId)) {
      setSourceOptionId(sourceOptions[0].id);
    }
  }, [sourceOptions, sourceOptionId]);

  const selected =
    sourceOptions.find((o) => o.id === sourceOptionId) ?? null;
  const selectedKind = selected?.kind ?? null;
  const selectedUnit: string = selected
    ? selected.kind === 'FINISHED_GOOD'
      ? 'шт'
      : selected.balance.unit
    : '';
  const selectedQty: string | number | null = selected
    ? selected.balance.qty
    : null;

  const isFinishedGood = selectedKind === 'FINISHED_GOOD';
  // Цену мы спрашиваем только у материала и только для IN.
  // Для готовой продукции unitCost не имеет смысла (это не material cost).
  const unitCostDisabled = isFinishedGood || direction === 'OUT';

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (submitting) return;
    if (!selected) {
      setState({ ok: false, error: 'Выберите остаток для корректировки.' });
      return;
    }
    const trimmedComment = comment.trim();
    if (trimmedComment.length < 2) {
      setState({
        ok: false,
        error: 'Укажите причину корректировки (минимум 2 символа).',
      });
      return;
    }
    if (qty.trim() === '') {
      setState({ ok: false, error: 'Укажите количество корректировки.' });
      return;
    }

    setSubmitting(true);
    setState(initialStockAdjustmentState);
    try {
      let result: StockAdjustmentState;
      if (selected.kind === 'MATERIAL') {
        result = await createStockAdjustmentAction({
          stockBalanceId: selected.balance.id,
          direction,
          qty: qty.trim().replace(',', '.'),
          ...(direction === 'IN' && unitCost.trim().length > 0
            ? { unitCost: unitCost.trim().replace(',', '.') }
            : {}),
          comment: trimmedComment,
          clientRequestId,
        });
      } else {
        // Для готовой продукции — целое штучное количество.
        const normalized = qty.trim().replace(',', '.');
        const qtyNum = Number(normalized);
        if (
          !Number.isFinite(qtyNum) ||
          !Number.isInteger(qtyNum) ||
          qtyNum <= 0
        ) {
          setState({
            ok: false,
            error:
              'Для готовой продукции количество должно быть целым числом.',
          });
          return;
        }
        result = await createFinishedGoodsAdjustmentAction({
          finishedGoodsBalanceId: selected.balance.id,
          direction,
          qty: qtyNum,
          comment: trimmedComment,
          clientRequestId,
        });
      }
      setState(result);
      if (result.ok) {
        onClose();
      }
    } finally {
      setSubmitting(false);
    }
  }

  if (sourceOptions.length === 0) {
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
          <button type="button" className="admin-btn" onClick={onClose}>
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
          Остаток
        </span>
        <select
          value={sourceOptionId}
          onChange={(e) => setSourceOptionId(e.target.value)}
          required
          style={{
            fontSize: '0.85rem',
            padding: '6px 8px',
            border: '1px solid var(--admin-border, #d4d4d8)',
            borderRadius: 4,
            fontFamily: 'inherit',
          }}
          name="sourceOptionId"
          data-source-kind={selectedKind ?? ''}
        >
          {materialBalances.length > 0 && (
            <optgroup label="Материалы">
              {materialBalances.map((b) => (
                <option
                  key={`material:${b.id}`}
                  value={`material:${b.id}`}
                  data-kind="MATERIAL"
                >
                  {formatMaterialLabel(b)}
                </option>
              ))}
            </optgroup>
          )}
          {finishedGoodsBalances.length > 0 && (
            <optgroup label="Готовая продукция">
              {finishedGoodsBalances.map((b) => (
                <option
                  key={`finished-good:${b.id}`}
                  value={`finished-good:${b.id}`}
                  data-kind="FINISHED_GOOD"
                >
                  {formatFinishedGoodLabel(b)}
                </option>
              ))}
            </optgroup>
          )}
        </select>
        {isFinishedGood && (
          <span className="admin-muted" style={{ fontSize: '0.72rem' }}>
            Готовая продукция корректируется в штуках.
          </span>
        )}
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
            inputMode={isFinishedGood ? 'numeric' : 'decimal'}
            value={qty}
            onChange={(e) => setQty(e.target.value)}
            required
            placeholder={isFinishedGood ? '1' : '0.00'}
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
            <span className="admin-muted" style={{ fontSize: '0.72rem' }}>
              Текущий остаток: {String(selectedQty)} {selectedUnit}
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
            value={isFinishedGood ? '' : unitCost}
            onChange={(e) => setUnitCost(e.target.value)}
            disabled={unitCostDisabled}
            placeholder={
              isFinishedGood
                ? '—'
                : direction === 'IN'
                  ? selected && selected.kind === 'MATERIAL'
                    ? String(selected.balance.unitCost)
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
              background: unitCostDisabled ? 'rgba(0,0,0,0.04)' : undefined,
            }}
          />
          {isFinishedGood ? (
            <span className="admin-muted" style={{ fontSize: '0.72rem' }}>
              Стоимость для готовой продукции в этой корректировке не
              указывается.
            </span>
          ) : direction === 'OUT' ? (
            <span className="admin-muted" style={{ fontSize: '0.72rem' }}>
              Для расходной корректировки используется текущая складская
              цена остатка.
            </span>
          ) : (
            <span className="admin-muted" style={{ fontSize: '0.72rem' }}>
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
