'use client';

/**
 * Вкладка «Количество» drawer-а «Изменить заказ в производстве» (фича
 * `FEATURE_ORDER_AMENDMENTS`, ФАЗА 1). Модальную оболочку/шапку/CSS даёт
 * `OrderAmendmentDialog`, здесь — только форма и её логика.
 *
 * Контракт: по каждому размеру input «новый план, шт» с нижней границей
 * `max(qtyCut, 1)` (backend отдаст 409 `AMENDMENT_BELOW_CUT` при заниже);
 * граница проверяется только у ИЗМЕНЁННЫХ строк — раскрой бывает с запасом,
 * и нетронутая строка с планом ниже своего раскроя не должна блокировать
 * правку соседнего размера. На backend уходят только реально изменившиеся
 * строки; обязательна «Причина». ≥2 расцветок (`multiVariant`) — блок с
 * пояснением.
 */

import { useEffect, useMemo, useState } from 'react';
import { useFormState, useFormStatus } from 'react-dom';
import { AlertTriangle, CheckCircle, Info, XCircle } from 'lucide-react';
import type { QuantityAmendmentStateDto } from '@sewing/shared';
import { applyQuantityAmendmentAction } from '@/app/admin/orders/[id]/amendment-actions';
import { initialQuantityAmendmentFormState } from '@/app/admin/orders/[id]/amendment-form-state';

interface Props {
  orderId: string;
  state: QuantityAmendmentStateDto;
  onClose: () => void;
}

function SubmitButton({ disabled }: { disabled: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className="admin-btn admin-btn--primary"
      disabled={pending || disabled}
    >
      <CheckCircle size={16} strokeWidth={1.6} aria-hidden />
      {pending ? 'Применяем…' : 'Применить'}
    </button>
  );
}

export function QuantityAmendmentTab({ orderId, state, onClose }: Props) {
  const [qtyBySize, setQtyBySize] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      state.rows.map((r) => [r.sizeId, String(r.currentQtyPlan)]),
    ),
  );
  const [reason, setReason] = useState('');

  const [formState, formAction] = useFormState(
    applyQuantityAmendmentAction.bind(null, orderId),
    initialQuantityAmendmentFormState,
  );

  const succeededNoWarnings =
    formState.ok && (formState.result?.warnings.length ?? 0) === 0;

  useEffect(() => {
    if (succeededNoWarnings) onClose();
  }, [succeededNoWarnings, onClose]);

  const floorOf = (qtyCut: number) => Math.max(qtyCut, 1);
  const parse = (raw: string): number | null => {
    const n = Number(String(raw).replace(',', '.'));
    return Number.isInteger(n) ? n : null;
  };

  const changes = useMemo(() => {
    return state.rows
      .map((r) => {
        const n = parse(qtyBySize[r.sizeId] ?? '');
        if (n === null || n === r.currentQtyPlan) return null;
        return { sizeId: r.sizeId, newQtyPlan: n };
      })
      .filter((c): c is { sizeId: string; newQtyPlan: number } => Boolean(c));
  }, [state.rows, qtyBySize]);

  // Нижняя граница проверяется ТОЛЬКО у изменённых строк — ровно как на
  // backend (он валидирует dto.changes). Раскрой бывает с запасом, и строка
  // может уже стоять ниже своего раскроя (план 130 при раскрое 138); такая
  // строка не трогается этой правкой и не должна блокировать соседний размер.
  const isRowBelowFloor = (r: QuantityAmendmentStateDto['rows'][number]) => {
    const n = parse(qtyBySize[r.sizeId] ?? '');
    return n !== null && n !== r.currentQtyPlan && n < floorOf(r.qtyCut);
  };

  const anyBelowFloor = state.rows.some(isRowBelowFloor);

  const totalBefore = state.rows.reduce((s, r) => s + r.currentQtyPlan, 0);
  const totalAfter = state.rows.reduce((s, r) => {
    const n = parse(qtyBySize[r.sizeId] ?? '');
    return s + (n !== null && n >= 0 ? n : r.currentQtyPlan);
  }, 0);
  const deltaTotal = totalAfter - totalBefore;

  const reasonTrimmed = reason.trim();
  const canSubmit =
    !state.multiVariant &&
    changes.length > 0 &&
    !anyBelowFloor &&
    reasonTrimmed.length > 0;

  const payload = JSON.stringify({ changes, reason: reasonTrimmed });
  const showResultPanel = formState.ok && !succeededNoWarnings;

  if (showResultPanel) {
    return (
      <div>
        <div className="amend-note amend-note--ok">
          <CheckCircle size={16} strokeWidth={1.7} aria-hidden />
          Количество обновлено.
        </div>
        {(formState.result?.warnings ?? []).map((w, i) => (
          <div key={i} className="amend-note amend-note--warn">
            <AlertTriangle size={16} strokeWidth={1.7} aria-hidden />
            {w}
          </div>
        ))}
        <div className="admin-actions-row">
          <button
            type="button"
            className="admin-btn admin-btn--primary"
            onClick={onClose}
          >
            Закрыть
          </button>
        </div>
      </div>
    );
  }

  return (
    <form action={formAction} className="admin-form">
      <input type="hidden" name="payload" value={payload} />

      {state.multiVariant && (
        <div className="amend-note amend-note--info">
          <Info size={16} strokeWidth={1.7} aria-hidden />У заказа несколько
          расцветок — правка количества per-цвет пока не поддержана. Будет в
          следующей версии.
        </div>
      )}
      {state.needsHaveStock && !state.multiVariant && (
        <div className="amend-note amend-note--info">
          <Info size={16} strokeWidth={1.7} aria-hidden />
          По потребностям уже есть движения склада — после правки их нужно
          будет обновить вручную на вкладке «Потребности».
        </div>
      )}

      <table className="admin-table amend-table">
        <thead>
          <tr>
            <th>Размер</th>
            <th style={{ textAlign: 'right' }}>Раскроено</th>
            <th style={{ textAlign: 'right' }}>План сейчас</th>
            <th style={{ textAlign: 'right' }}>Новый план, шт</th>
          </tr>
        </thead>
        <tbody>
          {state.rows.map((r) => {
            const raw = qtyBySize[r.sizeId] ?? '';
            const floor = floorOf(r.qtyCut);
            const isBad = isRowBelowFloor(r);
            // HTML-валидация не умеет «>= floor ИЛИ = текущий план», а
            // текущий план обязан оставаться допустимым (иначе строка с
            // раскроем сверх плана делает форму невалидной и не даёт
            // отправить правку по другому размеру).
            const inputMin = Math.min(floor, r.currentQtyPlan);
            return (
              <tr key={r.sizeId} data-size-id={r.sizeId}>
                <th scope="row">{r.sizeCode}</th>
                <td style={{ textAlign: 'right' }}>
                  {r.qtyCut.toLocaleString('ru-RU')}
                </td>
                <td style={{ textAlign: 'right' }}>
                  {r.currentQtyPlan.toLocaleString('ru-RU')}
                </td>
                <td style={{ textAlign: 'right' }}>
                  <input
                    type="number"
                    min={inputMin}
                    step={1}
                    value={raw}
                    disabled={state.multiVariant}
                    onChange={(e) =>
                      setQtyBySize((prev) => ({
                        ...prev,
                        [r.sizeId]: e.target.value,
                      }))
                    }
                    style={{
                      width: 96,
                      textAlign: 'right',
                      borderColor: isBad
                        ? 'var(--admin-danger-fg, #b91c1c)'
                        : undefined,
                    }}
                    aria-invalid={isBad ? true : undefined}
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <div className="amend-summary">
        Итог тиража: {totalBefore.toLocaleString('ru-RU')} →{' '}
        <strong>{totalAfter.toLocaleString('ru-RU')}</strong> шт
        {deltaTotal !== 0 && (
          <span
            className="amend-delta"
            style={{ color: deltaTotal > 0 ? '#1f7a1f' : '#b91c1c' }}
          >
            {' '}
            ({deltaTotal > 0 ? '+' : ''}
            {deltaTotal.toLocaleString('ru-RU')})
          </span>
        )}
        {anyBelowFloor && (
          <span className="amend-hint--bad"> — план нельзя опустить ниже раскроя.</span>
        )}
      </div>

      <div className="admin-field" style={{ marginTop: 4 }}>
        <label htmlFor="amendQtyReason">Причина правки *</label>
        <input
          id="amendQtyReason"
          type="text"
          maxLength={500}
          value={reason}
          disabled={state.multiVariant}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Например, клиент увеличил тираж по M на 20 шт"
        />
      </div>

      {formState.error && (
        <div role="alert" className="amend-note amend-note--bad">
          <XCircle size={14} strokeWidth={1.6} aria-hidden />
          {formState.error}
        </div>
      )}

      <div className="admin-actions-row">
        <SubmitButton disabled={!canSubmit} />
        <button
          type="button"
          className="admin-btn admin-btn--ghost"
          onClick={onClose}
        >
          Отмена
        </button>
        <span className="admin-muted amend-foot">
          Обновит план, задачу раскроя, снимок материалов и плановую стоимость.
          Уже раскроенное не тронет.
        </span>
      </div>
    </form>
  );
}
