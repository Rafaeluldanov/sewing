/**
 * `OrderPlanTab` — вкладка «План» управленческой карточки
 * `/admin/orders/[id]?tab=plan`.
 *
 * Показывает только исходный план / snapshot заказа (см. ТЗ
 * «Вкладка План»):
 *   - продукт / лекало (snapshot или live);
 *   - цвет;
 *   - размеры и плановые количества (`OrderItem[]`);
 *   - маршрут / операции (snapshot `OrderRouteStep[]`);
 *   - привязка к шаблону техкарты (id + название, snapshot
 *     материалов и outsource — в вкладке «Потребности»);
 *   - дата заказа, срок (read-only meta);
 *   - флаг устарелости плана операций (без таблицы цифр — это
 *     уже агрегаты, а не план; см. вкладку «Производство»);
 *   - блок «Цвета по строкам техкарты» (этап «Указать в заказе»,
 *     см. ТЗ §4): primary input для строк
 *     `OrderMaterialRequirement.requiresColorSelection = true`
 *     через reusable `MaterialColorForm`. Source of truth —
 *     `OrderMaterialRequirement.selectedColorText`; `WorkshopNeed`
 *     остаётся derived view + warning, не source of truth.
 *
 * Что СОЗНАТЕЛЬНО НЕ показываем:
 *   - production progress / факты — это во вкладке «Производство»;
 *   - размеры в таблице из `sizeBreakdown` — здесь чисто план,
 *     а не план/факт;
 *   - материалы / outsource — это во вкладке «Потребности».
 *
 * После запуска заказа в производство этот snapshot не должен
 * меняться (ADR-0006); поэтому на карточке нет edit-контролов —
 * редактирование идёт через `/admin/orders/[id]/edit`.
 *
 * Backend / DTO / Prisma не задействованы — это presentation-слой.
 */
import type {
  OrderDetailDto,
  OrderItemDto,
  OrderMaterialRequirementDto,
  OrderRouteStepDto,
} from '@sewing/shared/orders';
import {
  TECH_CARD_MATERIAL_COLOR_RULE_LABELS,
  getTechCardMaterialRoleLabel,
} from '@sewing/shared/tech-cards';
import {
  Calendar,
  Layers,
  Lock,
  Package,
  Palette,
  Workflow,
} from 'lucide-react';
import {
  AdminCard,
  AdminEmptyState,
  AdminRouteSteps,
  AdminSectionHeader,
  AdminSizeGrid,
  AdminStatusBadge,
} from '@/components/admin';
import { MaterialColorForm } from '@/components/orders/materials/material-color-form';
import { formatDateRu } from '@/lib/date-format';
import {
  ORDER_NOMENCLATURE_SOURCE_BADGE,
  resolveOrderNomenclature,
} from '@/lib/order-nomenclature';
import { PatternPreviewCard } from '@/components/orders/pattern-preview-card';

interface Props {
  order: OrderDetailDto;
}

export function OrderPlanTab({ order }: Props) {
  const nomenclature = resolveOrderNomenclature(order);
  const isStarted =
    order.status === 'IN_PRODUCTION' ||
    order.status === 'DONE' ||
    order.status === 'CANCELLED';

  return (
    <div className="order-plan-tab">
      <div className="order-plan-tab__grid">
        <div className="order-plan-tab__col-main">
          <AdminCard className="admin-order-detail-card-compact">
            <AdminSectionHeader
              icon={<Package size={18} strokeWidth={1.7} aria-hidden />}
              title="Продукт"
              hint={
                isStarted
                  ? 'snapshot · план иммутабельный'
                  : 'может меняться до запуска в производство'
              }
            />
            <dl className="admin-deflist">
              <dt>Номенклатура / лекало</dt>
              <dd>
                {nomenclature.name ? (
                  <span>
                    <strong>{nomenclature.name}</strong>
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
              </dd>
              {nomenclature.article && (
                <>
                  <dt>Артикул</dt>
                  <dd>{nomenclature.article}</dd>
                </>
              )}
              <dt>Цвет</dt>
              <dd>
                {order.color ? (
                  <strong>{order.color}</strong>
                ) : (
                  <span className="admin-muted">не задан</span>
                )}
              </dd>
            </dl>
          </AdminCard>

          <AdminCard className="admin-order-detail-card-compact">
            <AdminSectionHeader
              icon={<Calendar size={18} strokeWidth={1.7} aria-hidden />}
              title="Сроки и meta"
            />
            <dl className="admin-deflist">
              <dt>Дата заказа</dt>
              <dd>{formatDateRu(order.orderDate)}</dd>
              <dt>Срок сдачи</dt>
              <dd>{formatDateRu(order.dueDate)}</dd>
              <dt>Создан</dt>
              <dd>{formatDateRu(order.createdAt)}</dd>
              {order.comment && (
                <>
                  <dt>Комментарий менеджера</dt>
                  <dd>{order.comment}</dd>
                </>
              )}
            </dl>
          </AdminCard>

          <AdminCard className="admin-order-detail-card-compact">
            <AdminSectionHeader
              icon={<Package size={18} strokeWidth={1.7} aria-hidden />}
              title="План по размерам"
              hint={
                order.items.length > 0
                  ? `Итого: ${order.qtyPlanTotal.toLocaleString('ru-RU')} шт`
                  : undefined
              }
              actions={
                isStarted ? (
                  <AdminStatusBadge tone="muted">
                    <Lock size={12} strokeWidth={1.7} aria-hidden /> snapshot
                  </AdminStatusBadge>
                ) : null
              }
            />
            {order.items.length === 0 ? (
              <AdminEmptyState
                icon={<Package size={26} strokeWidth={1.6} aria-hidden />}
                title="План по размерам не заполнен"
                hint="Добавьте размеры и количества в форме редактирования."
              />
            ) : (
              <PlanItemsGrid items={order.items} />
            )}
          </AdminCard>

          <AdminCard className="admin-order-detail-card-compact">
            <AdminSectionHeader
              icon={<Workflow size={18} strokeWidth={1.7} aria-hidden />}
              title="Маршрут операций"
              hint={
                order.routeTemplateName ?? order.techCardName ?? undefined
              }
              actions={
                isStarted ? (
                  <AdminStatusBadge tone="muted">
                    <Lock size={12} strokeWidth={1.7} aria-hidden /> snapshot
                  </AdminStatusBadge>
                ) : null
              }
            />
            <dl className="admin-deflist">
              <dt>Шаблон маршрута</dt>
              <dd>
                {order.routeTemplateName ? (
                  <strong>{order.routeTemplateName}</strong>
                ) : (
                  <span className="admin-muted">не выбран</span>
                )}
              </dd>
              <dt>Шаблон техкарты</dt>
              <dd>
                {order.techCardName ? (
                  <strong>{order.techCardName}</strong>
                ) : (
                  <span className="admin-muted">не выбран</span>
                )}
              </dd>
            </dl>
            <RouteStepsList steps={order.routeSteps} />
            {order.operationPlanIsStale && (
              <p
                className="admin-muted"
                style={{ marginTop: 8, fontSize: '0.85rem' }}
              >
                <Layers size={12} strokeWidth={1.7} aria-hidden /> План
                операций устарел:{' '}
                {order.operationPlanStaleReason ??
                  'после расчёта менялись операции, ставки или нормы времени.'}
              </p>
            )}
          </AdminCard>

          <OrderMaterialColorsCard order={order} />
        </div>

        <div className="order-plan-tab__col-aside">
          <PatternPreviewCard order={order} />
        </div>
      </div>
    </div>
  );
}

/**
 * Card-блок «Цвета по строкам техкарты» (этап «Указать в заказе»,
 * см. ТЗ §4) — primary input для `selectedColorText` строк
 * `OrderMaterialRequirement.requiresColorSelection = true`.
 *
 * Source of truth — `OrderMaterialRequirement.selectedColorText`.
 * `WorkshopNeed` намеренно НЕ становится source of truth: он
 * остаётся derived view + warning. Поэтому форма пишет напрямую
 * через server-action `updateOrderMaterialRequirementColorAction`,
 * который вызывает существующий PATCH
 * `/api/orders/:id/material-requirements/:requirementId/color`.
 *
 * Гейт «editable / read-only» сознательно следует тем же правилам,
 * что и legacy-страница `/orders/[id]` (DRAFT/CALCULATION/
 * CALCULATION_DONE — editable; IN_PRODUCTION — read-only c
 * подсказкой; DONE/CANCELLED — read-only). Ужесточать backend-
 * правила здесь не имеет смысла: action всё равно делегирует
 * валидацию на API, мы только подсказываем менеджеру в UI.
 *
 * Anchor `id="order-material-colors"` нужен ссылке-CTA из вкладки
 * «Потребности» (`OrderMaterialsUnifiedTable` →
 * `?tab=plan#order-material-colors`) и алерту в
 * `OrderActionCenter`. Дополнительно у каждой строки есть
 * `id={mreq-${id}-color}` — на случай прицельной ссылки на
 * конкретную позицию.
 */
function OrderMaterialColorsCard({ order }: { order: OrderDetailDto }) {
  const rows = order.materialRequirements.filter(
    (m) => m.requiresColorSelection === true,
  );
  const isColorEditable =
    order.status === 'DRAFT' ||
    order.status === 'CALCULATION' ||
    order.status === 'CALCULATION_DONE';
  const filledCount = rows.filter(
    (m) => !!(m.selectedColorText ?? m.resolvedColorText),
  ).length;

  return (
    <AdminCard
      className="admin-order-detail-card-compact"
      // anchor для CTA «Указать цвет» во вкладке «Потребности» и
      // алерта в OrderActionCenter — ссылка ведёт на
      // `?tab=plan#order-material-colors`.
    >
      <div id="order-material-colors">
        <AdminSectionHeader
          icon={<Palette size={18} strokeWidth={1.7} aria-hidden />}
          title="Цвета по строкам техкарты"
          hint={
            rows.length > 0
              ? `${filledCount} из ${rows.length} указано`
              : undefined
          }
          actions={
            !isColorEditable ? (
              <AdminStatusBadge tone="muted">
                <Lock size={12} strokeWidth={1.7} aria-hidden /> snapshot
              </AdminStatusBadge>
            ) : null
          }
        />
        {rows.length === 0 ? (
          <AdminEmptyState
            icon={<Palette size={26} strokeWidth={1.6} aria-hidden />}
            title="Для этой техкарты нет цветов, выбираемых в заказе"
            hint="Если в техкарте появятся строки с правилом «Указать в заказе», они появятся здесь."
          />
        ) : (
          <ul
            className="order-material-colors__list"
            style={{
              listStyle: 'none',
              margin: 0,
              padding: 0,
              display: 'flex',
              flexDirection: 'column',
              gap: '0.6rem',
            }}
          >
            {rows.map((m) => (
              <OrderMaterialColorRow
                key={m.id}
                orderId={order.id}
                requirement={m}
                editable={isColorEditable}
              />
            ))}
          </ul>
        )}
      </div>
    </AdminCard>
  );
}

function OrderMaterialColorRow({
  orderId,
  requirement,
  editable,
}: {
  orderId: string;
  requirement: OrderMaterialRequirementDto;
  editable: boolean;
}) {
  const m = requirement;
  const colorValue = m.selectedColorText ?? m.resolvedColorText ?? null;
  const isFilled = !!colorValue;
  // Описание собирается из тех же полей, что и legacy-блок
  // («Роль / Полотно / Плотность / Ширина / Размер / Материал»).
  // DTO новых полей не вводим — используем существующий
  // `OrderMaterialRequirementDto`.
  const metaParts: string[] = [];
  if (m.materialRole) {
    metaParts.push(`Роль: ${getTechCardMaterialRoleLabel(m.materialRole)}`);
  }
  if (m.fabricType) metaParts.push(`Полотно: ${m.fabricType}`);
  if (m.densityGsm != null) metaParts.push(`Плотность: ${m.densityGsm} г/м²`);
  if (m.plannedWidthCm != null) {
    metaParts.push(`Ширина: ${m.plannedWidthCm} см`);
  }
  if (m.hardwareSizeText) metaParts.push(`Размер: ${m.hardwareSizeText}`);
  if (m.hardwareMaterialText) {
    metaParts.push(`Материал: ${m.hardwareMaterialText}`);
  }
  // Подсказка про колонку «Цвет» — для не-editable статусов
  // показываем правило техкарты (если оно осмысленно — т.е. не
  // ORDER_SELECTED_COLOR, который и так понятен из заголовка
  // блока).
  const colorRuleHint =
    m.colorRule && m.colorRule !== 'ORDER_SELECTED_COLOR'
      ? TECH_CARD_MATERIAL_COLOR_RULE_LABELS[m.colorRule]
      : null;
  return (
    <li
      id={`mreq-${m.id}-color`}
      className="order-material-colors__row"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '0.25rem',
        padding: '0.6rem 0.75rem',
        borderRadius: 8,
        background: 'rgba(148, 163, 184, 0.08)',
      }}
      data-requirement-id={m.id}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.5rem',
          flexWrap: 'wrap',
        }}
      >
        <strong>{m.name}</strong>
        <span className="admin-muted" style={{ fontSize: '0.85rem' }}>
          — {m.totalQty} {m.unit}
        </span>
        <span style={{ marginLeft: 'auto' }}>
          {isFilled ? (
            <AdminStatusBadge tone="success">Цвет указан</AdminStatusBadge>
          ) : (
            <AdminStatusBadge tone="warning">
              Нужно указать цвет
            </AdminStatusBadge>
          )}
        </span>
      </div>
      {metaParts.length > 0 && (
        <div className="admin-muted" style={{ fontSize: '0.85rem' }}>
          {metaParts.join(' · ')}
        </div>
      )}
      {colorValue && (
        <div className="admin-muted" style={{ fontSize: '0.85rem' }}>
          Текущий цвет: <strong>{colorValue}</strong>
        </div>
      )}
      {!colorValue && colorRuleHint && (
        <div className="admin-muted" style={{ fontSize: '0.85rem' }}>
          Правило техкарты: {colorRuleHint}
        </div>
      )}
      {editable ? (
        <MaterialColorForm
          orderId={orderId}
          requirementId={m.id}
          initialValue={m.selectedColorText ?? null}
          hideHelperText
        />
      ) : (
        <div
          className="admin-muted"
          style={{ fontSize: '0.85rem', fontStyle: 'italic' }}
        >
          Snapshot заморожен — изменение цвета доступно только до запуска
          производства.
        </div>
      )}
    </li>
  );
}

function PlanItemsGrid({ items }: { items: OrderItemDto[] }) {
  const sorted = [...items].sort((a, b) => a.sizeSortOrder - b.sizeSortOrder);
  const sizes = sorted.map((i) => ({ id: i.sizeId, name: i.sizeCode }));
  const planValues: Record<string, number> = {};
  for (const item of sorted) planValues[item.sizeId] = item.qtyPlan;
  return <AdminSizeGrid sizes={sizes} values={planValues} readOnly />;
}

function RouteStepsList({ steps }: { steps: OrderRouteStepDto[] }) {
  if (steps.length === 0) {
    return (
      <p className="admin-muted" style={{ marginTop: 8, fontSize: '0.85rem' }}>
        Маршрут не зафиксирован — заказ ещё не запущен либо запущен без
        шаблона.
      </p>
    );
  }
  const adminSteps = [...steps]
    .sort((a, b) => a.index - b.index)
    .map((s) => ({
      id: s.id,
      index: s.index + 1,
      name: s.operationName,
    }));
  return (
    <div style={{ marginTop: 8 }}>
      <AdminRouteSteps steps={adminSteps} dense />
    </div>
  );
}
