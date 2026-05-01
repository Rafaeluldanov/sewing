'use client';

/**
 * Mobile-first блок «Текущий крой» на /work.
 *
 * Источник данных — `GET /api/shifts/current-work`: backend сам режет
 * по сессии и отдаёт только активные паспорта текущего сотрудника
 * (`Passport.currentEmployeeId = me AND status = IN_PROGRESS`).
 *
 * UX-инвариант: после того, как швея «Приняла» крой в модалке, она
 * всегда видит здесь хотя бы одну карточку. Если активных паспортов
 * нет (только что закончила, ещё ничего не взяла) — спокойный
 * empty-state. Никаких таблиц, никаких баджей-светофоров — крупные
 * значения, приглушённые подписи.
 */

import Link from 'next/link';
import type { CurrentWorkPassportDto } from '@sewing/shared/shifts';

interface Props {
  items: CurrentWorkPassportDto[];
  /**
   * Операция, на которой швея сейчас стоит на смене (`Shift.operationId`).
   * Нужна, чтобы подсветить «scan не туда» по soft-route MVP: если
   * у заказа есть snapshot маршрута и текущий шаг != операции смены —
   * показываем warning в карточке (не блокируем, см.
   * `docs/domain.md §«Маршруты производства»`).
   */
  shiftOperationId?: string;
}

function formatTime(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

export function CurrentWorkCard({ items, shiftOperationId }: Props) {
  if (items.length === 0) {
    return (
      <section
        className="current-work current-work--empty"
        aria-label="Сейчас в работе"
      >
        <h3 className="current-work__title">Сейчас в работе</h3>
        <p className="current-work__empty-text">
          Сейчас у вас нет кроя в работе. Отсканируйте QR паспорта в
          ячейке, чтобы взять крой.
        </p>
      </section>
    );
  }

  const passportsCount = items.length;
  const unitsTotal = items.reduce((acc, p) => acc + p.qtyCut, 0);

  return (
    <section className="current-work" aria-label="Сейчас в работе">
      <div className="current-work__head">
        <h3 className="current-work__title">Сейчас в работе</h3>
        <div
          className="current-work__summary"
          aria-label={`${unitsTotal} единиц кроя в ${passportsCount} паспортах`}
        >
          <span className="current-work__summary-units">{unitsTotal} шт</span>
          <span className="current-work__summary-sep" aria-hidden="true">
            ·
          </span>
          <span className="current-work__summary-passports">
            {passportsCount}
          </span>
        </div>
      </div>
      <ul className="current-work__list">
        {items.map((p) => (
          <ActivePassportCard
            key={p.id}
            passport={p}
            shiftOperationId={shiftOperationId}
          />
        ))}
      </ul>
    </section>
  );
}

function ActivePassportCard({
  passport: p,
  shiftOperationId,
}: {
  passport: CurrentWorkPassportDto;
  shiftOperationId?: string;
}) {
  const accepted = formatTime(p.acceptedAt);
  /**
   * Soft-route warning: маршрут есть и текущий шаг != операции смены.
   * Не блокируем — это исключительно UI-подсказка для швеи (см. ТЗ
   * `STEP 8` и `docs/domain.md §«Маршруты производства»`).
   */
  const routeMismatch =
    !!p.routeCurrentStep &&
    !!shiftOperationId &&
    p.routeCurrentStep.operationId !== shiftOperationId;
  return (
    <li className="active-passport">
      <div className="active-passport__head">
        <Link
          href={`/passports/${p.id}`}
          className="active-passport__number"
          prefetch={false}
        >
          {p.number}
        </Link>
        {accepted && (
          <span className="active-passport__accepted">принят {accepted}</span>
        )}
      </div>

      <div className="active-passport__product">
        {p.productName}
        {p.color ? <span className="active-passport__color">·{' '}{p.color}</span> : null}
      </div>

      <dl className="active-passport__grid">
        <div>
          <dt>Размер</dt>
          <dd className="active-passport__size">{p.sizeCode}</dd>
        </div>
        <div>
          <dt>Количество</dt>
          <dd>
            <span className="active-passport__qty">{p.qtyGood}</span>
            <span className="active-passport__qty-meta">
              {p.qtyGood !== p.qtyCut ? ` из ${p.qtyCut}` : ''} шт
            </span>
          </dd>
        </div>
        <div>
          <dt>Рулон</dt>
          <dd>{p.rollNumber}</dd>
        </div>
        <div>
          <dt>Операция</dt>
          <dd className="active-passport__op">
            {p.currentOperationName ?? '—'}
            {p.currentOperationCode && (
              <span className="active-passport__op-code">
                {' '}
                {p.currentOperationCode}
              </span>
            )}
          </dd>
        </div>
      </dl>

      {(p.routeCurrentStep || p.routeNextStep) && (
        <div
          className="active-passport__route"
          aria-label="Маршрут заказа"
        >
          <div className="active-passport__route-row">
            <span className="active-passport__route-label">Сейчас</span>
            <span className="active-passport__route-value">
              {p.routeCurrentStep ? (
                <>
                  Шаг {p.routeCurrentStep.index + 1}:{' '}
                  {p.routeCurrentStep.operationName}
                  <span className="active-passport__route-code">
                    {' '}
                    {p.routeCurrentStep.operationCode}
                  </span>
                </>
              ) : (
                '— маршрут пройден'
              )}
            </span>
          </div>
          <div className="active-passport__route-row">
            <span className="active-passport__route-label">Далее</span>
            <span className="active-passport__route-value">
              {p.routeNextStep ? (
                <>
                  Шаг {p.routeNextStep.index + 1}:{' '}
                  {p.routeNextStep.operationName}
                  <span className="active-passport__route-code">
                    {' '}
                    {p.routeNextStep.operationCode}
                  </span>
                </>
              ) : (
                '— последний шаг'
              )}
            </span>
          </div>
          {routeMismatch && (
            <p className="active-passport__route-warn" role="status">
              <strong>Внимание:</strong> ваша смена идёт на другой операции —
              маршрут заказа сейчас на шаге{' '}
              <em>{p.routeCurrentStep?.operationName}</em>. Вы можете
              продолжать работу, паспорт не блокируется.
            </p>
          )}
        </div>
      )}
    </li>
  );
}
