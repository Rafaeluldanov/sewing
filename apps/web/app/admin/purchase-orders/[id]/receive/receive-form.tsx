'use client';

/**
 * Форма приёмки `PurchaseOrder` → `PurchaseReceipt` (Этап 7А).
 *
 * Серверный action `createPurchaseReceiptFromPurchaseOrderAction`
 * собирает строки только по тем `purchaseOrderLineId`, у которых
 * заполнено «Принято». Если ни в одной строке qty не введено,
 * action возвращает ошибку «Заполните "Принято" хотя бы по одной
 * строке».
 *
 * Cell select — простой `<select>` со всеми активными ячейками
 * (`/api/cells`). Опционально: можно оставить пустым, если
 * закупщик не хочет фиксировать место.
 */

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useFormState, useFormStatus } from 'react-dom';
import { ClipboardCheck, FileText } from 'lucide-react';
import {
  PURCHASE_ORDER_LINE_STATUS_LABELS,
  type PurchaseOrderDetailDto,
  type PurchaseOrderLineDto,
  type PurchaseOrderLineStatus,
} from '@sewing/shared/purchase-orders';
import { createPurchaseReceiptFromPurchaseOrderAction } from '../../../purchase-receipts/actions';
import { initialCreatePurchaseReceiptState } from '../../../purchase-receipts/form-state';
import { CreatableSelect } from '@/components/admin/ref-create/creatable-select';

interface CellOption {
  id: string;
  code: string;
  warehouseName: string | null;
}

interface ReceivedAggregate {
  /** Сколько уже принято по этой строке PO суммарно (Σ POSTED). */
  receivedSum: string | null;
}

interface Props {
  po: PurchaseOrderDetailDto;
  cells: CellOption[];
  receivedByLineId: Record<string, ReceivedAggregate>;
}

function todayIsoLocal(): string {
  const d = new Date();
  // YYYY-MM-DDTHH:mm для <input type="datetime-local">
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(
    d.getDate(),
  )}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function lineLabel(status: string): string {
  return (
    PURCHASE_ORDER_LINE_STATUS_LABELS[status as PurchaseOrderLineStatus] ??
    status
  );
}

/**
 * Остаток к приёмке по строке = (confirmedQty ?? qty) − уже принято.
 * `null`, если посчитать нельзя (нет числовых данных). Отрицательный
 * клиппится в 0.
 */
function computeRemaining(
  line: PurchaseOrderLineDto,
  receivedSum: string | null,
): number | null {
  const targetRaw = line.confirmedQty ?? line.qty;
  const target = Number.parseFloat(targetRaw);
  if (!Number.isFinite(target)) return null;
  const already = receivedSum ? Number.parseFloat(receivedSum) : 0;
  const remaining = target - (Number.isFinite(already) ? already : 0);
  return remaining < 0 ? 0 : remaining;
}

function SubmitButton({
  intent,
  label,
  pendingLabel,
  className,
  icon,
  disabled,
}: {
  intent: 'post' | 'draft';
  label: string;
  pendingLabel: string;
  className: string;
  icon: React.ReactNode;
  disabled?: boolean;
}) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      name="intent"
      value={intent}
      className={className}
      disabled={pending || disabled}
    >
      {icon}
      {pending ? pendingLabel : label}
    </button>
  );
}

export function ReceivePurchaseOrderForm({
  po,
  cells,
  receivedByLineId,
}: Props) {
  const router = useRouter();
  const [state, action] = useFormState(
    createPurchaseReceiptFromPurchaseOrderAction.bind(null, po.id),
    initialCreatePurchaseReceiptState,
  );

  useEffect(() => {
    if (state.ok && state.redirectTo) {
      router.push(state.redirectTo);
    }
  }, [state.ok, state.redirectTo, router]);

  // Прячем строки в CANCELLED — принимать нечего.
  const visibleLines = po.lines.filter((l) => l.status !== 'CANCELLED');

  // Введённые количества по строкам — для подсветки переприёмки и
  // блокировки кнопки «Принять поступление» (черновик можно сохранять
  // и с превышением — поправят перед проведением).
  const [qtyByLine, setQtyByLine] = useState<Record<string, string>>({});

  const overLineIds = useMemo(() => {
    const over: string[] = [];
    for (const line of visibleLines) {
      const remaining = computeRemaining(
        line,
        receivedByLineId[line.id]?.receivedSum ?? null,
      );
      if (remaining == null) continue;
      const entered = Number.parseFloat(qtyByLine[line.id] ?? '');
      if (Number.isFinite(entered) && entered > remaining + 1e-9) {
        over.push(line.id);
      }
    }
    return over;
  }, [visibleLines, qtyByLine, receivedByLineId]);

  const hasOver = overLineIds.length > 0;

  return (
    <form action={action} className="admin-stack">
      <div className="admin-form-grid">
        <div className="admin-field">
          <label htmlFor="receivedAt">Дата приёмки</label>
          <input
            id="receivedAt"
            name="receivedAt"
            type="datetime-local"
            defaultValue={todayIsoLocal()}
          />
        </div>
        <div className="admin-field" style={{ gridColumn: '1 / -1' }}>
          <label htmlFor="comment">Комментарий по документу</label>
          <input
            id="comment"
            name="comment"
            type="text"
            maxLength={1000}
            placeholder="Например: «накладная № 123 от 25.04»"
          />
        </div>
      </div>

      {visibleLines.length === 0 ? (
        <div className="error-box" role="alert">
          В заказе нет активных строк — принимать нечего.
        </div>
      ) : (
        <div className="admin-stack">
          {visibleLines.map((line) => (
            <ReceiveLineRow
              key={line.id}
              line={line}
              cells={cells}
              receivedSum={receivedByLineId[line.id]?.receivedSum ?? null}
              value={qtyByLine[line.id] ?? ''}
              onChange={(v) =>
                setQtyByLine((prev) => ({ ...prev, [line.id]: v }))
              }
              over={overLineIds.includes(line.id)}
            />
          ))}
        </div>
      )}

      {hasOver && (
        <div className="error-box" role="alert">
          По выделенным строкам введено больше, чем осталось принять.
          «Принять поступление» недоступно — поправьте количество или
          сохраните черновик.
        </div>
      )}

      {state.error && (
        <div className="error-box" role="alert">
          {state.error}
          {state.errorRequestId ? ` [${state.errorRequestId}]` : ''}
        </div>
      )}

      <div className="admin-actions-row" style={{ flexWrap: 'wrap', gap: 8 }}>
        <SubmitButton
          intent="post"
          label="Принять поступление"
          pendingLabel="Принимаем…"
          className="admin-btn admin-btn--primary"
          icon={<ClipboardCheck size={16} strokeWidth={1.6} aria-hidden />}
          disabled={hasOver}
        />
        <SubmitButton
          intent="draft"
          label="Сохранить черновик"
          pendingLabel="Сохраняем…"
          className="admin-btn"
          icon={<FileText size={16} strokeWidth={1.6} aria-hidden />}
        />
        <Link
          href={`/admin/purchase-orders/${po.id}`}
          className="admin-btn admin-btn--ghost"
        >
          Отмена
        </Link>
      </div>
    </form>
  );
}

function ReceiveLineRow({
  line,
  cells,
  receivedSum,
  value,
  onChange,
  over,
}: {
  line: PurchaseOrderLineDto;
  cells: CellOption[];
  receivedSum: string | null;
  value: string;
  onChange: (v: string) => void;
  over: boolean;
}) {
  const target = line.confirmedQty ?? line.qty;
  const remaining = computeRemaining(line, receivedSum);
  return (
    <div
      className="admin-card"
      style={{ padding: 12, display: 'block', boxShadow: 'none' }}
    >
      {/* Скрытое поле lineId — server action собирает по нему набор строк. */}
      <input type="hidden" name="lineId" value={line.id} />
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          gap: 12,
          marginBottom: 8,
        }}
      >
        <div style={{ minWidth: 0 }}>
          <div>
            <strong>{line.itemNameSnapshot}</strong>
            {line.supplierArticleSnapshot ? (
              <span
                className="admin-muted"
                style={{ marginLeft: 6, fontSize: '0.8rem' }}
              >
                арт. {line.supplierArticleSnapshot}
              </span>
            ) : null}
          </div>
          <div
            className="admin-muted"
            style={{ fontSize: '0.8rem', marginTop: 2 }}
          >
            Заказано: {line.qty} {line.unitSnapshot}
            {line.confirmedQty
              ? ` · Подтверждено: ${line.confirmedQty} ${line.unitSnapshot}`
              : ''}
            {receivedSum
              ? ` · Уже принято: ${receivedSum} ${line.unitSnapshot}`
              : ''}
            {' · Цель: '}
            {target} {line.unitSnapshot}
            {remaining != null
              ? ` · Осталось принять: ${remaining} ${line.unitSnapshot}`
              : ''}
          </div>
          <div
            className="admin-muted"
            style={{ fontSize: '0.78rem', marginTop: 2 }}
          >
            Статус строки: {lineLabel(line.status)}
          </div>
        </div>
      </div>
      <div className="admin-form-grid">
        <div className="admin-field">
          <label htmlFor={`receivedQty-${line.id}`}>
            Принято ({line.unitSnapshot})
          </label>
          <input
            id={`receivedQty-${line.id}`}
            name={`receivedQty:${line.id}`}
            type="text"
            inputMode="decimal"
            placeholder="0"
            autoComplete="off"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            aria-invalid={over || undefined}
            style={over ? { borderColor: '#dc2626' } : undefined}
          />
          {over && (
            <span
              className="admin-muted"
              style={{ color: '#dc2626', fontSize: '0.78rem', marginTop: 2 }}
            >
              Больше, чем осталось принять
            </span>
          )}
        </div>
        <div className="admin-field">
          <label htmlFor={`cellId-${line.id}`}>Ячейка</label>
          <CreatableSelect
            entity="warehouseCell"
            id={`cellId-${line.id}`}
            name={`cellId:${line.id}`}
            defaultValue=""
            existingValues={cells.map((c) => c.id)}
          >
            <option value="">Не указана</option>
            {cells.map((c) => (
              <option key={c.id} value={c.id}>
                {c.code}
                {c.warehouseName ? ` · ${c.warehouseName}` : ''}
              </option>
            ))}
          </CreatableSelect>
        </div>
        <div className="admin-field">
          <label htmlFor={`batchNumber-${line.id}`}>Партия</label>
          <input
            id={`batchNumber-${line.id}`}
            name={`batchNumber:${line.id}`}
            type="text"
            maxLength={200}
          />
        </div>
        <div className="admin-field">
          <label htmlFor={`rollNumber-${line.id}`}>Рулон</label>
          <input
            id={`rollNumber-${line.id}`}
            name={`rollNumber:${line.id}`}
            type="text"
            maxLength={200}
          />
        </div>
        <div className="admin-field">
          <label htmlFor={`shade-${line.id}`}>Оттенок</label>
          <input
            id={`shade-${line.id}`}
            name={`shade:${line.id}`}
            type="text"
            maxLength={200}
          />
        </div>
        <div className="admin-field">
          <label htmlFor={`actualWidthCm-${line.id}`}>Ширина (см)</label>
          <input
            id={`actualWidthCm-${line.id}`}
            name={`actualWidthCm:${line.id}`}
            type="number"
            min={0}
            step={1}
          />
        </div>
        <div className="admin-field">
          <label htmlFor={`actualDensityGsm-${line.id}`}>Плотность (г/м²)</label>
          <input
            id={`actualDensityGsm-${line.id}`}
            name={`actualDensityGsm:${line.id}`}
            type="number"
            min={0}
            step={1}
          />
        </div>
        <div className="admin-field" style={{ gridColumn: '1 / -1' }}>
          <label htmlFor={`locationNote-${line.id}`}>
            Доп. место хранения
          </label>
          <input
            id={`locationNote-${line.id}`}
            name={`locationNote:${line.id}`}
            type="text"
            maxLength={200}
            placeholder="Например: «паллета у входа», «полка справа»"
          />
        </div>
        <div className="admin-field" style={{ gridColumn: '1 / -1' }}>
          <label htmlFor={`lineComment-${line.id}`}>Комментарий</label>
          <input
            id={`lineComment-${line.id}`}
            name={`lineComment:${line.id}`}
            type="text"
            maxLength={1000}
          />
        </div>
      </div>
    </div>
  );
}
