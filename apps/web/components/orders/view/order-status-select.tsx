'use client';

/**
 * `OrderStatusSelect` — бейдж статуса заказа, который раскрывается в
 * список всего маршрута заказа.
 *
 * Заменяет ряд workflow-кнопок в шапке `/admin/orders/[id]`
 * («Перевести в расчёт», «Запустить в производство», «Вернуть на
 * пересчёт», «Завершить», «Отменить»): раньше кнопка недоступного
 * перехода просто не рендерилась, и «почему нельзя» узнавалось только
 * из 409-й ошибки. Теперь в списке видны ВСЕ статусы, а недоступные
 * подписаны причиной.
 *
 * Правила переходов компонент НЕ вычисляет: он рисует
 * `OrderDetailDto.availableTransitions` — их считает backend общим
 * pure-helper-ом `evaluateOrderTransitions`
 * (`@sewing/shared/order-transitions`), который зеркалит гейты
 * `OrdersService`. В строке списка заказов переходов в DTO нет, поэтому
 * компонент догружает их лениво по открытию (`loadOrderTransitionsAction`).
 *
 * Сам переход выполняет `changeOrderStatusAction` — тонкий диспетчер
 * поверх существующих ручек. Новых эндпоинтов смены статуса нет.
 *
 * Что осталось за пределами контрола:
 *   - не-статусные действия («Редактировать», «Пересчитать план»,
 *     «Выпустить паспорт», «Рассчитать вариант») — это кнопки шапки;
 *   - переходы, которые делаются на другом экране (`handledIn`):
 *     «Завершить расчёт» — закупщик на `/admin/workshop-needs`,
 *     «Запустить образец» — форма на вкладке «Сигнальный образец».
 *     Такие пункты рисуются ссылками.
 */

import Link from 'next/link';
import { useEffect, useId, useRef, useState, useTransition } from 'react';
import { Check, ChevronDown, CircleDot, ExternalLink, Lock } from 'lucide-react';
import { ORDER_STATUSES, type OrderStatus } from '@sewing/shared/orders';
import {
  ORDER_TRANSITION_ACTION_LABELS,
  type OrderTransitionAction,
  type OrderTransitionDto,
} from '@sewing/shared/order-transitions';
import { AdminStatusBadge } from '@/components/admin';
import {
  changeOrderStatusAction,
  loadOrderTransitionsAction,
} from '@/app/orders/actions';
import {
  formatOrderStatus,
  getOrderStatusTone,
  type AdminStatusTone,
} from '@/lib/admin-labels';

interface Props {
  orderId: string;
  status: OrderStatus;
  /**
   * Переходы из detail-DTO. `undefined` — режим строки списка: список
   * заказов их не отдаёт (гейты по каждой строке — это N × проверок на
   * рендер), компонент догрузит по открытию.
   */
  transitions?: OrderTransitionDto[];
  /** Компактный вид для строки таблицы `/admin/orders`. */
  compact?: boolean;
  /** Заказ read-only для текущей роли — рисуем статичный бейдж. */
  readOnly?: boolean;
}

/**
 * Что произойдёт после перехода — текст подтверждения. Показываем
 * только для необратимых действий; обратимые (нет таких на сегодня —
 * `REOPEN_CALCULATION` отзывает смету) идут без второго шага.
 *
 * `null` в словаре = подтверждение не нужно.
 */
const CONFIRM_COPY: Record<
  OrderTransitionAction,
  { title: string; bullets: string[]; cta: string; danger?: boolean } | null
> = {
  START_CALCULATION: null,
  COMPLETE_CALCULATION: null,
  START_SAMPLE: null,
  START: {
    title: 'Запустить заказ в производство?',
    bullets: [
      'План замораживается: состав, размеры и маршрут больше не редактируются',
      'Станет доступен выпуск паспортов и крой',
      'Правки в производстве — только через дополнения к заказу',
    ],
    cta: 'Запустить',
  },
  REOPEN_CALCULATION: {
    title: 'Вернуть заказ на пересчёт?',
    bullets: [
      'Текущая себестоимость будет помечена как отозванная (история сохранится)',
      'Закупщик сможет править строки потребности заново',
    ],
    cta: 'Вернуть на пересчёт',
  },
  COMPLETE: {
    title: 'Завершить заказ?',
    bullets: [
      'Незакрытые паспорта останутся незакрытыми',
      'Обычно статус ставится сам — при упаковке последнего изделия',
    ],
    cta: 'Завершить',
  },
  CANCEL: {
    title: 'Отменить заказ?',
    bullets: [
      'Заказ уйдёт в терминальный статус, управленческие действия закроются',
    ],
    cta: 'Отменить заказ',
    danger: true,
  },
};

/**
 * Для запущенного заказа отмена звучит иначе: паспорта уже в цехе, и
 * отмена их не отзовёт. Тот же адресный warning, что был в
 * `CancelOrderButton.buildConfirm`.
 */
function confirmCopyFor(action: OrderTransitionAction, status: OrderStatus) {
  const base = CONFIRM_COPY[action];
  if (!base) return null;
  if (
    action === 'CANCEL' &&
    (status === 'IN_PRODUCTION' || status === 'SAMPLE_PRODUCTION')
  ) {
    return {
      ...base,
      bullets: [
        'В производстве могут быть выпущенные паспорта — отмена не вернёт их обратно',
        ...base.bullets,
      ],
    };
  }
  return base;
}

/** Куда ведёт пункт, который выполняется на другом экране. */
function handledInHref(
  transition: OrderTransitionDto,
  orderId: string,
): string | null {
  if (transition.handledIn === 'WORKSHOP_NEEDS') {
    return `/admin/workshop-needs?orderId=${encodeURIComponent(orderId)}`;
  }
  if (transition.handledIn === 'SAMPLE_TAB') {
    return `/admin/orders/${encodeURIComponent(orderId)}?tab=signalSample`;
  }
  return null;
}

function handledInLabel(transition: OrderTransitionDto): string {
  return transition.handledIn === 'WORKSHOP_NEEDS'
    ? 'На «Расчётах цеха»'
    : 'Форма запуска';
}

export function OrderStatusSelect({
  orderId,
  status,
  transitions,
  compact = false,
  readOnly = false,
}: Props) {
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState<OrderTransitionDto[] | null>(
    transitions ?? null,
  );
  const [loading, setLoading] = useState(false);
  const [confirm, setConfirm] = useState<{
    to: OrderStatus;
    action: OrderTransitionAction;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const wrapRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();

  // Пропсы могут обновиться после revalidate — синхронизируем список,
  // иначе поповер покажет переходы от предыдущего статуса.
  useEffect(() => {
    if (transitions) setLoaded(transitions);
  }, [transitions]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      setConfirm(null);
      buttonRef.current?.focus();
    };
    const onMouseDown = (event: MouseEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) {
        setOpen(false);
        setConfirm(null);
      }
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('mousedown', onMouseDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('mousedown', onMouseDown);
    };
  }, [open]);

  const tone: AdminStatusTone = getOrderStatusTone(status);
  const statusLabel = formatOrderStatus(status);
  const terminal = status === 'DONE' || status === 'CANCELLED';

  // Терминальный заказ и read-only-роль: обычный бейдж без списка.
  if (readOnly || terminal) {
    return (
      <AdminStatusBadge tone={tone}>
        {statusLabel}
      </AdminStatusBadge>
    );
  }

  const handleToggle = () => {
    const next = !open;
    setOpen(next);
    setConfirm(null);
    if (!next) return;
    // Ленивый догруз для строки списка: один запрос по открытию, а не
    // гейты по всем строкам таблицы на рендер.
    if (loaded === null && !loading) {
      setLoading(true);
      void loadOrderTransitionsAction(orderId).then((result) => {
        setLoading(false);
        if (result.error) setError(result.error);
        else setLoaded(result.transitions ?? []);
      });
    }
  };

  const apply = (action: OrderTransitionAction) => {
    setError(null);
    startTransition(async () => {
      const result = await changeOrderStatusAction(orderId, action);
      if (result.error) {
        // Ошибку показываем в поповере, рядом с тем пунктом, который
        // её вызвал — не глотаем и не уводим пользователя.
        setError(result.error);
        setConfirm(null);
        return;
      }
      setConfirm(null);
      setOpen(false);
    });
  };

  const handlePick = (transition: OrderTransitionDto) => {
    if (!transition.allowed || !transition.action) return;
    const copy = confirmCopyFor(transition.action, status);
    if (copy) {
      setConfirm({ to: transition.to, action: transition.action });
      return;
    }
    apply(transition.action);
  };

  const currentIndex = ORDER_STATUSES.indexOf(status);
  const rows = loaded ?? [];
  const confirmCopy = confirm ? confirmCopyFor(confirm.action, status) : null;

  return (
    <div
      className={`order-status-select${
        compact ? ' order-status-select--compact' : ''
      }`}
      ref={wrapRef}
    >
      <button
        type="button"
        ref={buttonRef}
        className={`order-status-select__trigger admin-status-badge admin-status-badge--${tone}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={menuId}
        title="Изменить статус заказа"
        onClick={handleToggle}
        disabled={pending}
      >
        <span className="admin-status-badge__dot" aria-hidden />
        {statusLabel}
        <ChevronDown size={13} strokeWidth={2} aria-hidden />
      </button>

      {open && (
        <div
          className="order-status-select__menu"
          id={menuId}
          role={confirm ? 'dialog' : 'listbox'}
          aria-label="Статус заказа"
        >
          {confirm && confirmCopy ? (
            <div className="order-status-select__confirm">
              <p className="order-status-select__confirm-title">
                {confirmCopy.title}
              </p>
              <ul className="order-status-select__confirm-list">
                {confirmCopy.bullets.map((b) => (
                  <li key={b}>{b}</li>
                ))}
              </ul>
              <div className="order-status-select__confirm-actions">
                <button
                  type="button"
                  className="admin-btn admin-btn--ghost"
                  onClick={() => setConfirm(null)}
                  disabled={pending}
                >
                  Отмена
                </button>
                <button
                  type="button"
                  className={`admin-btn ${
                    confirmCopy.danger ? 'admin-btn--danger' : 'admin-btn--primary'
                  }`}
                  onClick={() => apply(confirm.action)}
                  disabled={pending}
                  aria-busy={pending}
                >
                  {pending ? 'Выполняем…' : confirmCopy.cta}
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className="order-status-select__head">
                <span className="order-status-select__head-title">
                  Статус заказа
                </span>
                <span className="order-status-select__head-hint">
                  маршрут заказа
                </span>
              </div>

              {loading && (
                <p className="order-status-select__loading">
                  Проверяем доступные переходы…
                </p>
              )}

              {/*
                Идём по ВСЕМУ маршруту (`ORDER_STATUSES`), а не только по
                доступным переходам: список показывает, где заказ сейчас,
                что позади и что впереди. Текущий статус — статичная
                строка «сейчас».
              */}
              {!loading &&
                rows.length > 0 &&
                ORDER_STATUSES.map((s) => {
                  if (s === status) {
                    return (
                      <div
                        key={s}
                        className="order-status-select__option order-status-select__option--current"
                        role="option"
                        aria-selected
                      >
                        <span className="order-status-select__option-mark">
                          <CircleDot size={14} strokeWidth={2} aria-hidden />
                        </span>
                        <span className="order-status-select__option-label">
                          {statusLabel}
                        </span>
                        <span className="order-status-select__option-tag">
                          сейчас
                        </span>
                      </div>
                    );
                  }
                  const t = rows.find((row) => row.to === s);
                  if (!t) return null;
                  const label = formatOrderStatus(t.to);
                  // Ссылкой рисуем и разрешённый «Запустить образец», и
                  // запрещённое из карточки «Завершить расчёт»: в обоих
                  // случаях менеджеру нужно попасть на другой экран, а не
                  // упереться в блокировку без выхода.
                  const href = handledInHref(t, orderId);
                  const passed =
                    !t.allowed &&
                    t.to !== 'CANCELLED' &&
                    ORDER_STATUSES.indexOf(t.to) < currentIndex;

                  // Пункт, который выполняется на другом экране —
                  // ссылка, а не действие.
                  if (href) {
                    return (
                      <Link
                        key={t.to}
                        href={href}
                        className="order-status-select__option"
                        role="option"
                        aria-selected={false}
                        onClick={() => setOpen(false)}
                      >
                        <span className="order-status-select__option-mark">
                          <ExternalLink size={14} strokeWidth={1.7} aria-hidden />
                        </span>
                        <span className="order-status-select__option-label">
                          {t.action
                            ? ORDER_TRANSITION_ACTION_LABELS[t.action]
                            : label}
                        </span>
                        <span className="order-status-select__option-tag">
                          {handledInLabel(t)}
                        </span>
                        <span className="order-status-select__option-note">
                          {t.reason ? `${label} — ${t.reason}` : label}
                        </span>
                      </Link>
                    );
                  }

                  const disabled = !t.allowed || !t.action || pending;
                  const note = t.allowed
                    ? label
                    : t.reason ?? 'Недоступен из текущего статуса';

                  return (
                    <button
                      key={t.to}
                      type="button"
                      className={`order-status-select__option${
                        t.allowed ? '' : ' order-status-select__option--blocked'
                      }${
                        t.to === 'CANCELLED'
                          ? ' order-status-select__option--danger'
                          : ''
                      }`}
                      role="option"
                      aria-selected={false}
                      disabled={disabled}
                      onClick={() => handlePick(t)}
                    >
                      <span className="order-status-select__option-mark">
                        {passed ? (
                          <Check size={14} strokeWidth={2} aria-hidden />
                        ) : t.allowed ? (
                          <CircleDot size={14} strokeWidth={1.7} aria-hidden />
                        ) : (
                          <Lock size={13} strokeWidth={1.7} aria-hidden />
                        )}
                      </span>
                      <span className="order-status-select__option-label">
                        {t.allowed && t.action
                          ? ORDER_TRANSITION_ACTION_LABELS[t.action]
                          : label}
                      </span>
                      {passed && (
                        <span className="order-status-select__option-tag">
                          пройден
                        </span>
                      )}
                      <span className="order-status-select__option-note">
                        {note}
                      </span>
                    </button>
                  );
                })}

              {!loading && rows.length === 0 && (
                <p className="order-status-select__loading">
                  Доступных переходов нет.
                </p>
              )}
            </>
          )}

          {error && (
            <div className="error-box" role="alert">
              {error}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
