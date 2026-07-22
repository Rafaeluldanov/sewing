'use client';

/**
 * Ряд вкладок «Варианты просчёта» НАД окном заказа (фича
 * `FEATURE_ORDER_CALCULATIONS`).
 *
 * Каждый вариант — «ещё одно такое же окно заказа»: активная вкладка =
 * живые данные заказа, всё существующее содержимое страницы (Производство /
 * Паспорта / Операции / Сводно / Потребности / История) показывает именно
 * её. Клик по неактивной вкладке переключает активный вариант на бэке
 * (restore снимка + пересборка производных) и обновляет страницу.
 *
 * Ярлык вкладки: название + себестоимость (живая у активной, снимок у
 * неактивных) — варианты сравниваются, не переключаясь.
 *
 * `canSwitch=false` (заказ вне DRAFT/CALCULATION): переключение/создание/
 * удаление недоступны — вкладки остаются как история просчёта.
 *
 * CSS — свой блок `.order-calc-tabs*` в `globals.css` (НЕ переиспользуем
 * `.order-detail-tabs*`: это другой уровень навигации, и smoke-тесты
 * грепают те классы).
 */

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { OrderCalculationsDto } from '@sewing/shared';
import {
  activateCalculationAction,
  createCalculationAction,
  deleteCalculationAction,
  renameCalculationAction,
} from '@/app/admin/orders/[id]/calculations-actions';

interface Props {
  orderId: string;
  initial: OrderCalculationsDto;
  /**
   * edit-режим: перед переключением предупреждаем, что несохранённые
   * правки формы будут потеряны.
   */
  warnUnsavedForm?: boolean;
  /**
   * Компактный режим (экран закупщика `/admin/workshop-needs`): только
   * ПЕРЕКЛЮЧЕНИЕ вариантов — без «+ Вариант просчёта», переименования и
   * удаления. Управление составом вариантов живёт в карточке заказа.
   */
  compact?: boolean;
}

function formatCost(value: string | null): string | null {
  if (value == null) return null;
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  return `${num.toLocaleString('ru-RU', { maximumFractionDigits: 0 })} ₽`;
}

export function OrderCalcTabs({
  orderId,
  initial,
  warnUnsavedForm,
  compact,
}: Props) {
  const router = useRouter();
  const [dto, setDto] = useState<OrderCalculationsDto>(initial);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const apply = (result: {
    ok: boolean;
    error?: string;
    data?: OrderCalculationsDto;
  }) => {
    if (result.ok && result.data) {
      setDto(result.data);
      setError(null);
      // Содержимое ВСЕХ вкладок окна заказа зависит от активного
      // варианта — перечитываем server components.
      router.refresh();
    } else {
      setError(result.error ?? 'Не удалось выполнить действие');
    }
  };

  const onActivate = (calcId: string, title: string) => {
    if (isPending || !dto.canSwitch || calcId === dto.activeId) return;
    const warning = warnUnsavedForm
      ? `Переключить на «${title}»? Несохранённые правки формы будут потеряны. Окно заказа покажет данные этого варианта; если он ещё не рассчитан — потребности рассчитаются при переключении.`
      : `Переключить на «${title}»? Окно заказа покажет данные этого варианта; если он ещё не рассчитан — потребности рассчитаются при переключении. Потребности других вариантов не затрагиваются.`;
    if (!window.confirm(warning)) return;
    startTransition(async () => {
      apply(await activateCalculationAction(orderId, calcId));
    });
  };

  const onCreate = () => {
    if (isPending || !dto.canSwitch) return;
    startTransition(async () => {
      apply(await createCalculationAction(orderId, {}));
    });
  };

  const onRename = (calcId: string, currentTitle: string) => {
    if (isPending) return;
    const title = window.prompt('Название варианта', currentTitle)?.trim();
    if (!title || title === currentTitle) return;
    startTransition(async () => {
      apply(await renameCalculationAction(orderId, calcId, { title }));
    });
  };

  const onDelete = (calcId: string, title: string) => {
    if (isPending || !dto.canSwitch) return;
    if (!window.confirm(`Удалить вариант «${title}»? Его снимок будет потерян.`)) {
      return;
    }
    startTransition(async () => {
      apply(await deleteCalculationAction(orderId, calcId));
    });
  };

  const lockHint = dto.canSwitch
    ? undefined
    : 'Варианты зафиксированы: заказ прошёл этап расчёта. Активный вариант запущен, остальные — история просчёта.';

  return (
    <div className="order-calc-tabs" data-pending={isPending || undefined}>
      <div className="order-calc-tabs__row" role="tablist" aria-label="Варианты просчёта">
        {dto.items.map((item) => {
          const cost = formatCost(item.costTotalRub);
          const isActive = item.isActive;
          return (
            <div
              key={item.id}
              className={[
                'order-calc-tabs__tab',
                isActive ? 'order-calc-tabs__tab--active' : null,
                !dto.canSwitch && !isActive
                  ? 'order-calc-tabs__tab--locked'
                  : null,
              ]
                .filter(Boolean)
                .join(' ')}
              title={!isActive ? lockHint : undefined}
            >
              <button
                type="button"
                role="tab"
                aria-selected={isActive}
                className="order-calc-tabs__switch"
                disabled={isPending || (!dto.canSwitch && !isActive)}
                onClick={() => onActivate(item.id, item.title)}
              >
                <span className="order-calc-tabs__title">{item.title}</span>
                {/* Итерация 3 «стадия per вариант»: черновик ещё не
                    отправлен на расчёт — считается только кнопкой
                    «Перевести в расчёт»/«Рассчитать вариант». */}
                {item.sentToCalculationAt == null ? (
                  <span
                    className="order-calc-tabs__stage"
                    title="Вариант ещё не отправлен на расчёт"
                  >
                    черновик
                  </span>
                ) : null}
                {cost ? (
                  <span className="order-calc-tabs__cost">{cost}</span>
                ) : null}
              </button>
              {/* Компактный режим (экран закупщика): только переключение —
                  состав вариантов правится в карточке заказа. */}
              {!compact && (
                <button
                  type="button"
                  className="order-calc-tabs__icon-btn"
                  title="Переименовать вариант"
                  aria-label={`Переименовать вариант «${item.title}»`}
                  disabled={isPending}
                  onClick={() => onRename(item.id, item.title)}
                >
                  ✎
                </button>
              )}
              {!compact && !isActive && dto.canSwitch ? (
                <button
                  type="button"
                  className="order-calc-tabs__icon-btn"
                  title="Удалить вариант"
                  aria-label={`Удалить вариант «${item.title}»`}
                  disabled={isPending}
                  onClick={() => onDelete(item.id, item.title)}
                >
                  ×
                </button>
              ) : null}
            </div>
          );
        })}
        {!compact && (
          <button
            type="button"
            className="order-calc-tabs__add"
            disabled={isPending || !dto.canSwitch}
            title={lockHint ?? 'Скопировать активный вариант в новую вкладку'}
            onClick={onCreate}
          >
            + Вариант просчёта
          </button>
        )}
      </div>
      {error ? <div className="order-calc-tabs__error">{error}</div> : null}
    </div>
  );
}

/**
 * Create-mode заглушка (`/admin/orders/new`): заказа ещё нет, поэтому
 * рисуем единственную вкладку «Вариант 1» и disabled-кнопку добавления —
 * по образцу disabled-вкладок `OrderDetailTabs` в create-mode.
 */
export function OrderCalcTabsCreatePlaceholder() {
  return (
    <div className="order-calc-tabs">
      <div className="order-calc-tabs__row" role="tablist" aria-label="Варианты просчёта">
        <div className="order-calc-tabs__tab order-calc-tabs__tab--active">
          <span className="order-calc-tabs__switch">
            <span className="order-calc-tabs__title">Вариант 1</span>
          </span>
        </div>
        <button
          type="button"
          className="order-calc-tabs__add"
          disabled
          title="Доступно после создания заказа."
        >
          + Вариант просчёта
        </button>
      </div>
    </div>
  );
}
