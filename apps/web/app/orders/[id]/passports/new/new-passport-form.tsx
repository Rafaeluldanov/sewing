'use client';

import Link from 'next/link';
import { useFormState, useFormStatus } from 'react-dom';
import { useMemo, useState } from 'react';
import { PrintButton } from '@/components/print-button';
import { buildPassportPrintPath } from '@/lib/browser-api-paths';
import { AdminDateField } from '@/components/admin/admin-date-field';
import {
  createPassportAction,
  type CreatePassportMode,
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

/** Активный сотрудник роли `CUTTER` для select-а раскройщика. */
export interface CutterOption {
  id: string;
  fullName: string;
  login: string;
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
  /**
   * Включает упрощённый «mobile clean» post-create UX для помощника
   * раскройщика на `/work` (см. `docs/screens.md §7.5`): после
   * успешного выпуска не делаем redirect на `/passports/[id]`, а
   * показываем компактный блок с кнопками «Распечатать паспорт» /
   * «Выпустить следующий». Все остальные роли (SHOP_MANAGER /
   * CUTTER / ADMIN) получают прежний redirect в большую карточку.
   *
   * Источник истины — роль текущего пользователя на сервере
   * (`page.tsx`); полю на клиенте мы не доверяем, поэтому `mode`
   * всё равно дополнительно фиксируется на сервере через `bind()`.
   */
  isCutterAssistant: boolean;
  /**
   * PHASE 2 STEP 3 — Cutter attribution.
   *
   * Если creator имеет роль `CUTTER` (рабочее место раскройщика),
   * select раскройщика прячется, и backend подставит самого creator.
   * Иначе показываем select из `cutterOptions` — backend требует
   * явный `cutterId`, чтобы immediate-начисление пошло правильному
   * сотруднику (см. `apps/api/src/modules/passports/passports.service.ts`,
   * `docs/api.md §13`).
   */
  creatorIsCutter: boolean;
  /** Список активных раскройщиков (`Employee.role = CUTTER && active`). */
  cutterOptions: CutterOption[];
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

/**
 * Внешняя обёртка над формой выпуска паспорта.
 *
 * Существует только ради одной вещи: когда помощник раскройщика на
 * /work жмёт «Выпустить следующий» в компактном пост-релизном блоке
 * (см. `CutterAssistantSuccessCard` ниже), нам нужно сбросить
 * `useFormState` обратно в `initialState`, чтобы снова показалась
 * пустая форма. `useFormState` сам по себе reset-метода не имеет —
 * самый дешёвый способ его «погасить» — перемонтировать компонент,
 * у которого он живёт. Делаем это через `key`-bump.
 *
 * Для всех остальных ролей `iteration` навсегда остаётся `0`, и
 * никаких лишних перерендеров не добавляется.
 */
export function NewPassportForm(props: Props) {
  const [iteration, setIteration] = useState(0);
  return (
    <NewPassportFormInner
      key={iteration}
      {...props}
      onIssueAnother={() => setIteration((i) => i + 1)}
    />
  );
}

function NewPassportFormInner({
  orderId,
  orderNumber,
  productId,
  productName,
  color,
  sizes,
  today,
  disabled,
  canRequestCuttingClosure,
  isCutterAssistant,
  creatorIsCutter,
  cutterOptions,
  onIssueAnother,
}: Props & { onIssueAnother: () => void }) {
  // Помощник раскройщика на /work получает inline-режим: server action
  // не редиректит, а возвращает `success` для компактного post-create
  // блока. Менеджер на той же странице получает прежний redirect-режим
  // в большую карточку паспорта.
  const mode: CreatePassportMode = isCutterAssistant ? 'inline' : 'redirect';
  const action = createPassportAction.bind(null, orderId, productId, mode);
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

  // PHASE 2 STEP 3: select раскройщика для не-CUTTER ролей.
  // По умолчанию — первый активный CUTTER, чтобы менеджер не тыкал
  // лишний раз (это не сильнее старого «по умолчанию seed `cutter`»
  // — теперь хотя бы видно, какой раскройщик подставлен).
  const showCutterSelect = !creatorIsCutter && cutterOptions.length > 0;
  const noActiveCutters = !creatorIsCutter && cutterOptions.length === 0;
  const [cutterId, setCutterId] = useState<string>(
    cutterOptions[0]?.id ?? '',
  );

  // Success-state. Помощнику раскройщика отдаём компактный
  // post-create блок (печать + «Выпустить следующий»), всем
  // остальным — старый CombinedResult со ссылкой «Открыть паспорт».
  if (state.success) {
    if (isCutterAssistant) {
      return (
        <CutterAssistantSuccessCard
          orderNumber={orderNumber}
          success={state.success}
          onIssueAnother={onIssueAnother}
        />
      );
    }
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
          <AdminDateField
            id="cutDate"
            name="cutDate"
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
              Сдельное начисление за раскрой запишется выбранному
              сотруднику. См.{' '}
              <code>docs/api.md §24a «Cutter attribution»</code>.
            </div>
          </div>
        </div>
      )}

      {noActiveCutters && (
        <div className="error-box">
          Нет активных сотрудников с ролью раскройщика. Заведите
          раскройщика в <Link href="/admin/employees">/admin/employees</Link>{' '}
          или активируйте существующего — без этого backend не сможет
          записать сдельное начисление за раскрой (
          <code>CUTTER_REQUIRED</code>).
        </div>
      )}

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

/**
 * Компактный пост-релизный блок для помощника раскройщика на /work.
 *
 * Цель — серийный оперативный выпуск паспортов: после создания
 * паспорта НЕ открываем большую карточку `/passports/[id]`, а
 * остаёмся в рабочем поле и даём два действия одного уровня:
 *   - «Распечатать паспорт» — переиспользуем общий `<PrintButton>`
 *     (источник истины — `POST /api/print-jobs`, тот же путь, что и
 *     на `/passports/[id]`); fallback на печатную HTML-форму через
 *     `buildPassportPrintPath` сохранён.
 *   - «Выпустить следующий» — сбрасывает success-state (ремонт через
 *     key-bump в `NewPassportForm`) и возвращает пустую форму. Заказ
 *     остаётся тем же — помощник продолжает выпуск по тому же заказу,
 *     не уходя на /work/cut-orders. Размер не пытаемся «угадать» —
 *     `useState` инициализатор сам выберет первый размер с остатком.
 *
 * Если в этом же сабмите помощник попросил подать заявку на закрытие
 * раскроя (`closure.kind === 'created' | 'failed'`), показываем итог
 * заявки тут же небольшой плашкой — но не запихиваем сюда длинный
 * mixed-result UX, как в `CombinedResult` (он остаётся на пути
 * менеджера). На практике помощнику этого достаточно: дальнейшие
 * операции с заявкой видны мастеру.
 */
function CutterAssistantSuccessCard({
  orderNumber,
  success,
  onIssueAnother,
}: {
  orderNumber: string;
  success: NonNullable<PassportFormState['success']>;
  onIssueAnother: () => void;
}) {
  const { passport, closure } = success;
  const printHref = buildPassportPrintPath(passport.id);
  return (
    <div className="card">
      <div className="success-box">
        <strong>Паспорт {passport.number} выпущен.</strong>
        <div
          className="meta-line"
          style={{
            marginTop: '0.35rem',
            display: 'flex',
            flexWrap: 'wrap',
            gap: '0.6rem',
          }}
        >
          <span>
            Количество: <strong>{passport.qtyCut}</strong> шт
          </span>
          <span>
            Рулон: <strong>{passport.rollNumber}</strong>
          </span>
        </div>
      </div>

      {closure.kind === 'created' && (
        <div className="meta-line" style={{ marginTop: '0.6rem' }}>
          Заявка на закрытие раскроя отправлена мастеру цеха.
        </div>
      )}
      {closure.kind === 'failed' && (
        <div className="error-box" style={{ marginTop: '0.6rem' }}>
          <div className="error-box__msg">
            Заявку на закрытие раскроя отправить не удалось.
          </div>
          <div style={{ marginTop: '0.3rem', fontSize: '0.9rem' }}>
            {closure.error}
          </div>
          <div className="meta-line" style={{ marginTop: '0.4rem' }}>
            Подайте заявку вручную из карточки паспорта.
          </div>
        </div>
      )}

      <div className="actions-row">
        <PrintButton
          sourceType="PASSPORT_PRINT"
          sourceId={passport.id}
          fallbackHref={printHref}
          label="Распечатать паспорт"
        />
        <button
          type="button"
          className="btn btn-primary"
          onClick={onIssueAnother}
        >
          Выпустить следующий
        </button>
        <Link className="btn btn-ghost" href="/work">
          ← На рабочее место
        </Link>
      </div>

      {/*
       * Прямая ссылка «Открыть паспорт» сознательно скрыта в
       * developer-friendly hint, а не в primary-row: задача рабочего
       * места — серийный выпуск, большая карточка существует, но
       * пользователь не должен в неё уходить случайно.
       */}
      <div className="hint" style={{ marginTop: '0.6rem' }}>
        Заказ: <strong>{orderNumber}</strong>. Большая карточка паспорта
        доступна по прямой ссылке{' '}
        <Link href={`/passports/${passport.id}`}>
          /passports/{passport.id}
        </Link>
        , если потребуется детальный просмотр или ОТК. Для следующего
        выпуска по этому же заказу нажмите «Выпустить следующий» —
        заказ останется выбранным.
      </div>
      <div className="hint" style={{ marginTop: '0.3rem' }}>
        Чтобы выпустить паспорт по другому заказу, перейдите{' '}
        <Link href="/work/cut-orders">к выбору заказа</Link>.
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
  if (closure.kind === 'skipped') {
    // Технически недостижимо в `redirect`-режиме (без чекбокса action
    // делает redirect, а не вернёт `'skipped'`). Но TypeScript-у нужен
    // exhaustive switch, и на случай будущих рефакторингов отдадим
    // безопасный fallback вместо `throw`.
    return (
      <div className="card">
        <div className="success-box">
          <strong>Паспорт {passport.number} создан.</strong>
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
