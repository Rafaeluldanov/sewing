'use client';

/**
 * `StockTransferDialog` — inline-форма перемещения остатка между
 * складами / ячейками для вкладки «Остатки» в
 * `/admin/warehouses?tab=balances` (см. backend
 * `apps/api/src/modules/stock/dto/create-stock-transfer.dto.ts`,
 * `StockService.createTransfer`).
 *
 * UI-решение владельца проекта (см. ТЗ): не делать новую страницу /
 * новый пункт меню, а добавить inline-панель прямо над таблицей.
 * Открывается по `StockTransferButton`, рендерится в той же
 * card-обёртке. После успешного submit панель закрывается и
 * `revalidatePath('/admin/warehouses')` перерисовывает balances и
 * movements (см. `createStockTransferAction`).
 *
 * Контракт формы:
 *   - select исходного остатка из текущих balances (MVP: перемещаем
 *     только существующий `StockBalance`);
 *   - select целевого склада из загруженного на странице списка
 *     `warehouses`. Опция «Без склада» сознательно НЕ предусмотрена —
 *     перемещать «никуда» не имеет смысла; для MVP destination
 *     обязателен;
 *   - select целевой ячейки динамически подгружается через
 *     `loadTransferDestinationCellsAction` при смене склада. Первая
 *     опция — «Без ячейки» (отправляет `toCellId = null`). Если
 *     склад не выбран — selectbox задисейблен с подсказкой «Сначала
 *     выберите склад». Если в складе нет ячеек — selectbox
 *     задисейблен с подсказкой «Нет ячеек на этом складе». Если ранее
 *     выбранная ячейка не относится к новому складу — `toCellId`
 *     сбрасывается на «Без ячейки»;
 *   - qty > 0 (text input с `inputMode="decimal"`), плюс UI-подсказка
 *     «Доступно: X ед.»;
 *   - comment обязателен (placeholder «Причина перемещения»);
 *   - `clientRequestId` — uuid, сгенерированный единожды на mount
 *     (защита от двойного submit; при ретрае с тем же id backend
 *     вернёт пару существующих движений и не задвоит).
 *
 * Сознательная простота:
 *   - inline-панель, без модального оверлея / focus-trap;
 *   - без раздельных field-errors — backend message-а достаточно;
 *   - идемпотентный технический ключ движения пользователю не виден.
 */

import { useEffect, useMemo, useState } from 'react';
import { CheckCircle, X } from 'lucide-react';
import {
  createStockTransferAction,
  loadTransferDestinationCellsAction,
  type TransferDestinationCellOption,
} from '@/app/admin/warehouses/actions';
import {
  initialStockTransferState,
  type StockTransferState,
} from '@/app/admin/warehouses/form-state';
import type { StockBalanceListItem } from '@/lib/stock-api';
import type { WarehouseSummaryDto } from '@sewing/shared/warehouses';

interface Props {
  balances: StockBalanceListItem[];
  warehouses: WarehouseSummaryDto[];
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

export function StockTransferDialog({
  balances,
  warehouses,
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

  const [fromStockBalanceId, setFromStockBalanceId] =
    useState<string>(initialId);
  const [toWarehouseId, setToWarehouseId] = useState<string>('');
  const [toCellId, setToCellId] = useState<string>('');
  const [destinationCells, setDestinationCells] = useState<
    TransferDestinationCellOption[]
  >([]);
  const [cellsLoading, setCellsLoading] = useState(false);
  const [cellsError, setCellsError] = useState<string | null>(null);
  const [qty, setQty] = useState<string>('');
  const [comment, setComment] = useState<string>('');
  const [clientRequestId] = useState<string>(() => makeClientRequestId());
  const [submitting, setSubmitting] = useState(false);
  const [state, setState] = useState<StockTransferState>(
    initialStockTransferState,
  );

  // Динамическая подгрузка ячеек выбранного склада. При смене
  // `toWarehouseId` сбрасываем выбранную ячейку и зовём server action,
  // которая идёт в `GET /api/cells?warehouseId=…`. Race-guard через
  // `cancelled`-флаг — если пользователь быстро переключил склад,
  // результат старого запроса игнорируем.
  useEffect(() => {
    let cancelled = false;
    setToCellId('');
    setCellsError(null);
    if (!toWarehouseId) {
      setDestinationCells([]);
      setCellsLoading(false);
      return () => {
        cancelled = true;
      };
    }
    setCellsLoading(true);
    loadTransferDestinationCellsAction(toWarehouseId)
      .then((res) => {
        if (cancelled) return;
        if (res.ok) {
          setDestinationCells(res.cells ?? []);
        } else {
          setDestinationCells([]);
          setCellsError(
            res.error ?? 'Не удалось загрузить список ячеек.',
          );
        }
      })
      .finally(() => {
        if (!cancelled) setCellsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [toWarehouseId]);

  // Если remote update изменил список balances и текущий id больше
  // не существует — переключаемся на первый доступный.
  useEffect(() => {
    if (balances.length === 0) return;
    if (!balances.some((b) => b.id === fromStockBalanceId)) {
      setFromStockBalanceId(balances[0].id);
    }
  }, [balances, fromStockBalanceId]);

  const selected = balances.find((b) => b.id === fromStockBalanceId) ?? null;

  // Active warehouses — destination не должен совпадать с источником.
  const destinationWarehouses = warehouses.filter((w) => w.isActive);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (submitting) return;
    if (!fromStockBalanceId) {
      setState({ ok: false, error: 'Выберите остаток для перемещения.' });
      return;
    }
    if (!toWarehouseId) {
      setState({ ok: false, error: 'Выберите склад назначения.' });
      return;
    }
    const trimmedComment = comment.trim();
    if (trimmedComment.length < 2) {
      setState({
        ok: false,
        error: 'Укажите причину перемещения (минимум 2 символа).',
      });
      return;
    }
    if (qty.trim() === '') {
      setState({ ok: false, error: 'Укажите количество перемещения.' });
      return;
    }

    setSubmitting(true);
    setState(initialStockTransferState);
    try {
      const result = await createStockTransferAction({
        fromStockBalanceId,
        toWarehouseId,
        // «Без ячейки» (`toCellId === ''`) → не отправляем поле,
        // backend трактует как `cellId = null`. Иначе — реальный
        // `Cell.id`. Если по какой-то причине ячейка ушла из списка
        // (race с unbinding), backend отдаст `STOCK_TRANSFER_CELL_NOT_FOUND`.
        ...(toCellId ? { toCellId } : {}),
        qty: qty.trim().replace(',', '.'),
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
        className="stock-transfer-dialog"
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
        aria-label="Перемещение остатка"
      >
        <div style={{ fontWeight: 600 }}>Перемещение остатка</div>
        <div className="admin-muted" style={{ fontSize: '0.85rem' }}>
          Нет остатков, доступных для перемещения на этой странице.
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
      className="stock-transfer-dialog"
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
      aria-label="Перемещение остатка"
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
        }}
      >
        <div style={{ fontWeight: 600 }}>Перемещение остатка</div>
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
          Исходный остаток
        </span>
        <select
          value={fromStockBalanceId}
          onChange={(e) => setFromStockBalanceId(e.target.value)}
          required
          style={{
            fontSize: '0.85rem',
            padding: '6px 8px',
            border: '1px solid var(--admin-border, #d4d4d8)',
            borderRadius: 4,
            fontFamily: 'inherit',
          }}
          name="fromStockBalanceId"
        >
          {balances.map((b) => (
            <option key={b.id} value={b.id}>
              {formatBalanceLabel(b)}
            </option>
          ))}
        </select>
      </label>

      <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <span style={{ fontSize: '0.78rem', fontWeight: 500 }}>
          Куда переместить (склад) <span style={{ color: '#dc2626' }}>*</span>
        </span>
        <select
          value={toWarehouseId}
          onChange={(e) => setToWarehouseId(e.target.value)}
          required
          name="toWarehouseId"
          style={{
            fontSize: '0.85rem',
            padding: '6px 8px',
            border: '1px solid var(--admin-border, #d4d4d8)',
            borderRadius: 4,
            fontFamily: 'inherit',
          }}
        >
          <option value="" disabled>
            Выберите склад…
          </option>
          {destinationWarehouses.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
              {w.code ? ` (${w.code})` : ''}
            </option>
          ))}
        </select>
      </label>

      <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <span style={{ fontSize: '0.78rem', fontWeight: 500 }}>
          Ячейка назначения
        </span>
        <select
          value={toCellId}
          onChange={(e) => setToCellId(e.target.value)}
          name="toCellId"
          disabled={!toWarehouseId || cellsLoading}
          style={{
            fontSize: '0.85rem',
            padding: '6px 8px',
            border: '1px solid var(--admin-border, #d4d4d8)',
            borderRadius: 4,
            fontFamily: 'inherit',
            background:
              !toWarehouseId || cellsLoading
                ? 'rgba(0,0,0,0.04)'
                : undefined,
          }}
        >
          {/*
            Первая опция — «Без ячейки»: отправляет `toCellId = ''`,
            handleSubmit вырезает поле из payload, backend трактует как
            `cellId = null`. Опции конкретных ячеек добавляются ниже.
          */}
          <option value="">Без ячейки</option>
          {destinationCells.map((c) => (
            <option key={c.id} value={c.id}>
              {c.code}
            </option>
          ))}
        </select>
        <span className="admin-muted" style={{ fontSize: '0.72rem' }}>
          {!toWarehouseId
            ? 'Сначала выберите склад'
            : cellsLoading
              ? 'Загружаем ячейки…'
              : cellsError
                ? cellsError
                : destinationCells.length === 0
                  ? 'Нет ячеек на этом складе'
                  : 'Если оставить «Без ячейки», остаток зачислится на склад без привязки.'}
        </span>
      </label>

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
          <span className="admin-muted" style={{ fontSize: '0.72rem' }}>
            Доступно: {String(selected.qty)} {selected.unit}
          </span>
        )}
      </label>

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
          placeholder="Причина перемещения"
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

      {/*
        Preview «Куда» — короткая сводка выбранных склада и ячейки
        перед submit. Помогает оператору убедиться, что transfer
        пойдёт в нужную локацию (см. ТЗ §A5).
      */}
      {toWarehouseId && (
        <div
          style={{
            fontSize: '0.78rem',
            padding: '6px 8px',
            border: '1px dashed var(--admin-border, #d4d4d8)',
            borderRadius: 4,
            background: 'rgba(0, 0, 0, 0.015)',
          }}
          aria-label="Предпросмотр направления перемещения"
        >
          <div style={{ fontWeight: 600, marginBottom: 2 }}>Куда:</div>
          <div>
            <span className="admin-muted">Склад:</span>{' '}
            {destinationWarehouses.find((w) => w.id === toWarehouseId)?.name ??
              '—'}
          </div>
          <div>
            <span className="admin-muted">Ячейка:</span>{' '}
            {toCellId
              ? (destinationCells.find((c) => c.id === toCellId)?.code ?? '—')
              : 'Без ячейки'}
          </div>
        </div>
      )}

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
          {submitting ? 'Сохраняем…' : 'Создать перемещение'}
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
