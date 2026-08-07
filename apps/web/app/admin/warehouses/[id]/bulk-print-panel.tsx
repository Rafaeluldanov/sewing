'use client';

import { useEffect, useId, useMemo, useState, useTransition } from 'react';
import { AlertCircle, Check, Printer, Warehouse, X } from 'lucide-react';
import { ModalPortal } from '@/components/modal-portal';
import { CreatableSelect } from '@/components/admin/ref-create/creatable-select';
import type { PrinterSummaryDto } from '@sewing/shared/printers';
import {
  WAREHOUSE_LABEL_SIZES,
  WAREHOUSE_PRINT_CELLS_MAX_COPIES,
  type PrintWarehouseCellsDto,
  type WarehouseCellDto,
  type WarehouseDetailDto,
  type WarehouseLabelSize,
} from '@sewing/shared/warehouses';
import { buildCellQrImageUrl } from '@/lib/warehouses-urls';
import {
  printWarehouseCellsAction,
  printWarehouseLineCellsAction,
  type PrintWarehouseCellsActionResult,
} from '../actions';

interface Props {
  warehouse: Pick<WarehouseDetailDto, 'id' | 'name' | 'cells'>;
  printers: PrinterSummaryDto[];
}

type Phase = 'idle' | 'success' | 'error';

const LABEL_SIZE_LABELS: Record<WarehouseLabelSize, string> = {
  '38x58': '38 × 58 мм (QR + номер)',
};

const PREVIEW_LIMIT = 24;

/**
 * Кнопка «Печать всех ячеек» в карточке склада + модалка
 * массовой печати (Admin UI 2.6, ADR-0019).
 *
 * Backend / DTO не меняем. UI приведён к admin-стилю: lucide-иконки,
 * `admin-btn`, `admin-form` / `admin-field` внутри модалки. Сама
 * модалка остаётся `qr-modal` (общий CSS-паттерн), потому что её
 * ширина и backdrop поведение завязаны на уже отлаженный layout.
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
        className="admin-btn admin-btn--primary"
        onClick={() => setOpen(true)}
        disabled={!hasCells}
        title={
          hasCells
            ? 'Открыть окно массовой печати этикеток ячеек'
            : 'На складе нет активных ячеек для печати'
        }
      >
        <Printer size={16} strokeWidth={1.6} aria-hidden />
        Печать всех ячеек
      </button>
      {open && (
        <BulkPrintModal
          title={`Печать ячеек: ${warehouse.name}`}
          printers={printers}
          printableCells={printableCells}
          onSubmit={(body) => printWarehouseCellsAction(warehouse.id, body)}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

interface LinePrintButtonProps {
  warehouseId: string;
  warehouseName: string;
  lineId: string;
  lineCode: string;
  /** Активные ячейки именно этой линии (склад уже отфильтровал по `lineId`). */
  cells: WarehouseCellDto[];
  printers: PrinterSummaryDto[];
}

/**
 * Кнопка «Печать линии» в строке таблицы линий. Открывает ту же
 * модалку, что и общая массовая печать, но action бьёт в per-line
 * endpoint. Список ячеек для preview уже отфильтрован по `lineId`
 * на странице — здесь компонент только переливает props в модалку.
 */
export function LinePrintButton({
  warehouseId,
  warehouseName,
  lineId,
  lineCode,
  cells,
  printers,
}: LinePrintButtonProps) {
  const [open, setOpen] = useState(false);
  const printableCells = useMemo(
    () => cells.filter((c) => c.active),
    [cells],
  );
  const hasCells = printableCells.length > 0;

  return (
    <>
      <button
        type="button"
        className="admin-btn"
        onClick={() => setOpen(true)}
        disabled={!hasCells}
        title={
          hasCells
            ? `Печать всех штрихкодов линии «${lineCode}»`
            : 'В линии нет активных ячеек для печати'
        }
      >
        <Printer size={14} strokeWidth={1.6} aria-hidden />
        Печать
      </button>
      {open && (
        <BulkPrintModal
          title={`Печать линии «${lineCode}» — ${warehouseName}`}
          printers={printers}
          printableCells={printableCells}
          onSubmit={(body) =>
            printWarehouseLineCellsAction(warehouseId, lineId, body)
          }
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

interface ModalProps {
  title: string;
  printers: PrinterSummaryDto[];
  printableCells: WarehouseCellDto[];
  onSubmit: (
    body: PrintWarehouseCellsDto,
  ) => Promise<PrintWarehouseCellsActionResult>;
  onClose: () => void;
}

function BulkPrintModal({
  title,
  printers,
  printableCells,
  onSubmit,
  onClose,
}: ModalProps) {
  const titleId = useId();
  const formId = useId();
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

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
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
      const res = await onSubmit(body);
      setFeedback(res);
      setPhase(res.ok ? 'success' : 'error');
    });
  }

  return (
    <ModalPortal>
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
            <Printer size={18} strokeWidth={1.6} aria-hidden />
            {title}
          </h2>
          <button
            type="button"
            className="qr-modal__close"
            onClick={onClose}
            aria-label="Закрыть"
          >
            <X size={18} strokeWidth={1.6} aria-hidden />
          </button>
        </div>

        <form
          id={formId}
          className="bulk-print-modal__form"
          onSubmit={handleSubmit}
        >
          <div className="bulk-print-modal__body">
            <div className="admin-form-grid">
              <div className="admin-field">
                <label htmlFor={printerSelectId}>Принтер</label>
                <CreatableSelect
                  entity="printer"
                  id={printerSelectId}
                  value={printerId}
                  onValueChange={setPrinterId}
                  required
                  modalZIndex={120}
                  existingValues={printers.map((p) => p.id)}
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
                </CreatableSelect>
              </div>

              <div className="admin-field">
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

              <div className="admin-field">
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
                <span className="bulk-print-modal__summary-label">Ячеек</span>
                <span className="bulk-print-modal__summary-value">
                  {cellsCount}
                </span>
              </div>
              <div>
                <span className="bulk-print-modal__summary-label">Копий</span>
                <span className="bulk-print-modal__summary-value">
                  {copies}
                </span>
              </div>
              <div>
                <span className="bulk-print-modal__summary-label">Заданий</span>
                <span className="bulk-print-modal__summary-value">
                  {totalJobs}
                </span>
              </div>
            </div>

            <div className="bulk-print-modal__preview">
              <div className="bulk-print-modal__preview-header">
                <span>Превью этикеток</span>
                {hiddenInPreview > 0 && (
                  <span className="admin-muted" style={{ fontSize: '0.82rem' }}>
                    Показаны первые {previewCells.length}, ещё{' '}
                    {hiddenInPreview} попадёт в печать.
                  </span>
                )}
              </div>
              {cellsCount === 0 ? (
                <p className="admin-muted" style={{ margin: 0 }}>
                  <Warehouse size={14} strokeWidth={1.6} aria-hidden /> Нет
                  активных ячеек для печати.
                </p>
              ) : (
                <div className="bulk-print-modal__preview-grid">
                  {previewCells.map((cell) => (
                    <CellLabelPreview key={cell.id} cell={cell} />
                  ))}
                </div>
              )}
            </div>

            {phase === 'success' && feedback?.result && (
              <div className="success-box" role="status">
                <Check size={14} strokeWidth={1.6} aria-hidden />
                Поставлено {feedback.result.jobsCreated} заданий (
                {feedback.result.cellsCount} × {feedback.result.copies}).
              </div>
            )}
            {phase === 'error' && feedback && (
              <div className="error-box" role="alert">
                <div className="error-box__msg">
                  <AlertCircle size={14} strokeWidth={1.6} aria-hidden />{' '}
                  {feedback.error ?? 'Не удалось поставить задания на печать.'}
                </div>
                {feedback.errorRequestId && (
                  <div className="error-box__rid">
                    req: <code>{feedback.errorRequestId}</code>
                  </div>
                )}
              </div>
            )}
          </div>
        </form>

        <footer className="bulk-print-modal__footer">
          <button
            type="button"
            className="admin-btn admin-btn--ghost"
            onClick={onClose}
            disabled={pending}
          >
            Отмена
          </button>
          <button
            type="submit"
            form={formId}
            className="admin-btn admin-btn--primary"
            disabled={submitDisabled}
          >
            <Printer size={16} strokeWidth={1.6} aria-hidden />
            {pending ? 'Отправляем…' : 'Печать'}
          </button>
        </footer>
      </div>
    </div>
    </ModalPortal>
  );
}

/**
 * Превью одной этикетки 38×58 мм (QR слева, номер справа). QR
 * запрашиваем через @Public()-endpoint backend-а — UI и реальная
 * этикетка по байтам идентичны.
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
