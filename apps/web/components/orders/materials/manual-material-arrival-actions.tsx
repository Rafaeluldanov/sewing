/**
 * `ManualMaterialArrivalActions` — компактный блок «ручной разблокировки
 * кроя» под unified-таблицей материалов в карточке заказа
 * `/admin/orders/[id]` (вкладка «Материалы»).
 *
 * Зачем:
 *   - Заменить большую `CutReadinessCard` (она убрана из этой вкладки)
 *     на минимально необходимое действие — `MaterialArrivedButton`.
 *   - Дать понятную подсказку: ручная отметка разблокирует крой,
 *     но не создаёт складскую приёмку и не меняет остатки. Это
 *     дословное требование ТЗ.
 *
 * Когда показываем кнопку:
 *   - У заказа есть material-blockers (`CutReadinessDto.sections.materials`
 *     с `status === 'BLOCKER'`);
 *   - Заказ ещё в работе (статус не `DONE` / `CANCELLED`).
 *   Backend всё равно защищает action RBAC-ом, но UI не предлагает
 *   действие, которое ничего не изменит.
 *
 * Активные overrides:
 *   - Если есть ACTIVE-overrides, показываем компактный
 *     `<details>`-список (кто отметил / когда / комментарий + кнопка
 *     отменить). Это намеренно не отдельная карточка — просто детали
 *     под кнопкой, чтобы вкладка осталась compact.
 *
 * Backend / Prisma / OrderMaterialArrivalOverride logic не менялись.
 */
import { PackageOpen } from 'lucide-react';
import {
  type CutMaterialArrivalOverrideRefDto,
  type CutMaterialReadinessDto,
  type CutReadinessDto,
} from '@sewing/shared/cut-readiness';
import type { OrderStatus } from '@sewing/shared/orders';
import { ApiRequestError, errorText } from '@/lib/api';
import { getOrderCutReadiness } from '@/lib/cut-readiness-api';
import { MaterialArrivedButton } from '@/components/orders/material-arrived-button';
import { RevokeMaterialArrivalButton } from '@/components/orders/revoke-material-arrival-button';

interface Props {
  orderId: string;
  orderStatus?: OrderStatus;
  /**
   * Опциональный pre-loaded `CutReadinessDto`. Если родитель уже
   * подгрузил его (например, для unified-таблицы рядом), не делаем
   * повторный fetch.
   */
  cutReadiness?: CutReadinessDto | null;
}

interface ActiveOverrideEntry {
  override: CutMaterialArrivalOverrideRefDto;
  needDescription: string | null;
  unit: string | null;
}

function collectActiveOverrides(
  cutReadiness: CutReadinessDto | null,
): ActiveOverrideEntry[] {
  if (!cutReadiness) return [];
  const out: ActiveOverrideEntry[] = [];
  for (const m of cutReadiness.sections.materials) {
    const overrides = m.manualArrivalOverrides ?? [];
    for (const ov of overrides) {
      out.push({
        override: ov,
        needDescription: m.description,
        unit: typeof m.unit === 'string' ? m.unit : null,
      });
    }
  }
  // Стабильная сортировка: новые сверху.
  return out.sort(
    (a, b) =>
      new Date(b.override.createdAt).getTime() -
      new Date(a.override.createdAt).getTime(),
  );
}

function hasMaterialBlockers(cutReadiness: CutReadinessDto | null): boolean {
  if (!cutReadiness) return false;
  return cutReadiness.sections.materials.some(
    (m: CutMaterialReadinessDto) => m.status === 'BLOCKER',
  );
}

function isTerminalOrderStatus(status?: OrderStatus): boolean {
  return status === 'DONE' || status === 'CANCELLED';
}

export async function ManualMaterialArrivalActions({
  orderId,
  orderStatus,
  cutReadiness: preloaded,
}: Props) {
  let cutReadiness: CutReadinessDto | null = preloaded ?? null;
  let loadError: string | null = null;
  if (!preloaded) {
    try {
      cutReadiness = await getOrderCutReadiness(orderId);
    } catch (e) {
      cutReadiness = null;
      loadError =
        e instanceof ApiRequestError
          ? errorText(e)
          : 'Не удалось загрузить готовность к крою';
    }
  }

  const showButton =
    hasMaterialBlockers(cutReadiness) && !isTerminalOrderStatus(orderStatus);
  const overrides = collectActiveOverrides(cutReadiness);

  // Если ни кнопки, ни активных overrides — рендерим маленький
  // info-блок: на этом этапе ручная разблокировка не нужна
  // (например, материалы уже приняты или заказ закрыт).
  if (!showButton && overrides.length === 0 && !loadError) {
    return null;
  }

  return (
    <div
      className="order-materials-manual-unlock"
      data-testid="order-materials-manual-unlock"
    >
      {loadError && (
        <div className="error-box" role="alert">
          {loadError}
        </div>
      )}
      <div className="order-materials-manual-unlock__head">
        <PackageOpen size={16} strokeWidth={1.7} aria-hidden />
        <h3 className="order-materials-manual-unlock__title">
          Ручная разблокировка кроя
        </h3>
      </div>
      {showButton && (
        <MaterialArrivedButton orderId={orderId} />
      )}
      {!showButton && overrides.length === 0 && (
        <div className="admin-muted order-materials-manual-unlock__empty">
          Нет нерешённых блокеров — ручная разблокировка не нужна.
        </div>
      )}
      <p className="order-materials-manual-unlock__hint">
        Ручная отметка разблокирует крой, но не создаёт складскую
        приёмку и не меняет остатки.
      </p>
      {overrides.length > 0 && (
        <details
          className="order-materials-manual-unlock__overrides"
          data-testid="order-materials-manual-unlock-overrides"
        >
          <summary>
            Ручные отметки: <strong>{overrides.length}</strong>
          </summary>
          <ul className="order-materials-manual-unlock__overrides-list">
            {overrides.map(({ override, needDescription, unit }) => (
              <li
                key={override.id}
                className="order-materials-manual-unlock__overrides-item"
              >
                <div className="order-materials-manual-unlock__overrides-meta">
                  <strong>{needDescription ?? 'материал'}</strong>
                  {override.qty != null && override.qty !== '' ? (
                    <>
                      {' · '}
                      {String(override.qty)}
                      {unit ? ` ${unit}` : ''}
                    </>
                  ) : null}
                </div>
                <div className="admin-muted order-materials-manual-unlock__overrides-author">
                  {override.createdByName ?? 'не указано'} ·{' '}
                  {new Date(override.createdAt).toLocaleString('ru-RU')}
                </div>
                {override.comment && (
                  <div className="order-materials-manual-unlock__overrides-comment">
                    «{override.comment}»
                  </div>
                )}
                <RevokeMaterialArrivalButton
                  orderId={orderId}
                  overrideId={override.id}
                />
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
