'use client';

import { useEffect, useId, useMemo, useState, useTransition } from 'react';
import type { PrinterSummaryDto } from '@sewing/shared/printers';
import {
  WAREHOUSE_LABEL_SIZES,
  WAREHOUSE_PRINT_CELLS_MAX_COPIES,
  type PrintWarehouseCellsDto,
  type WarehouseCellDto,
  type WarehouseDetailDto,
  type WarehouseLabelSize,
} from '@sewing/shared/warehouses';
import { Icon } from '@/components/icon';
import { buildCellQrImageUrl } from '@/lib/warehouses-urls';
import {
  printWarehouseCellsAction,
  type PrintWarehouseCellsActionResult,
} from '../actions';

interface Props {
  warehouse: Pick<WarehouseDetailDto, 'id' | 'name' | 'cells'>;
  printers: PrinterSummaryDto[];
}

type Phase = 'idle' | 'success' | 'error';

const LABEL_SIZE_LABELS: Record<WarehouseLabelSize, string> = {
  '38x58': '38 × 58 мм (горизонтально, QR + номер)',
};

/** Сколько превью-плиток показываем по умолчанию, чтобы не убить layout. */
const PREVIEW_LIMIT = 24;

/**
 * Кнопка «Печать всех ячеек» в карточке склада + модальное окно
 * настройки массовой печати (см. `docs/screens.md §10b`,
 * `docs/api.md §15`).
 *
 * UX:
 *   1. Disabled, если на складе нет активных ячеек — пользователь
 *      сразу видит, что печатать нечего.
 *   2. Открывает модалку поверх страницы (тот же CSS-паттерн `.qr-modal`,
 *      что у сканера на /work). Внутри:
 *      — выбор принтера (`<select>` по списку логических принтеров);
 *      — формат этикетки (на MVP — фиксированно `38x58`);
 *      — количество копий (1..50);
 *      — счётчик «N ячеек × M копий = K заданий»;
 *      — превью первых N этикеток.
 *   3. После клика «Печать» вызывает server action, показывает
 *      success/error без закрытия модалки — менеджер видит сводку
 *      и может дать второй залп (например, ещё на другой принтер).
 *   4. Esc / клик по бэкдропу / крестик — закрытие.
 */
export function WarehouseBulkPrintPanel({ warehouse, printers }: Props) {
  const [open, setOpen] = useState(false);
  const printableCells = useMemo(
    () => warehouse.cells.filter((c) => c.active),
    [warehouse.cells],
  );
  const hasCells = printableCells.length > 0;

  return (
    <>
      <button
        type="button"
        className="btn btn-primary"
        onClick={() => setOpen(true)}
        disabled={!hasCells}
        title={
          hasCells
            ? 'Открыть окно массовой печати этикеток ячеек'
            : 'На складе нет активных ячеек для печати'
        }
      >
        <Icon name="output" size={16} />
        Печать всех ячеек
      </button>
      {open && (
        <BulkPrintModal
          warehouse={warehouse}
          printers={printers}
          printableCells={printableCells}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

interface ModalProps {
  warehouse: Pick<WarehouseDetailDto, 'id' | 'name'>;
  printers: PrinterSummaryDto[];
  printableCells: WarehouseCellDto[];
  onClose: () => void;
}

function BulkPrintModal({
  warehouse,
  printers,
  printableCells,
  onClose,
}: ModalProps) {
  const titleId = useId();
  const printerSelectId = useId();
  const sizeSelectId = useId();
  const copiesInputId = useId();

  const activePrinters = useMemo(
    () => printers.filter((p) => p.isActive),
    [printers],
  );

  const [printerId, setPrinterId] = useState<string>(
    () => activePrinters[0]?.id ?? '',
  );
  const [labelSize, setLabelSize] = useState<WarehouseLabelSize>('38x58');
  const [copies, setCopies] = useState<number>(1);
  const [phase, setPhase] = useState<Phase>('idle');
  const [feedback, setFeedback] =
    useState<PrintWarehouseCellsActionResult | null>(null);
  const [pending, startTransition] = useTransition();

  // Esc для закрытия — без него модалка ощущается «застрявшей».
  // Отдельный effect, чтобы не путать с автофокусом.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    // Блокируем скролл фона, как и у `.qr-modal` на /work.
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose]);

  const cellsCount = printableCells.length;
  const totalJobs = Math.max(0, cellsCount * Math.max(1, copies));
  const previewCells = printableCells.slice(0, PREVIEW_LIMIT);
  const hiddenInPreview = Math.max(0, cellsCount - previewCells.length);

  const noPrinters = activePrinters.length === 0;
  const submitDisabled =
    pending || noPrinters || !printerId || cellsCount === 0;

  function handleCopiesChange(raw: string) {
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n)) {
      setCopies(1);
      return;
    }
    setCopies(
      Math.max(1, Math.min(WAREHOUSE_PRINT_CELLS_MAX_COPIES, Math.trunc(n))),
    );
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitDisabled) return;
    setPhase('idle');
    setFeedback(null);
    const body: PrintWarehouseCellsDto = {
      printerId,
      copies,
      labelSize,
    };
    startTransition(async () => {
      const res = await printWarehouseCellsAction(warehouse.id, body);
      setFeedback(res);
      setPhase(res.ok ? 'success' : 'error');
    });
  }

  return (
    <div
      className="qr-modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="qr-modal__card bulk-print-modal__card">
        <div className="qr-modal__header">
          <h2 className="qr-modal__title" id={titleId}>
            <Icon name="output" size={18} />
            Печать всех ячеек: {warehouse.name}
          </h2>
          <button
            type="button"
            className="qr-modal__close"
            onClick={onClose}
            aria-label="Закрыть окно печати"
          >
            ×
          </button>
        </div>

        <form className="bulk-print-modal__form" onSubmit={handleSubmit}>
          <div className="bulk-print-modal__settings">
            <div className="detail-form__field">
              <label htmlFor={printerSelectId}>Принтер</label>
              <select
                id={printerSelectId}
                value={printerId}
                onChange={(e) => setPrinterId(e.target.value)}
                disabled={noPrinters}
                required
              >
                {noPrinters && (
                  <option value="" disabled>
                    Нет активных принтеров
                  </option>
                )}
                {activePrinters.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                    {p.equipmentName ? ` — ${p.equipmentName}` : ''}
                    {p.isOnline ? ' • онлайн' : ' • офлайн'}
                  </option>
                ))}
              </select>
              {noPrinters && (
                <span className="detail-form__hint">
                  Создайте и подключите принтер на странице
                  «Администрирование → Принтеры».
                </span>
              )}
            </div>

            <div className="detail-form__field">
              <label htmlFor={sizeSelectId}>Размер этикетки</label>
              <select
                id={sizeSelectId}
                value={labelSize}
                onChange={(e) =>
                  setLabelSize(e.target.value as WarehouseLabelSize)
                }
              >
                {WAREHOUSE_LABEL_SIZES.map((size) => (
                  <option key={size} value={size}>
                    {LABEL_SIZE_LABELS[size]}
                  </option>
                ))}
              </select>
            </div>

            <div className="detail-form__field">
              <label htmlFor={copiesInputId}>Копий каждой</label>
              <input
                id={copiesInputId}
                type="number"
                min={1}
                max={WAREHOUSE_PRINT_CELLS_MAX_COPIES}
                value={copies}
                onChange={(e) => handleCopiesChange(e.target.value)}
                inputMode="numeric"
              />
            </div>
          </div>

          <div className="bulk-print-modal__summary">
            <div>
              <span className="bulk-print-modal__summary-label">
                Ячеек к печати
              </span>
              <span className="bulk-print-modal__summary-value">
                {cellsCount}
              </span>
            </div>
            <div>
              <span className="bulk-print-modal__summary-label">Копий</span>
              <span className="bulk-print-modal__summary-value">{copies}</span>
            </div>
            <div>
              <span className="bulk-print-modal__summary-label">
                Всего заданий
              </span>
              <span className="bulk-print-modal__summary-value">
                {totalJobs}
              </span>
            </div>
          </div>

          <div className="bulk-print-modal__preview">
            <div className="bulk-print-modal__preview-header">
              <span>Превью этикеток</span>
              {hiddenInPreview > 0 && (
                <span className="detail-form__hint">
                  Показаны первые {previewCells.length}, ещё{' '}
                  {hiddenInPreview} ячеек попадёт в печать.
                </span>
              )}
            </div>
            {cellsCount === 0 ? (
              <div className="empty-state">
                <span className="empty-state__icon">
                  <Icon name="warehouses" />
                </span>
                <span className="empty-state__title">
                  Нет активных ячеек для печати
                </span>
              </div>
            ) : (
              <div className="bulk-print-modal__preview-grid">
                {previewCells.map((cell) => (
                  <CellLabelPreview key={cell.id} cell={cell} />
                ))}
              </div>
            )}
          </div>

          {phase === 'success' && feedback?.result && (
            <div className="detail-form__success" role="status">
              <Icon name="success" size={16} />
              <span>
                Поставлено {feedback.result.jobsCreated} заданий в очередь
                принтера ({feedback.result.cellsCount} ячеек ×{' '}
                {feedback.result.copies} копий, формат{' '}
                {LABEL_SIZE_LABELS[feedback.result.labelSize]}).
              </span>
            </div>
          )}
          {phase === 'error' && feedback && (
            <div className="detail-form__error" role="alert">
              <Icon name="error" size={16} />
              <span>
                {feedback.error ?? 'Не удалось поставить задания на печать.'}
                {feedback.errorRequestId && (
                  <span className="detail-form__error-rid">
                    req: <code>{feedback.errorRequestId}</code>
                  </span>
                )}
              </span>
            </div>
          )}

          <div className="bulk-print-modal__actions">
            <button
              type="button"
              className="btn btn-ghost"
              onClick={onClose}
              disabled={pending}
            >
              Отмена
            </button>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={submitDisabled}
            >
              <Icon name="output" size={16} />
              {pending ? 'Отправляем…' : 'Печать'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/**
 * Превью одной этикетки 38×58 мм, повторяющее layout `cell-print.ts`:
 * QR слева, номер справа. Размеры в px подобраны так, чтобы плитка
 * визуально соответствовала пропорциям 58:38 (≈1.53).
 *
 * QR-картинку запрашиваем через `@Public()` endpoint backend-а — не
 * рендерим клиентом, чтобы не тащить qr-библиотеку в bundle и чтобы
 * UI и реальная этикетка были по байтам идентичны.
 */
function CellLabelPreview({ cell }: { cell: WarehouseCellDto }) {
  const qrUrl = buildCellQrImageUrl(cell.id);
  return (
    <div className="bulk-print-modal__label" aria-label={`Ячейка ${cell.code}`}>
      <div className="bulk-print-modal__label-qr">
        <img src={qrUrl} alt="" loading="lazy" />
      </div>
      <div className="bulk-print-modal__label-code">{cell.code}</div>
    </div>
  );
}
