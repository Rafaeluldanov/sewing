'use client';

import Link from 'next/link';
import { useFormState, useFormStatus } from 'react-dom';
import { useMemo, useState } from 'react';
import {
  createPassportAction,
  type PassportFormState,
} from '../actions';

interface SizeOption {
  sizeId: string;
  sizeCode: string;
  sizeSortOrder: number;
  qtyPlan: number;
  qtyCutFact: number;
  remaining: number;
}

interface Props {
  orderId: string;
  orderNumber: string;
  /**
   * `productId` строки заказа. Нужен только для чекбокса «подать
   * заявку на закрытие раскроя» (CUTTER_ASSISTANT, ADR-0018). Может
   * быть `null` у заказов без изделия — тогда чекбокс прячется.
   */
  productId: string | null;
  productName: string;
  color: string;
  sizes: SizeOption[];
  today: string;
  disabled: boolean;
  /**
   * Показать ли блок «Подать заявку на закрытие раскроя». Источник
   * истины — роль текущего пользователя на сервере (`page.tsx`),
   * чтобы не доверять role-флагу на клиенте.
   */
  canRequestCuttingClosure: boolean;
}

const initialState: PassportFormState = {};

function SubmitButton({ disabled }: { disabled: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className="btn btn-primary"
      disabled={pending || disabled}
    >
      {pending ? 'Сохранение…' : 'Создать паспорт'}
    </button>
  );
}

export function NewPassportForm({
  orderId,
  orderNumber,
  productId,
  productName,
  color,
  sizes,
  today,
  disabled,
  canRequestCuttingClosure,
}: Props) {
  const action = createPassportAction.bind(null, orderId, productId);
  const [state, formAction] = useFormState(action, initialState);
  const sortedSizes = useMemo(
    () => [...sizes].sort((a, b) => a.sizeSortOrder - b.sizeSortOrder),
    [sizes],
  );
  const firstWithRemaining = sortedSizes.find((s) => s.remaining > 0);
  const [sizeId, setSizeId] = useState<string>(
    firstWithRemaining?.sizeId ?? sortedSizes[0]?.sizeId ?? '',
  );
  // Чекбокс показываем только помощнику раскройщика, и только когда
  // у заказа есть `productId` — иначе backend всё равно не сможет
  // создать заявку.
  const closureAvailable = canRequestCuttingClosure && Boolean(productId);
  const [requestClosure, setRequestClosure] = useState(false);

  const selected = sortedSizes.find((s) => s.sizeId === sizeId);

  // Mixed-result / success после combined submit (closure-чекбокс был
  // включён). При выключенном чекбоксе server action делает redirect и
  // сюда мы не попадём.
  if (state.success) {
    return (
      <CombinedResult
        orderId={orderId}
        orderNumber={orderNumber}
        success={state.success}
      />
    );
  }

  return (
    <form action={formAction} className="card">
      {state.error && <div className="error-box">{state.error}</div>}

      <div className="form-row">
        <label>Заказ</label>
        <div>
          <strong>{orderNumber}</strong>
          <div className="hint">Заказ выбран из контекста.</div>
        </div>
      </div>
      <div className="form-row">
        <label>Изделие</label>
        <div>
          <strong>{productName}</strong>
        </div>
      </div>
      <div className="form-row">
        <label>Цвет</label>
        <div>
          <strong>{color}</strong>
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
                const isDisabled = s.remaining <= 0;
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
              Доступно к выпуску по этому размеру: <strong>{selected.remaining}</strong>{' '}
              (план {selected.qtyPlan}, уже раскроено {selected.qtyCutFact}).
            </div>
          )}
        </div>
      </div>

      <div className="form-row">
        <label htmlFor="cutDate">Дата кроя</label>
        <div>
          <input
            id="cutDate"
            name="cutDate"
            type="date"
            required
            defaultValue={today}
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
            defaultValue={selected?.remaining && selected.remaining > 0 ? selected.remaining : 1}
            max={selected?.remaining ?? undefined}
          />
          <div className="hint">
            Не больше остатка плана по выбранному размеру.
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
          />
        </div>
      </div>

      {closureAvailable && (
        <ClosureOptIn
          checked={requestClosure}
          onChange={setRequestClosure}
        />
      )}

      <div className="actions-row">
        <SubmitButton disabled={disabled} />
        <a href={`/orders/${orderId}`} className="btn btn-ghost">
          Отмена
        </a>
      </div>
    </form>
  );
}

/**
 * Inline-блок «Подать заявку на закрытие раскроя» прямо в форме
 * выпуска паспорта. По смыслу — это тот же
 * `requestCuttingClosureAction`, что в карточке паспорта (см.
 * `app/passports/[id]/cutting-closure-section.tsx`), но запускается в
 * одной транзакции UX вместе с создаём паспорта.
 */
function ClosureOptIn({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <div className="form-row">
      <label htmlFor="requestCuttingClosure">Закрытие раскроя</label>
      <div>
        <label
          className={
            'checkbox-card' + (checked ? ' is-active' : '')
          }
          htmlFor="requestCuttingClosure"
        >
          <input
            id="requestCuttingClosure"
            name="requestCuttingClosure"
            type="checkbox"
            checked={checked}
            onChange={(e) => onChange(e.target.checked)}
          />
          <span className="checkbox-card__body">
            <span className="checkbox-card__title">
              Подать заявку на закрытие раскроя
            </span>
            <span className="checkbox-card__hint">
              Мастер цеха подтвердит закрытие этого размера. После
              подтверждения новые паспорта по размеру выпускать будет
              нельзя.
            </span>
          </span>
        </label>
        {checked && (
          <div style={{ marginTop: '0.5rem' }}>
            <label htmlFor="closureReason" className="hint">
              Причина (необязательно)
            </label>
            <textarea
              id="closureReason"
              name="closureReason"
              rows={2}
              maxLength={280}
              placeholder="Например: рулон закончился, ткани больше нет"
            />
          </div>
        )}
      </div>
    </div>
  );
}

function CombinedResult({
  orderId,
  orderNumber,
  success,
}: {
  orderId: string;
  orderNumber: string;
  success: NonNullable<PassportFormState['success']>;
}) {
  const { passport, closure } = success;
  const passportHref = `/passports/${passport.id}`;
  if (closure.kind === 'created') {
    return (
      <div className="card">
        <div className="success-box">
          <strong>Паспорт {passport.number} создан.</strong>{' '}
          Заявка на закрытие раскроя отправлена мастеру цеха.
        </div>
        <div className="actions-row">
          <Link className="btn btn-primary" href={passportHref}>
            Открыть паспорт →
          </Link>
          <Link className="btn" href={`/orders/${orderId}`}>
            ← К заказу {orderNumber}
          </Link>
        </div>
      </div>
    );
  }
  return (
    <div className="card">
      <div className="error-box">
        <div className="error-box__msg">
          <strong>Паспорт {passport.number} создан,</strong> но заявку
          на закрытие раскроя отправить не удалось.
        </div>
        <div style={{ marginTop: '0.4rem', fontSize: '0.9rem' }}>
          {closure.error}
        </div>
      </div>
      <p className="hint" style={{ marginTop: '0.5rem' }}>
        Откройте паспорт и подайте заявку вручную из блока «Закрытие
        раскроя».
      </p>
      <div className="actions-row">
        <Link className="btn btn-primary" href={passportHref}>
          Открыть паспорт и подать заявку →
        </Link>
        <Link className="btn" href={`/orders/${orderId}`}>
          ← К заказу {orderNumber}
        </Link>
      </div>
    </div>
  );
}
