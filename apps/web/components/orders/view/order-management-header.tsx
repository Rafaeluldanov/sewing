/**
 * `OrderManagementHeader` — компактная управленческая шапка заказа.
 *
 * Используется на `/admin/orders/[id]` (view-mode) и видна на ВСЕХ
 * вкладках (см. ТЗ «Постоянная шапка заказа»).
 *
 * Состав строго ограничен summary-полями + основными действиями,
 * без таблиц и без дублирующих блоков:
 *
 *   1. Идентификация: номер заказа, бейдж статуса, эйлер «Карточка заказа».
 *   2. Meta-grid (компактная сетка): клиент, срок (deadline-бейдж +
 *      «осталось N дн.»), номенклатура, цвет, общий план, выпущено
 *      паспортов, упаковано, прогресс выпуска.
 *   3. Action-row: workflow (Перевести в расчёт / Запустить в
 *      производство / Завершить / Отменить / Пересчитать план), плюс
 *      «Редактировать» (DRAFT) и «Выпустить паспорт» (IN_PRODUCTION).
 *
 * Что СОЗНАТЕЛЬНО НЕ показываем (см. ТЗ «Не перегружай шапку
 * таблицами»):
 *   - таблиц / списков паспортов;
 *   - производственного size-breakdown;
 *   - материалов / outsource;
 *   - финансовой себестоимости — это в вкладках «Производство» /
 *     «Паспорта» / «Потребности».
 *
 * Backend / DTO / Prisma не задействованы — это presentation-слой.
 * Все workflow-actions — существующие server-actions из
 * `app/orders/actions.ts` (никаких новых API).
 */
import Link from 'next/link';
import {
  AlertTriangle,
  ArrowLeft,
  Calendar,
  CheckCircle2,
  ClipboardList,
  Pencil,
  Truck,
  User,
} from 'lucide-react';
import type { OrderDetailDto } from '@sewing/shared/orders';
import { isOrderPlanEditable } from '@sewing/shared/orders';
import type { PassportListItemDto } from '@sewing/shared/passports';
import { AdminStatusBadge } from '@/components/admin';
import {
  formatOrderStatus,
  getOrderStatusTone,
  type AdminStatusTone,
} from '@/lib/admin-labels';
import {
  formatDateRu,
  formatDaysLeft,
  formatProgressPercent,
} from '@/lib/date-format';
import {
  ORDER_NOMENCLATURE_SOURCE_BADGE,
  resolveOrderNomenclature,
  resolveOrderPatternHref,
} from '@/lib/order-nomenclature';
import { CancelOrderButton } from './cancel-order-button';
import { DeleteOrderButton } from './delete-order-button';
import { CompleteOrderButton } from './complete-order-button';
import { RecalculateOperationPlanButton } from '@/components/orders/recalculate-operation-plan-button';
import { ReopenCalculationButton } from '@/components/orders/reopen-calculation-button';
import { StartCalculationButton } from '@/components/orders/start-calculation-button';
import { StartProductionButton } from '@/components/orders/start-production-button';

interface Props {
  order: OrderDetailDto;
  passports: PassportListItemDto[];
  /**
   * Фича «Варианты просчёта», итерация 3 «стадия per вариант»: активный
   * вариант — черновик (ещё не отправлен на расчёт). На заказе в
   * CALCULATION это включает кнопку «Рассчитать вариант» (та же ручка
   * `start-calculation`, ветка isVariantCalc — статус заказа не меняется).
   */
  activeCalculationDraft?: boolean;
}

/**
 * Компактная сводка одной meta-строки. `value` рендерится крупно
 * (strong), `hint` — сероватым. Иконка слева опциональная.
 */
function HeaderField({
  icon,
  label,
  children,
  hint,
}: {
  icon?: React.ReactNode;
  label: string;
  children: React.ReactNode;
  hint?: string | null;
}) {
  return (
    <div className="order-mgmt-header__field">
      <div className="order-mgmt-header__field-label">
        {icon != null && (
          <span className="order-mgmt-header__field-icon" aria-hidden>
            {icon}
          </span>
        )}
        {label}
      </div>
      <div className="order-mgmt-header__field-value">{children}</div>
      {hint && <div className="order-mgmt-header__field-hint">{hint}</div>}
    </div>
  );
}

export function OrderManagementHeader({
  order,
  passports,
  activeCalculationDraft,
}: Props) {
  const status = order.status;
  const statusTone: AdminStatusTone = getOrderStatusTone(status);
  const statusLabel = formatOrderStatus(status);
  const nomenclature = resolveOrderNomenclature(order);
  const patternHref = resolveOrderPatternHref(order);
  const clientName = order.client?.name ?? order.customer ?? null;
  const deadline = order.deadline ?? null;
  const deadlineTone: AdminStatusTone | null = deadline
    ? ((deadline.tone as AdminStatusTone) ?? 'muted')
    : null;

  // Производственные срезы для шапки (только summary-цифры, без
  // таблиц).
  const totalPlan = order.qtyPlanTotal;
  const totalFinished = order.qtyFinishedTotal;
  const passportsCount = passports.length;
  const packedPassportsCount = passports.filter(
    (p) => p.status === 'PACKED',
  ).length;

  // План на запуск/завершение/отмену зависит от статуса.
  // DRAFT             → «Перевести в расчёт» + «Пересчитать план» + «Отменить» + «Редактировать»
  // CALCULATION       → «Запустить в производство» + «Пересчитать план» + «Отменить» + «Редактировать»
  // CALCULATION_DONE  → «Запустить в производство» + «Вернуть на пересчёт» + «Отменить» + «Редактировать»
  // SAMPLE_PRODUCTION → «Запустить в производство» (полный тираж) + «Отменить»
  // IN_PRODUCTION     → «Завершить» + «Отменить» + «Выпустить паспорт»
  // DONE / CANCELLED  → нет действий (read-only)
  const showStartCalc = status === 'DRAFT';
  // Итерация 3 «стадия per вариант»: активный вариант-черновик на заказе
  // в расчёте — кнопка «Рассчитать вариант» (без смены статуса заказа).
  const showCalcVariant =
    status === 'CALCULATION' && activeCalculationDraft === true;
  // Полный запуск тиража доступен и из «Производства сигнального
  // образца»: образец уже в работе, менеджер запускает весь тираж
  // (backend `OrdersService.start` принимает SAMPLE_PRODUCTION).
  const showStartProd =
    status === 'CALCULATION' ||
    status === 'CALCULATION_DONE' ||
    status === 'SAMPLE_PRODUCTION';
  const showRecalcPlan = status === 'DRAFT' || status === 'CALCULATION';
  const showReopenCalc = status === 'CALCULATION_DONE';
  const showComplete = status === 'IN_PRODUCTION';
  const showCancel =
    status === 'DRAFT' ||
    status === 'CALCULATION' ||
    status === 'CALCULATION_DONE' ||
    status === 'SAMPLE_PRODUCTION' ||
    status === 'IN_PRODUCTION';
  // «Редактировать» доступно до запуска производства (DRAFT/CALCULATION/
  // CALCULATION_DONE): в CALCULATION/CALCULATION_DONE форма даёт править
  // безопасные плановые поля (подразделение, маршрут) + управленческие;
  // материалозатрагивающие — через «Вернуть на пересчёт».
  const showEdit = isOrderPlanEditable(status);

  return (
    <section
      className="order-hero-card order-hero-card--view order-mgmt-header"
      aria-label="Сводка по заказу"
      data-mode="view"
    >
      {/* Идентификация заказа */}
      <header className="order-hero-card__head">
        <div className="order-hero-card__identity">
          <span className="order-hero-card__eyebrow">Карточка заказа</span>
          <h2 className="order-hero-card__title">Заказ {order.number}</h2>
        </div>
        <div className="order-hero-card__status">
          <AdminStatusBadge tone={statusTone}>{statusLabel}</AdminStatusBadge>
        </div>
      </header>

      {/* Компактная сводка полей. Не делаем «больших» KPI-чипов, чтобы
          не повторять то, что показывают вкладки «Производство» и
          «Потребности» подробно. */}
      <div className="order-mgmt-header__grid">
        <HeaderField
          icon={<User size={14} strokeWidth={1.7} aria-hidden />}
          label="Клиент"
        >
          {clientName ? (
            <strong>{clientName}</strong>
          ) : (
            <span className="admin-muted">не указан</span>
          )}
        </HeaderField>

        <HeaderField
          icon={<Calendar size={14} strokeWidth={1.7} aria-hidden />}
          label="Дата заказа"
        >
          {order.orderDate ? (
            <strong>{formatDateRu(order.orderDate)}</strong>
          ) : (
            <span className="admin-muted">не задана</span>
          )}
        </HeaderField>

        <HeaderField
          icon={<Calendar size={14} strokeWidth={1.7} aria-hidden />}
          label="Срок сдачи"
          hint={
            deadline?.daysLeft != null
              ? formatDaysLeft(deadline.daysLeft)
              : null
          }
        >
          {order.dueDate ? (
            <span className="order-mgmt-header__deadline">
              <strong>{formatDateRu(order.dueDate)}</strong>
              {deadline && deadlineTone && (
                <AdminStatusBadge tone={deadlineTone}>
                  {deadline.label}
                </AdminStatusBadge>
              )}
            </span>
          ) : (
            <span className="admin-muted">не задан</span>
          )}
        </HeaderField>

        <HeaderField
          icon={<Calendar size={14} strokeWidth={1.7} aria-hidden />}
          label="Ввод в производство"
        >
          {order.inProductionAt ? (
            <strong>{formatDateRu(order.inProductionAt)}</strong>
          ) : (
            <span className="admin-muted">—</span>
          )}
        </HeaderField>

        <HeaderField label="Изделие / лекало">
          {nomenclature.name ? (
            <span>
              {patternHref ? (
                <Link
                  href={patternHref}
                  title="Открыть карточку лекала"
                  style={{ color: 'var(--color-accent)' }}
                >
                  <strong>{nomenclature.name}</strong>
                </Link>
              ) : (
                <strong>{nomenclature.name}</strong>
              )}
              {nomenclature.source === 'legacyProduct' && (
                <span
                  className="admin-order-item-card__source-badge"
                  title="Историческое изделие без карточки лекала"
                  style={{ marginLeft: 6 }}
                >
                  {ORDER_NOMENCLATURE_SOURCE_BADGE.legacyProduct}
                </span>
              )}
            </span>
          ) : (
            <span className="admin-muted">не выбрано</span>
          )}
        </HeaderField>

        <HeaderField label="Артикул">
          {nomenclature.article ? (
            <strong>{nomenclature.article}</strong>
          ) : (
            <span className="admin-muted">не задан</span>
          )}
        </HeaderField>

        <HeaderField label="Цвет">
          {order.color ? (
            <strong>{order.color}</strong>
          ) : (
            <span className="admin-muted">не задан</span>
          )}
        </HeaderField>

        {/*
          Этап «Склад выпуска готовой продукции» (см.
          `prisma/schema.prisma::Order.finishedGoodsWarehouseId`,
          `docs/current-state.md §«Склад выпуска готовой продукции»`).
          Управленческое поле — НЕ влияет на StockBalance / StockMovement
          материалов. Если не выбран — показываем «Не выбран», без
          предупреждений: новые заказы создавать без склада допустимо.
        */}
        <HeaderField label="Склад готовой продукции">
          {order.finishedGoodsWarehouse ? (
            <strong>
              {order.finishedGoodsWarehouse.name}
              {order.finishedGoodsWarehouse.code
                ? ` (${order.finishedGoodsWarehouse.code})`
                : ''}
            </strong>
          ) : (
            <span className="admin-muted">не выбран</span>
          )}
        </HeaderField>

        {/*
          Упрощённый MVP давальческого сырья / фурнитуры клиента
          (см. `prisma/schema.prisma::Order.materialsAndHardwareCostPolicy`,
          `docs/current-state.md §«Давальческое сырьё клиента»`).
          Это управленческая политика учёта в себестоимости — НЕ влияет
          на расчёт потребности материалов / фурнитуры, на
          MaterialIssue, StockBalance, StockMovement.
        */}
        <HeaderField label="Материалы и фурнитура в себестоимости">
          {(order.materialsAndHardwareCostPolicy ?? 'INCLUDE') === 'EXCLUDE' ? (
            <span>
              <strong>Не учитываются</strong>
              <span
                className="admin-order-item-card__source-badge"
                title="Давальческое сырьё / фурнитура клиента — расчёт потребности и складские движения работают как раньше, в себестоимость заказа не включаются"
                style={{ marginLeft: 6 }}
              >
                Давальческое сырьё / фурнитура клиента
              </span>
            </span>
          ) : (
            <strong>Учитываются</strong>
          )}
        </HeaderField>

        <HeaderField label="Общий план">
          <strong>{totalPlan.toLocaleString('ru-RU')}</strong>
          <span className="order-mgmt-header__unit"> шт</span>
        </HeaderField>

        <HeaderField
          icon={<ClipboardList size={14} strokeWidth={1.7} aria-hidden />}
          label="Выпущено паспортов"
        >
          <strong>{passportsCount.toLocaleString('ru-RU')}</strong>
        </HeaderField>

        <HeaderField
          icon={<Truck size={14} strokeWidth={1.7} aria-hidden />}
          label="Упаковано"
        >
          <strong>{totalFinished.toLocaleString('ru-RU')}</strong>
          <span className="order-mgmt-header__unit"> шт</span>
          {packedPassportsCount > 0 && (
            <span className="order-mgmt-header__unit">
              {' '}
              · {packedPassportsCount} паспортов
            </span>
          )}
        </HeaderField>

        <HeaderField label="Прогресс">
          {deadline?.progressPercent != null ? (
            <span className="order-mgmt-header__progress">
              <strong>
                {formatProgressPercent(deadline.progressPercent)}
              </strong>
              <div
                className="admin-deadline-progress"
                role="progressbar"
                aria-valuenow={deadline.progressPercent ?? 0}
                aria-valuemin={0}
                aria-valuemax={100}
              >
                <div
                  className="admin-deadline-progress__bar"
                  style={{ width: `${deadline.progressPercent}%` }}
                />
              </div>
            </span>
          ) : totalPlan > 0 ? (
            <span>
              <strong>
                {Math.round((totalFinished / totalPlan) * 100)}%
              </strong>
            </span>
          ) : (
            <span className="admin-muted">план не задан</span>
          )}
        </HeaderField>

        {order.comment && (
          <HeaderField label="Комментарий менеджера">
            <span>{order.comment}</span>
          </HeaderField>
        )}
      </div>

      {/* Stale-warning для плана операций — короткая плашка,
          подробности — в вкладке «План». */}
      {order.operationPlanIsStale && (
        <div className="order-mgmt-header__warning">
          <AlertTriangle size={14} strokeWidth={1.7} aria-hidden />
          <span>
            План операций устарел.{' '}
            {order.operationPlanStaleReason ?? 'Требуется пересчёт.'}
          </span>
        </div>
      )}

      {/* Action-row */}
      <div
        className="order-hero-card__actions order-mgmt-header__actions"
        role="group"
        aria-label="Действия по заказу"
      >
        {showStartCalc && <StartCalculationButton orderId={order.id} />}
        {showCalcVariant && (
          <StartCalculationButton orderId={order.id} variantMode />
        )}
        {showStartProd && <StartProductionButton orderId={order.id} />}
        {showRecalcPlan && (
          <RecalculateOperationPlanButton
            orderId={order.id}
            mode="secondary"
          />
        )}
        {showReopenCalc && <ReopenCalculationButton orderId={order.id} />}
        {showComplete && (
          <CompleteOrderButton orderId={order.id} status={status} />
        )}
        {showCancel && (
          <CancelOrderButton orderId={order.id} status={status} />
        )}
        {/* Hard-delete: компонент сам рисует кнопку только для CANCELLED. */}
        <DeleteOrderButton orderId={order.id} status={status} />
        {showEdit && (
          <Link
            href={`/admin/orders/${order.id}/edit`}
            className="admin-btn admin-btn--ghost"
            title={
              status === 'DRAFT'
                ? 'Полное редактирование заказа'
                : 'Редактирование до запуска производства: подразделение, маршрут и управленческие поля (состав/техкарту — через «Вернуть на пересчёт»)'
            }
          >
            <Pencil size={16} strokeWidth={1.6} aria-hidden />
            Редактировать
          </Link>
        )}
        <Link
          href="/admin/orders"
          className="admin-btn admin-btn--ghost"
          aria-label="Вернуться к списку заказов"
        >
          <ArrowLeft size={16} strokeWidth={1.6} aria-hidden />К списку
        </Link>
        {(status === 'DONE' || status === 'CANCELLED') && (
          <span className="order-mgmt-header__actions-hint">
            <CheckCircle2 size={14} strokeWidth={1.7} aria-hidden />
            Заказ {status === 'DONE' ? 'завершён' : 'отменён'} — управленческие действия закрыты.
          </span>
        )}
      </div>
    </section>
  );
}
