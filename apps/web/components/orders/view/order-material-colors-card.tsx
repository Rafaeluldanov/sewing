/**
 * `OrderMaterialColorsCard` — card-блок «Цвета по строкам техкарты»
 * (этап «Указать в заказе», см. ТЗ §4) — primary input для
 * `selectedColorText` строк `OrderMaterialRequirement.requiresColorSelection
 * = true`.
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
 * `?tab=production#order-material-colors`) и алерту в
 * `OrderActionCenter`. Дополнительно у каждой строки есть
 * `id={mreq-${id}-color}` — на случай прицельной ссылки на
 * конкретную позицию.
 *
 * Раньше блок жил во вкладке «План»; после её удаления переехал во
 * вкладку «Производство» (`OrderProductionTab`). Вынесен в отдельный
 * файл, чтобы production-tab оставался читаемым.
 */
import type {
  OrderDetailDto,
  OrderMaterialRequirementDto,
} from '@sewing/shared/orders';
import {
  TECH_CARD_MATERIAL_COLOR_RULE_LABELS,
  getTechCardMaterialRoleLabel,
} from '@sewing/shared/tech-cards';
import { Lock, Palette } from 'lucide-react';
import {
  AdminCard,
  AdminEmptyState,
  AdminSectionHeader,
  AdminStatusBadge,
} from '@/components/admin';
import { MaterialColorForm } from '@/components/orders/materials/material-color-form';

export function OrderMaterialColorsCard({ order }: { order: OrderDetailDto }) {
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
      // `?tab=production#order-material-colors`.
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
