/**
 * `WorkshopNeedsCard` — блок «Потребность цеха» в карточке заказа.
 *
 * Этап 4А «Потребность цеха» + этап «Расчёт» (см.
 * `docs/recon-soft-integration.md §«Этап 4А»`,
 * `apps/api/src/modules/workshop-needs/*`,
 * `OrdersService.startCalculation`).
 *
 * Серверный компонент: сам грузит список потребностей по заказу
 * через `getOrderWorkshopNeeds(orderId)`. Если backend упал —
 * показываем error-box, но карточку заказа не валим (по тем же
 * принципам, что блок «Заказы клиента» в `/admin/clients/[id]`).
 *
 * UX по статусу заказа:
 *   - `DRAFT`        — потребность ещё не считаем; вместо ручной
 *     кнопки показываем подсказку «Потребность будет создана
 *     после перевода заказа в статус «Расчёт»».
 *   - `CALCULATION`  — потребности уже собраны (или будут после
 *     ретрая); показываем список + ручную кнопку «Пересчитать
 *     потребность» как fallback.
 *   - `IN_PRODUCTION` / `DONE` / `CANCELLED` — read-only режим:
 *     показываем существующий список без кнопки.
 *
 * Manual calculate endpoint остаётся как fallback для CALCULATION
 * (через существующий `CalculateWorkshopNeedsForm`); в DRAFT он
 * больше не показывается, чтобы менеджер пользовался
 * «Перевести в расчёт» (см. `StartCalculationButton`).
 *
 * `force`-пересчёт оставляем API-only: если backend вернул
 * `WORKSHOP_NEEDS_ALREADY_REVIEWED`, показываем понятное сообщение
 * и НЕ предлагаем кнопку force на этом этапе.
 */
import Link from 'next/link';
import { ArrowRight, ClipboardList } from 'lucide-react';
import {
  WORKSHOP_NEED_STATUS_LABELS,
  type WorkshopNeedListItemDto,
  type WorkshopNeedStatus,
} from '@sewing/shared/workshop-needs';
import type { OrderStatus } from '@sewing/shared/orders';
import {
  AdminCard,
  AdminEmptyState,
  AdminSectionHeader,
  AdminStatusBadge,
} from '@/components/admin';
import { ApiRequestError, errorText } from '@/lib/api';
import { getOrderWorkshopNeeds } from '@/lib/workshop-needs-api';
import type { AdminStatusTone } from '@/lib/admin-labels';
import { ClickableCard } from '@/components/ui/clickable-card';
import { CalculateWorkshopNeedsForm } from './workshop-needs-calculate-form';

interface Props {
  orderId: string;
  /**
   * Статус родительского заказа. Управляет режимом блока:
   *   - DRAFT — кнопка «Просчитать потребность» скрыта, показываем
   *     подсказку про перевод в расчёт (новый flow);
   *   - CALCULATION — показываем список + ручную кнопку
   *     «Пересчитать потребность» (fallback);
   *   - IN_PRODUCTION/DONE/CANCELLED — read-only, без manual
   *     calculate-формы.
   *
   * Опционально для backward-compat: если родитель не передал
   * (например, легаси-вызов), считаем как раньше — показываем
   * кнопку (для CUTTER_ASSISTANT-flow или старых страниц).
   */
  orderStatus?: OrderStatus;
}

function statusTone(status: string): AdminStatusTone {
  switch (status as WorkshopNeedStatus) {
    case 'CALCULATED':
      return 'info';
    case 'REVIEWED':
      return 'muted';
    case 'PURCHASE_PLANNED':
      return 'success';
    case 'ORDERED':
      return 'success';
    case 'PARTIALLY_RECEIVED':
      return 'warning';
    case 'RECEIVED':
      return 'success';
    case 'CANCELLED':
      return 'danger';
    default:
      return 'muted';
  }
}

function formatStatus(status: string): string {
  return WORKSHOP_NEED_STATUS_LABELS[status as WorkshopNeedStatus] ?? status;
}

export async function WorkshopNeedsCard({ orderId, orderStatus }: Props) {
  let needs: WorkshopNeedListItemDto[] = [];
  let loadError: string | null = null;
  try {
    needs = await getOrderWorkshopNeeds(orderId);
  } catch (e) {
    loadError =
      e instanceof ApiRequestError
        ? errorText(e)
        : 'Не удалось загрузить потребности';
  }

  // Активные строки идут первыми, отменённые — в самый низ списка.
  const sorted = [...needs].sort((a, b) => {
    const an = a.status === 'CANCELLED' ? 1 : 0;
    const bn = b.status === 'CANCELLED' ? 1 : 0;
    if (an !== bn) return an - bn;
    return 0;
  });
  const visible = sorted.slice(0, 6);

  // Этап «Расчёт»: режим UI определяется статусом заказа
  // (см. JSDoc Props.orderStatus). Если родитель статус не
  // передал — оставляем legacy-поведение (manual-calculate-форма
  // показывается, как раньше).
  const isDraft = orderStatus === 'DRAFT';
  const isCalculation = orderStatus === 'CALCULATION';
  const isReadOnly =
    orderStatus === 'IN_PRODUCTION' ||
    orderStatus === 'DONE' ||
    orderStatus === 'CANCELLED';
  const showManualCalculate =
    orderStatus === undefined || isCalculation;

  return (
    <AdminCard>
      <AdminSectionHeader
        icon={<ClipboardList size={18} strokeWidth={1.7} aria-hidden />}
        title="Потребность цеха"
        hint={needs.length > 0 ? `${needs.length}` : undefined}
        actions={
          needs.length > 0 ? (
            <Link
              href={`/admin/workshop-needs?orderId=${encodeURIComponent(orderId)}`}
              className="admin-table__action-link"
            >
              Все строки
              <ArrowRight size={14} strokeWidth={1.6} aria-hidden />
            </Link>
          ) : undefined
        }
      />

      {loadError && (
        <div className="error-box" role="alert" style={{ marginBottom: 8 }}>
          {loadError}
        </div>
      )}

      {isDraft && (
        <div
          className="admin-muted"
          style={{
            padding: '8px 10px',
            border: '1px dashed rgba(0,0,0,0.12)',
            borderRadius: 6,
            marginBottom: 8,
            fontSize: '0.85rem',
          }}
        >
          Потребность будет создана после перевода заказа в статус
          «Расчёт».
        </div>
      )}

      {showManualCalculate && (
        <CalculateWorkshopNeedsForm
          orderId={orderId}
          hasNeeds={needs.length > 0}
        />
      )}

      {needs.length === 0 ? (
        <AdminEmptyState
          icon={<ClipboardList size={26} strokeWidth={1.6} aria-hidden />}
          title={
            isDraft
              ? 'Потребности ещё не созданы'
              : isReadOnly
                ? 'Потребностей по заказу нет'
                : 'Потребности ещё не рассчитаны'
          }
          hint={
            isDraft
              ? 'Переведите заказ в статус «Расчёт» — система соберёт список материалов автоматически.'
              : isReadOnly
                ? 'У этого заказа не было состава материалов на момент расчёта.'
                : 'Нажмите «Пересчитать потребность», чтобы система собрала список материалов по лекалу и составу материалов.'
          }
        />
      ) : (
        <ul className="admin-summary-list" style={{ marginTop: 8 }}>
          {visible.map((n) => (
            <ClickableCard
              as="li"
              key={n.id}
              href={`/admin/workshop-needs/${n.id}`}
              ariaLabel={n.description}
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                justifyContent: 'space-between',
                gap: 12,
                padding: '6px 0',
                borderTop: '1px solid rgba(0,0,0,0.06)',
              }}
            >
              <div style={{ minWidth: 0, flex: 1 }}>
                <div
                  style={{
                    fontWeight: 500,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}
                >
                  <Link
                    href={`/admin/workshop-needs/${n.id}`}
                    className="admin-table__action-link"
                  >
                    {n.description}
                  </Link>
                  {/*
                    Строка сигнального образца — расход на 1 изделие, а не на
                    тираж. Без метки она читается как дубль тиражной строки
                    того же материала (02-00024: 18 строк тиража и 11 строк
                    образца подряд). Деньги и материалы тиража её и не видят —
                    там скоуп `TIRAGE`, — а этот блок показывает: закупщику
                    материал образца купить надо.
                  */}
                  {n.orderSampleId != null && (
                    <span
                      className="admin-muted"
                      style={{ fontSize: '0.72rem', marginLeft: 6 }}
                    >
                      · образец
                    </span>
                  )}
                </div>
                <div
                  className="admin-muted"
                  style={{ fontSize: '0.78rem', marginTop: 2 }}
                >
                  Чистая: {n.calculatedQty} {n.unit}
                  {n.purchaseQty
                    ? ` · К закупке: ${n.purchaseQty} ${n.unit}`
                    : ''}
                </div>
                {/*
                  Этап 5 «Поставщики»: показываем поставщика из
                  справочника, если выбран; иначе — fallback на
                  текстовое поле, чтобы старые потребности (без
                  справочника) тоже отображались.
                */}
                {(n.selectedSupplierName ?? n.supplierNameText) && (
                  <div
                    className="admin-muted"
                    style={{ fontSize: '0.78rem', marginTop: 2 }}
                  >
                    Поставщик: {n.selectedSupplierName ?? n.supplierNameText}
                  </div>
                )}
              </div>
              <AdminStatusBadge tone={statusTone(n.status)}>
                {formatStatus(n.status)}
              </AdminStatusBadge>
            </ClickableCard>
          ))}
          {needs.length > visible.length && (
            <li
              style={{
                padding: '6px 0',
                borderTop: '1px solid rgba(0,0,0,0.06)',
              }}
            >
              <Link
                href={`/admin/workshop-needs?orderId=${encodeURIComponent(orderId)}`}
                className="admin-table__action-link"
              >
                + ещё {needs.length - visible.length}
                <ArrowRight size={14} strokeWidth={1.6} aria-hidden />
              </Link>
            </li>
          )}
        </ul>
      )}
    </AdminCard>
  );
}
