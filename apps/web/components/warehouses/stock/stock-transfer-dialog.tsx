'use client';

/**
 * `StockTransferDialog` — inline-форма перемещения остатка между
 * складами / ячейками для вкладки «Остатки» в
 * `/admin/warehouses?tab=balances`.
 *
 * UI-решение владельца проекта (см. ТЗ): не делать новую страницу /
 * новый пункт меню, а добавить inline-панель прямо над таблицей.
 * Открывается по `StockTransferButton`, рендерится в той же
 * card-обёртке. После успешного submit панель закрывается и
 * `revalidatePath('/admin/warehouses')` перерисовывает balances и
 * movements (см. `createStockTransferAction` /
 * `createFinishedGoodsTransferAction`).
 *
 * Для пользователя «Переместить» — одна общая складская операция.
 * Под капотом разные backend endpoint-ы:
 *   - MATERIAL → `POST /api/stock/transfers`
 *     (`apps/api/src/modules/stock/dto/create-stock-transfer.dto.ts`,
 *     `StockService.createTransfer`);
 *   - FINISHED_GOOD → `POST /api/finished-goods/transfers`
 *     (`apps/api/src/modules/finished-goods/dto/create-finished-goods-transfer.dto.ts`,
 *     `FinishedGoodsService.createTransfer`).
 * UI различает их по `kind` исходного остатка и валидирует количество
 * соответствующим образом (decimal для материалов, integer для
 * готовой продукции).
 *
 * Контракт формы:
 *   - select исходного остатка из объединённого списка
 *     материалов и готовой продукции (MVP: перемещаем только
 *     существующий баланс);
 *   - select целевого склада из загруженного на странице списка
 *     `warehouses`. Опция «Без склада» сознательно НЕ предусмотрена —
 *     перемещать «никуда» не имеет смысла; для MVP destination
 *     обязателен;
 *   - select целевой ячейки динамически подгружается через
 *     `loadTransferDestinationCellsAction` при смене склада. Первая
 *     опция — «Без ячейки» (отправляет `toCellId = null`);
 *   - qty > 0 (text input с `inputMode="decimal"` для материалов /
 *     `inputMode="numeric"` для готовой продукции). Для готовой
 *     продукции количество должно быть целым;
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
  createFinishedGoodsTransferAction,
  createStockTransferAction,
  loadTransferDestinationCellsAction,
  type TransferDestinationCellOption,
} from '@/app/admin/warehouses/actions';
import {
  initialStockTransferState,
  type StockTransferState,
} from '@/app/admin/warehouses/form-state';
import type { StockBalanceListItem } from '@/lib/stock-api';
import type { FinishedGoodsBalanceListItem } from '@/lib/finished-goods-api';
import type { WarehouseSummaryDto } from '@sewing/shared/warehouses';

/**
 * Унифицированный source-вариант для select-а исходного остатка. UI
 * различает два контура только через `kind`; всё остальное (имя,
 * локация, единица, количество) рассчитывается по полю-источнику.
 */
type TransferSourceOption =
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
  warehouses: WarehouseSummaryDto[];
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

function buildOptionId(
  kind: 'MATERIAL' | 'FINISHED_GOOD',
  id: string,
): string {
  return kind === 'MATERIAL' ? `material:${id}` : `finished-good:${id}`;
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

export function StockTransferDialog({
  materialBalances,
  finishedGoodsBalances,
  warehouses,
  initialSourceOptionId,
  onClose,
}: Props) {
  // Объединённый список вариантов источника — материалы первыми,
  // готовая продукция дальше. Группировку через `<optgroup>` ставим
  // ниже на render-уровне, чтобы оператор сразу видел разделение.
  const sourceOptions = useMemo<TransferSourceOption[]>(() => {
    const opts: TransferSourceOption[] = [];
    for (const b of materialBalances) {
      opts.push({
        kind: 'MATERIAL',
        id: buildOptionId('MATERIAL', b.id),
        balance: b,
      });
    }
    for (const b of finishedGoodsBalances) {
      opts.push({
        kind: 'FINISHED_GOOD',
        id: buildOptionId('FINISHED_GOOD', b.id),
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
  const selectedName =
    selected === null
      ? null
      : selected.kind === 'MATERIAL'
        ? selected.balance.description
        : formatFinishedGoodName(selected.balance);
  const selectedFromWarehouseName = selected?.balance.warehouseName ?? null;
  const selectedFromCellCode = selected?.balance.cellCode ?? null;

  // Active warehouses — destination не должен совпадать с источником.
  const destinationWarehouses = warehouses.filter((w) => w.isActive);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (submitting) return;
    if (!selected) {
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
      let result: StockTransferState;
      if (selected.kind === 'MATERIAL') {
        result = await createStockTransferAction({
          fromStockBalanceId: selected.balance.id,
          toWarehouseId,
          ...(toCellId ? { toCellId } : {}),
          qty: qty.trim().replace(',', '.'),
          comment: trimmedComment,
          clientRequestId,
        });
      } else {
        // Для готовой продукции — целое штучное количество.
        const normalized = qty.trim().replace(',', '.');
        const qtyNum = Number(normalized);
        if (!Number.isFinite(qtyNum) || !Number.isInteger(qtyNum) || qtyNum <= 0) {
          setState({
            ok: false,
            error:
              'Для готовой продукции количество должно быть целым числом.',
          });
          return;
        }
        result = await createFinishedGoodsTransferAction({
          fromFinishedGoodsBalanceId: selected.balance.id,
          toWarehouseId,
          ...(toCellId ? { toCellId } : {}),
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
        {selectedKind === 'FINISHED_GOOD' && (
          <span className="admin-muted" style={{ fontSize: '0.72rem' }}>
            Готовая продукция перемещается в штуках.
          </span>
        )}
      </label>

      {/*
        Сводка «Откуда» — короткая шапка, чтобы оператор видел текущую
        локацию выбранного остатка перед заполнением «Куда».
      */}
      {selected && (
        <div
          style={{
            fontSize: '0.78rem',
            padding: '6px 8px',
            border: '1px dashed var(--admin-border, #d4d4d8)',
            borderRadius: 4,
            background: 'rgba(0, 0, 0, 0.015)',
          }}
          aria-label="Откуда перемещаем"
        >
          <div style={{ fontWeight: 600, marginBottom: 2 }}>Откуда:</div>
          <div>
            <span className="admin-muted">Номенклатура:</span> {selectedName}
          </div>
          <div>
            <span className="admin-muted">Склад:</span>{' '}
            {selectedFromWarehouseName ?? '—'}
          </div>
          <div>
            <span className="admin-muted">Ячейка:</span>{' '}
            {selectedFromCellCode ?? 'Без ячейки'}
          </div>
        </div>
      )}

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
          inputMode={selectedKind === 'FINISHED_GOOD' ? 'numeric' : 'decimal'}
          value={qty}
          onChange={(e) => setQty(e.target.value)}
          required
          placeholder={selectedKind === 'FINISHED_GOOD' ? '1' : '0.00'}
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
            Доступно: {String(selectedQty)} {selectedUnit}
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
        перед submit.
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
