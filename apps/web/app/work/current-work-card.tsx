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

import { useCallback, useEffect, useMemo, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ClickableCard } from '@/components/ui/clickable-card';
import type {
  BatchCompleteOperationsResultDto,
  CurrentWorkPassportDto,
} from '@sewing/shared/shifts';
import { ModalPortal } from '@/components/modal-portal';
import { batchCompletePassportsAction } from './actions';
import { playOperationCompletedSound } from './feedback';
import { SEAMSTRESS_WORDING } from './work-wording';

// Швея просила прятать длинный список «Сейчас в работе», чтобы быстрее
// добираться до кнопки «Взять крой» (которую мы подняли над списком в
// `seamstress-active-panel.tsx`). Состояние помним между сессиями, чтобы
// после `router.refresh()` (приём/завершение кроя) свёрнутый список не
// раскрывался обратно.
const COLLAPSED_LS_KEY = 'seamstress.currentWork.collapsed.v1';

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
  /**
   * Текст пустого состояния. Задаётся ролевым словарём
   * (`work-wording.ts`): у швеи «нет кроя в работе», у упаковщика на
   * «Распаковке» кроя ещё не существует — там «нет паспортов».
   * Умолчание сохраняет прежний текст `/work`.
   */
  emptyText?: string;
}

function formatTime(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

export function CurrentWorkCard({
  items,
  shiftOperationId,
  emptyText = SEAMSTRESS_WORDING.emptyText,
}: Props) {
  const router = useRouter();
  // Дефолт — раскрыто; читаем сохранённое значение в useEffect, чтобы не
  // ломать гидрацию (server-render всегда стартует с тем же дефолтом).
  const [collapsed, setCollapsed] = useState(false);

  // -------------------------------------------------------------------
  // Пакетное завершение (мультивыбор чекбоксами).
  //
  // Паспорта в этом списке уже закреплены за швеёй
  // (`currentEmployeeId = me`), поэтому повторный скан для завершения
  // не нужен — она отмечает нужные и жмёт «Завершить выбранные». На
  // backend каждый паспорт закрывается в своей транзакции (партиальный
  // успех), см. `batchCompletePassportsAction`.
  // -------------------------------------------------------------------
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [batchError, setBatchError] = useState<string | null>(null);
  const [batchErrorRequestId, setBatchErrorRequestId] = useState<
    string | undefined
  >(undefined);
  const [failed, setFailed] = useState<
    BatchCompleteOperationsResultDto['failed']
  >([]);
  const [isPending, startTransition] = useTransition();

  // Список паспортов меняется после `router.refresh()` (завершённые
  // уходят) — выкидываем из выбора всё, чего больше нет, и гасим
  // устаревший список «не закрылось».
  useEffect(() => {
    const present = new Set(items.map((p) => p.id));
    setSelected((prev) => {
      const next = new Set([...prev].filter((id) => present.has(id)));
      return next.size === prev.size ? prev : next;
    });
    setFailed((prev) => prev.filter((f) => present.has(f.passportId)));
  }, [items]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      if (window.localStorage.getItem(COLLAPSED_LS_KEY) === '1') {
        setCollapsed(true);
      }
    } catch {
      /* приватный режим/квота — игнорируем */
    }
  }, []);

  const toggle = () => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(COLLAPSED_LS_KEY, next ? '1' : '0');
      } catch {
        /* приватный режим/квота — состояние останется только в сессии */
      }
      return next;
    });
  };

  const toggleSelect = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const allSelected = items.length > 0 && selected.size === items.length;
  const toggleSelectAll = () => {
    setSelected(allSelected ? new Set() : new Set(items.map((p) => p.id)));
  };

  const selectedItems = useMemo(
    () => items.filter((p) => selected.has(p.id)),
    [items, selected],
  );
  const selectedUnits = selectedItems.reduce((acc, p) => acc + p.qtyGood, 0);

  const runBatchComplete = () => {
    const ids = selectedItems.map((p) => p.id);
    if (ids.length === 0) return;
    setBatchError(null);
    setBatchErrorRequestId(undefined);
    startTransition(async () => {
      const res = await batchCompletePassportsAction(ids);
      if (!res.ok || !res.result) {
        setBatchError(res.error ?? 'Не удалось завершить операции');
        setBatchErrorRequestId(res.errorRequestId);
        setConfirmOpen(false);
        return;
      }
      // Звук — как у одиночного завершения, ровно при подтверждённом
      // backend SUCCESS (хотя бы один паспорт закрылся).
      if (res.result.completed.length > 0) playOperationCompletedSound();
      setFailed(res.result.failed);
      setConfirmOpen(false);
      // Снимаем выбор с тех, что закрылись; не закрывшиеся остаются
      // отмеченными, чтобы швея видела, что ещё не ушло.
      const completedIds = new Set(
        res.result.completed.map((c) => c.passportId),
      );
      setSelected((prev) => new Set([...prev].filter((id) => !completedIds.has(id))));
      // revalidatePath + refresh → закрытые паспорта уйдут из списка.
      router.refresh();
    });
  };

  if (items.length === 0) {
    // В пустом состоянии прятать нечего — оставляем неинтерактивную
    // шапку, чтобы свёрнутый/развёрнутый тогл не мигал при появлении
    // первого паспорта.
    return (
      <section
        className="current-work current-work--empty"
        aria-label="Сейчас в работе"
      >
        <h3 className="current-work__title">Сейчас в работе</h3>
        {/* Нейтральная формулировка: после soft-route MVP крой может
            приехать из ячейки (legacy/буфер) или из маршрутного потока
            без ячейки. UX швеи одинаковый — она сканирует QR паспорта и
            подтверждает. Сам текст приходит ролевым словарём: на
            «Распаковке» у упаковщика кроя ещё нет (см. `work-wording.ts`). */}
        <p className="current-work__empty-text">{emptyText}</p>
      </section>
    );
  }

  const passportsCount = items.length;
  const unitsTotal = items.reduce((acc, p) => acc + p.qtyCut, 0);

  return (
    <section className="current-work" aria-label="Сейчас в работе">
      <button
        type="button"
        className="current-work__head current-work__head--toggle"
        onClick={toggle}
        aria-expanded={!collapsed}
        aria-controls="current-work-list"
      >
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
        <span className="current-work__caret" aria-hidden="true">
          {collapsed ? '▸' : '▾'}
        </span>
      </button>
      {!collapsed && (
        <>
          <div className="current-work__select-bar">
            <label className="current-work__select-all">
              <input
                type="checkbox"
                checked={allSelected}
                ref={(el) => {
                  if (el)
                    el.indeterminate =
                      selected.size > 0 && selected.size < items.length;
                }}
                onChange={toggleSelectAll}
                disabled={isPending}
              />
              <span>
                {allSelected ? 'Снять все' : 'Выбрать все'}
                {selected.size > 0 && ` · ${selected.size}`}
              </span>
            </label>
          </div>
          <ul className="current-work__list" id="current-work-list">
            {items.map((p) => (
              <ActivePassportCard
                key={p.id}
                passport={p}
                shiftOperationId={shiftOperationId}
                selected={selected.has(p.id)}
                onToggleSelect={() => toggleSelect(p.id)}
                disabled={isPending}
                failedReason={
                  failed.find((f) => f.passportId === p.id)?.error ?? null
                }
              />
            ))}
          </ul>
        </>
      )}

      {batchError && (
        <div className="error-box" role="alert">
          <div className="error-box__msg">{batchError}</div>
          {batchErrorRequestId && (
            <div className="error-box__rid">
              req: <code>{batchErrorRequestId}</code>
            </div>
          )}
        </div>
      )}

      {failed.length > 0 && !batchError && (
        <div className="error-box" role="status">
          <div className="error-box__msg">
            Не удалось закрыть {failed.length}{' '}
            {pluralPassports(failed.length)} — отмечены ниже. Остальные
            завершены.
          </div>
        </div>
      )}

      {selected.size > 0 && (
        <div className="current-work__actions">
          <button
            type="button"
            className="btn btn-primary btn-lg btn-block"
            onClick={() => {
              setBatchError(null);
              setBatchErrorRequestId(undefined);
              setConfirmOpen(true);
            }}
            disabled={isPending}
          >
            {isPending
              ? 'Завершаем…'
              : `Завершить выбранные (${selected.size})`}
          </button>
        </div>
      )}

      {confirmOpen && (
        <BatchCompleteConfirmModal
          count={selectedItems.length}
          units={selectedUnits}
          pending={isPending}
          onConfirm={runBatchComplete}
          onCancel={() => {
            if (isPending) return;
            setConfirmOpen(false);
          }}
        />
      )}
    </section>
  );
}

/** «паспорт / паспорта / паспортов» для русского счётчика. */
function pluralPassports(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'паспорт';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20))
    return 'паспорта';
  return 'паспортов';
}

/**
 * Модалка-сводка перед пакетным завершением. В отличие от одиночного
 * флоу здесь нет посканной визуальной сверки — паспорта уже в руках у
 * швеи и закреплены за ней, поэтому подтверждаем числом: сколько
 * паспортов и единиц закроется.
 */
function BatchCompleteConfirmModal({
  count,
  units,
  pending,
  onConfirm,
  onCancel,
}: {
  count: number;
  units: number;
  pending: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <ModalPortal>
      <div className="modal-backdrop" role="presentation" onClick={onCancel}>
        <div
          className="modal modal--batch-complete"
          role="dialog"
          aria-modal="true"
          aria-labelledby="batch-complete-title"
          onClick={(e) => e.stopPropagation()}
        >
          <h2 id="batch-complete-title" className="modal__title">
            Завершить операцию по {count} {pluralPassports(count)}?
          </h2>
          <p className="modal__text">
            Будет закрыто <b>{count}</b> {pluralPassports(count)} ·{' '}
            <b>{units}</b> шт. Действие нельзя отменить — паспорта уйдут
            из «Сейчас в работе».
          </p>
          <div className="modal__actions">
            <button
              type="button"
              className="btn"
              onClick={onCancel}
              disabled={pending}
            >
              Отмена
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={onConfirm}
              disabled={pending}
              autoFocus
            >
              {pending ? 'Завершаем…' : 'Завершить'}
            </button>
          </div>
        </div>
      </div>
    </ModalPortal>
  );
}

function ActivePassportCard({
  passport: p,
  shiftOperationId,
  selected,
  onToggleSelect,
  disabled,
  failedReason,
}: {
  passport: CurrentWorkPassportDto;
  shiftOperationId?: string;
  selected: boolean;
  onToggleSelect: () => void;
  disabled: boolean;
  failedReason: string | null;
}) {
  const accepted = formatTime(p.acceptedAt);
  /**
   * Soft-route warning: маршрут есть и текущий шаг != операции смены.
   * Не блокируем — это исключительно UI-подсказка для швеи (см. ТЗ
   * `STEP 8` и `docs/domain.md §«Маршруты производства»`).
   *
   * Разводим два уровня (28.07.2026, см. `passport-confirm-modal.tsx`):
   * если операции смены в маршруте заказа НЕТ ВООБЩЕ — это не «не тот
   * шаг», а работа, которая не засчитается на гейте перед ОТК; такой
   * случай должен выглядеть иначе, иначе тонет в потоке штатных
   * несовпадений.
   */
  const routeMismatch =
    !!p.routeCurrentStep &&
    !!shiftOperationId &&
    p.routeCurrentStep.operationId !== shiftOperationId;
  const shiftOperationOffRoute =
    routeMismatch &&
    p.routeOperationIds.length > 0 &&
    !p.routeOperationIds.includes(shiftOperationId as string);
  /**
   * Route-WIP UI критерий — единый для всех мест /work (см.
   * `passport-confirm-modal.tsx`, `state.ts`). Симметричен серверному
   * правилу route-WIP в `PassportsService.issueToEmployee`: если
   * `currentRouteStepIndex !== null`, паспорт идёт по маршрутному
   * потоку и ячейка между шагами не обязательна.
   */
  const isRouteWip = p.currentRouteStepIndex !== null;
  return (
    <ClickableCard
      as="li"
      href={`/passports/${p.id}`}
      className={`active-passport${
        selected ? ' active-passport--selected' : ''
      }${failedReason ? ' active-passport--failed' : ''}`}
      ariaLabel={`Открыть паспорт ${p.number}`}
    >
      <div className="active-passport__head">
        <label
          className="active-passport__select"
          aria-label={`Выбрать паспорт ${p.number} для завершения`}
        >
          <input
            type="checkbox"
            checked={selected}
            onChange={onToggleSelect}
            disabled={disabled}
          />
        </label>
        <Link
          href={`/passports/${p.id}`}
          className="active-passport__number"
          prefetch={false}
        >
          {p.number}
        </Link>
        <div className="active-passport__head-meta">
          {isRouteWip && (
            <span
              className="active-passport__route-badge"
              aria-label="Паспорт идёт по маршруту"
            >
              Из маршрута
            </span>
          )}
          {accepted && (
            <span className="active-passport__accepted">принят {accepted}</span>
          )}
        </div>
      </div>

      {failedReason && (
        <p className="active-passport__failed" role="status">
          Не закрылось: {failedReason}
        </p>
      )}

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
          {routeMismatch && !shiftOperationOffRoute && (
            <p className="active-passport__route-warn" role="status">
              Ваша смена идёт на другой операции — маршрут заказа сейчас на
              шаге <em>{p.routeCurrentStep?.operationName}</em>. Вы можете
              продолжать работу, паспорт не блокируется.
            </p>
          )}
          {shiftOperationOffRoute && (
            <p className="active-passport__route-alert" role="alert">
              <strong>Операции нет в маршруте этого заказа.</strong> Эта
              работа не засчитается, и заказ встанет на ОТК. Позовите
              мастера.
            </p>
          )}
        </div>
      )}
    </ClickableCard>
  );
}
