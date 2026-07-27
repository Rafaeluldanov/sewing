'use client';

/**
 * Вкладка «Размерность» drawer-а «Изменить заказ в производстве» (фича
 * `FEATURE_ORDER_AMENDMENTS`, ФАЗА 2): добавить новый размер / убрать
 * размер, по которому ещё нет работы.
 *
 * Контракт:
 *   - «Убрать»: чекбокс только у размеров без раскроя/настилов
 *     (`removable`); по остальным — пометка «в работе», удалить нельзя;
 *   - «Добавить»: input тиража по размерам каталога, которых нет в
 *     заказе; у размеров без файла лекала (`inPattern=false`) —
 *     предупреждение (не запрет);
 *   - обязательна «Причина»; ≥2 расцветок — блок.
 */

import { useEffect, useMemo, useState } from 'react';
import { useFormState, useFormStatus } from 'react-dom';
import {
  AlertTriangle,
  CheckCircle,
  Info,
  Trash2,
  XCircle,
} from 'lucide-react';
import type { SizeAmendmentStateDto } from '@sewing/shared';
import { applySizeAmendmentAction } from '@/app/admin/orders/[id]/amendment-actions';
import { initialSizeAmendmentFormState } from '@/app/admin/orders/[id]/amendment-form-state';

interface Props {
  orderId: string;
  state: SizeAmendmentStateDto;
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

export function SizeAmendmentTab({ orderId, state, onClose }: Props) {
  const [removeChecked, setRemoveChecked] = useState<Record<string, boolean>>(
    {},
  );
  const [addQty, setAddQty] = useState<Record<string, string>>({});
  const [reason, setReason] = useState('');

  const [formState, formAction] = useFormState(
    applySizeAmendmentAction.bind(null, orderId),
    initialSizeAmendmentFormState,
  );

  const succeededNoWarnings =
    formState.ok && (formState.result?.warnings.length ?? 0) === 0;

  useEffect(() => {
    if (succeededNoWarnings) onClose();
  }, [succeededNoWarnings, onClose]);

  const parse = (raw: string): number | null => {
    const n = Number(String(raw).replace(',', '.'));
    return Number.isInteger(n) ? n : null;
  };

  const add = useMemo(() => {
    return state.available
      .map((s) => {
        const n = parse(addQty[s.sizeId] ?? '');
        if (n === null || n < 1) return null;
        return { sizeId: s.sizeId, qtyPlan: n };
      })
      .filter((a): a is { sizeId: string; qtyPlan: number } => Boolean(a));
  }, [state.available, addQty]);

  const remove = useMemo(
    () =>
      state.current
        .filter((r) => r.removable && removeChecked[r.sizeId])
        .map((r) => r.sizeId),
    [state.current, removeChecked],
  );

  const reasonTrimmed = reason.trim();
  const canSubmit =
    !state.multiVariant &&
    add.length + remove.length > 0 &&
    reasonTrimmed.length > 0;

  const payload = JSON.stringify({ add, remove, reason: reasonTrimmed });
  const showResultPanel = formState.ok && !succeededNoWarnings;

  if (showResultPanel) {
    return (
      <div>
        <div className="amend-note amend-note--ok">
          <CheckCircle size={16} strokeWidth={1.7} aria-hidden />
          Размерность обновлена.
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
          расцветок — правка размерности per-цвет пока не поддержана.
        </div>
      )}

      <div className="amend-subhead">Добавить размеры</div>
      {state.available.length === 0 ? (
        <p className="admin-muted" style={{ fontSize: '0.85rem' }}>
          Все размеры справочника уже в заказе.
        </p>
      ) : (
        <table className="admin-table amend-table">
          <thead>
            <tr>
              <th>Размер</th>
              <th>Лекало</th>
              <th style={{ textAlign: 'right' }}>Добавить, шт</th>
            </tr>
          </thead>
          <tbody>
            {state.available.map((s) => (
              <tr key={s.sizeId} data-add-size-id={s.sizeId}>
                <th scope="row">{s.sizeCode}</th>
                <td>
                  {s.inPattern ? (
                    <span className="admin-muted">есть файл</span>
                  ) : (
                    <span className="amend-hint--bad">нет файла</span>
                  )}
                </td>
                <td style={{ textAlign: 'right' }}>
                  <input
                    type="number"
                    min={1}
                    step={1}
                    value={addQty[s.sizeId] ?? ''}
                    disabled={state.multiVariant}
                    placeholder="—"
                    onChange={(e) =>
                      setAddQty((prev) => ({
                        ...prev,
                        [s.sizeId]: e.target.value,
                      }))
                    }
                    style={{ width: 96, textAlign: 'right' }}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="amend-subhead" style={{ marginTop: 12 }}>
        Убрать размеры
      </div>
      <table className="admin-table amend-table">
        <thead>
          <tr>
            <th />
            <th>Размер</th>
            <th style={{ textAlign: 'right' }}>План</th>
            <th style={{ textAlign: 'right' }}>Раскроено</th>
            <th>Статус</th>
          </tr>
        </thead>
        <tbody>
          {state.current.map((r) => (
            <tr key={r.sizeId} data-remove-size-id={r.sizeId}>
              <td>
                <input
                  type="checkbox"
                  aria-label={`Убрать размер ${r.sizeCode}`}
                  disabled={!r.removable || state.multiVariant}
                  checked={Boolean(removeChecked[r.sizeId])}
                  onChange={(e) =>
                    setRemoveChecked((prev) => ({
                      ...prev,
                      [r.sizeId]: e.target.checked,
                    }))
                  }
                />
              </td>
              <th scope="row">{r.sizeCode}</th>
              <td style={{ textAlign: 'right' }}>
                {r.qtyPlan.toLocaleString('ru-RU')}
              </td>
              <td style={{ textAlign: 'right' }}>
                {r.qtyCut.toLocaleString('ru-RU')}
              </td>
              <td>
                {r.removable ? (
                  <span className="admin-muted">можно убрать</span>
                ) : (
                  <span className="amend-hint--bad">в работе</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="admin-field" style={{ marginTop: 8 }}>
        <label htmlFor="amendSizeReason">Причина правки *</label>
        <input
          id="amendSizeReason"
          type="text"
          maxLength={500}
          value={reason}
          disabled={state.multiVariant}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Например, клиент добавил размер XL, 15 шт"
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
          <Trash2
            size={13}
            strokeWidth={1.6}
            aria-hidden
            style={{ verticalAlign: 'middle', marginRight: 4 }}
          />
          Убрать можно только размер без раскроя. Новый размер добавит строку
          в план и задачу раскроя.
        </span>
      </div>
    </form>
  );
}
