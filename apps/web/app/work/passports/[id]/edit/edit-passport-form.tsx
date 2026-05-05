'use client';

import Link from 'next/link';
import { useFormState, useFormStatus } from 'react-dom';
import { useMemo, useState } from 'react';
import { AdminDateField } from '@/components/admin/admin-date-field';
import {
  updateMyPassportAction,
  type UpdatePassportFormState,
} from '@/app/work/passports/actions';

interface SizeOption {
  sizeId: string;
  sizeCode: string;
  sizeSortOrder: number;
  qtyPlan: number;
  qtyCutFact: number;
  remaining: number;
}

interface CutterOption {
  id: string;
  fullName: string;
  login: string;
}

interface InitialValues {
  sizeId: string;
  cutDate: string;
  qtyCut: number;
  rollNumber: string;
  cutterId: string;
}

interface Props {
  passportId: string;
  passportNumber: string;
  orderId: string;
  orderNumber: string;
  productName: string;
  color: string;
  sizes: SizeOption[];
  today: string;
  creatorIsCutter: boolean;
  cutterOptions: CutterOption[];
  initial: InitialValues;
}

const initialState: UpdatePassportFormState = {};

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn btn-primary" disabled={pending}>
      {pending ? 'Сохраняем…' : 'Выпустить паспорт'}
    </button>
  );
}

/**
 * Форма редактирования паспорта на /work/passports/[id]/edit.
 *
 * Контракт перекликается с `NewPassportForm` (поля и валидация
 * совпадают), но:
 *  - submit-кнопка называется «Выпустить паспорт» (как в ТЗ:
 *    «после окончания редактирования выпустить паспорт») и на success
 *    server action `updateMyPassportAction` сам редиректит обратно
 *    на `/work/passports`;
 *  - чекбокса «подать заявку на закрытие раскроя» здесь нет — такой
 *    чекбокс работает только для нового выпуска, для уже созданного
 *    паспорта решение про закрытие раскроя живёт в карточке паспорта
 *    `/passports/[id]`;
 *  - у select-а размера/количества те же остатки, что и у формы
 *    выпуска, но с исключением самого редактируемого паспорта (см.
 *    `page.tsx`).
 */
export function EditPassportForm({
  passportId,
  passportNumber,
  orderId,
  orderNumber,
  productName,
  color,
  sizes,
  creatorIsCutter,
  cutterOptions,
  initial,
}: Props) {
  const action = updateMyPassportAction.bind(null, passportId, orderId);
  const [state, formAction] = useFormState(action, initialState);

  const sortedSizes = useMemo(
    () => [...sizes].sort((a, b) => a.sizeSortOrder - b.sizeSortOrder),
    [sizes],
  );
  const [sizeId, setSizeId] = useState<string>(initial.sizeId);
  const showCutterSelect = !creatorIsCutter && cutterOptions.length > 0;
  const noActiveCutters = !creatorIsCutter && cutterOptions.length === 0;
  const [cutterId, setCutterId] = useState<string>(initial.cutterId);
  const [qtyCut, setQtyCut] = useState<number>(initial.qtyCut);

  const selected = sortedSizes.find((s) => s.sizeId === sizeId);
  // remaining уже посчитан без редактируемого паспорта (см. page.tsx),
  // поэтому максимум, который можно ввести = remaining самого размера.
  const maxQty = selected?.remaining ?? initial.qtyCut;

  return (
    <form action={formAction} className="card">
      {state.error && <div className="error-box">{state.error}</div>}

      <div className="form-row">
        <label>Заказ</label>
        <div>
          <strong>{orderNumber}</strong>
          <div className="hint">Заказ выбран из контекста. Изделие — {productName}, цвет — {color}.</div>
        </div>
      </div>

      <div className="form-row">
        <label>Паспорт</label>
        <div>
          <strong>{passportNumber}</strong>
          <div className="hint">
            Изменения сохранятся для этого же паспорта (номер не меняется).
            Если ошибка серьёзная — удалите паспорт через корзину в
            списке выпущенных и выпустите заново.
          </div>
        </div>
      </div>

      <div className="form-row">
        <label id="sizeId-label" htmlFor="sizeId">Размер</label>
        <div>
          {sortedSizes.length === 0 ? (
            <div className="hint">— нет размеров —</div>
          ) : (
            <div
              className="size-picker"
              role="radiogroup"
              aria-labelledby="sizeId-label"
              id="sizeId"
            >
              {sortedSizes.map((s, idx) => {
                const isActive = sizeId === s.sizeId;
                // Для текущего размера паспорта остаток backend уже
                // посчитан с исключением самого паспорта, поэтому он
                // всегда >= initial.qtyCut. Размеры с remaining=0,
                // отличные от initial.sizeId, остаются disabled.
                const isDisabled =
                  s.remaining <= 0 && s.sizeId !== initial.sizeId;
                return (
                  <label
                    key={s.sizeId}
                    className={
                      'size-picker__option' +
                      (isActive ? ' is-active' : '') +
                      (isDisabled ? ' is-disabled' : '')
                    }
                  >
                    <input
                      type="radio"
                      name="sizeId"
                      value={s.sizeId}
                      checked={isActive}
                      disabled={isDisabled}
                      required={idx === 0}
                      onChange={(e) => setSizeId(e.target.value)}
                      className="size-picker__input"
                    />
                    <span className="size-picker__code">{s.sizeCode}</span>
                    <span className="size-picker__meta">
                      ост. {s.remaining} / {s.qtyPlan}
                    </span>
                  </label>
                );
              })}
            </div>
          )}
          {selected && (
            <div className="hint">
              Доступно по этому размеру: <strong>{selected.remaining}</strong>{' '}
              (план {selected.qtyPlan}, уже раскроено по другим паспортам {selected.qtyCutFact}).
            </div>
          )}
        </div>
      </div>

      <div className="form-row">
        <label htmlFor="cutDate">Дата кроя</label>
        <div>
          <AdminDateField
            id="cutDate"
            name="cutDate"
            required
            defaultValue={initial.cutDate}
          />
        </div>
      </div>

      <div className="form-row">
        <label htmlFor="qtyCut">Количество</label>
        <div>
          <input
            id="qtyCut"
            name="qtyCut"
            type="number"
            min={1}
            step={1}
            inputMode="numeric"
            required
            value={qtyCut}
            onChange={(e) => setQtyCut(Number(e.target.value || 0))}
            max={maxQty || undefined}
          />
          <div className="hint">
            Не больше остатка плана по выбранному размеру (
            {maxQty} шт).
          </div>
        </div>
      </div>

      <div className="form-row">
        <label htmlFor="rollNumber">Номер рулона</label>
        <div>
          <input
            id="rollNumber"
            name="rollNumber"
            type="text"
            required
            maxLength={64}
            placeholder="Например, R-2026-001"
            defaultValue={initial.rollNumber}
          />
        </div>
      </div>

      {showCutterSelect && (
        <div className="form-row">
          <label htmlFor="cutterId">Раскройщик</label>
          <div>
            <select
              id="cutterId"
              name="cutterId"
              required
              value={cutterId}
              onChange={(e) => setCutterId(e.target.value)}
            >
              {cutterOptions.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.fullName} ({c.login})
                </option>
              ))}
            </select>
            <div className="hint">
              Сдельное начисление за раскрой пересчитается на выбранного
              сотрудника.
            </div>
          </div>
        </div>
      )}

      {noActiveCutters && (
        <div className="error-box">
          Нет активных сотрудников с ролью раскройщика. Заведите
          раскройщика в <Link href="/admin/employees">/admin/employees</Link>{' '}
          или активируйте существующего — без этого backend не пропустит
          сохранение (<code>CUTTER_REQUIRED</code>).
        </div>
      )}

      <div className="actions-row">
        <SubmitButton />
        <Link className="btn btn-ghost" href="/work/passports">
          Отмена
        </Link>
      </div>
    </form>
  );
}
