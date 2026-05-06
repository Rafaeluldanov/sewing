/**
 * `OrderFinishedGoodsShipmentSection` — блок «Отгрузка готовой
 * продукции» во вкладке «Производство» карточки заказа
 * (`/admin/orders/[id]?tab=production`).
 *
 * UI-решение владельца проекта (см. ТЗ §9):
 *   - блок живёт ТОЛЬКО в карточке заказа во вкладке «Производство»;
 *   - отдельная страница `/admin/finished-goods` НЕ создаётся;
 *   - новый sidebar-пункт / вкладка / OrderViewTabs НЕ добавляется.
 *
 * Что делает:
 *   1. Загружает остатки готовой продукции по заказу
 *      (`GET /api/finished-goods/balances?orderId=…&positiveOnly=true`)
 *      — это «доступная готовая продукция» к отгрузке;
 *   2. Загружает историю отгрузок
 *      (`GET /api/orders/:orderId/finished-goods-shipments`);
 *   3. Для ADMIN / SHOP_MANAGER показывает кнопку «Создать отгрузку»,
 *      которая раскрывает inline-форму.
 *
 * Backend контракт (см.
 * `apps/api/src/modules/finished-goods/finished-goods.service.ts::createShipmentForOrder`):
 *   - частичная отгрузка поддерживается: можно отгрузить часть
 *     остатка по любому сочетанию product / size / color / warehouse
 *     / cell;
 *   - каждая строка → `FinishedGoodsMovement type=SHIPMENT
 *     direction=OUT`, `FinishedGoodsBalance.qty -= qty`;
 *   - идемпотентно по `clientRequestId`;
 *   - **`Order.status` НЕ меняется** автоматически (см. ТЗ).
 */
import { Truck } from 'lucide-react';
import {
  AdminCard,
  AdminEmptyState,
  AdminSectionHeader,
} from '@/components/admin';
import { ApiRequestError } from '@/lib/api';
import {
  listFinishedGoodsBalances,
  listOrderFinishedGoodsShipments,
  type FinishedGoodsBalanceListItem,
  type FinishedGoodsShipmentDetailDto,
} from '@/lib/finished-goods-api';
import { CreateFinishedGoodsShipmentButton } from './create-finished-goods-shipment-button';
import { FinishedGoodsBalancesPreview } from './finished-goods-balances-preview';
import { FinishedGoodsShipmentsTable } from './finished-goods-shipments-table';

interface Props {
  orderId: string;
  /** ADMIN / SHOP_MANAGER — определяет видимость кнопки «Создать отгрузку». */
  canManage: boolean;
}

export async function OrderFinishedGoodsShipmentSection({
  orderId,
  canManage,
}: Props) {
  let balances: FinishedGoodsBalanceListItem[] = [];
  let balancesError: string | null = null;
  let shipments: FinishedGoodsShipmentDetailDto[] = [];
  let shipmentsError: string | null = null;

  // Параллельный fetch — оба endpoint-а независимы. На balance мы
  // ставим positiveOnly=true: в форму отгрузки имеет смысл подавать
  // только реально доступные остатки (balance.qty > 0).
  try {
    const resp = await listFinishedGoodsBalances({
      orderId,
      positiveOnly: true,
      limit: 200,
    });
    balances = resp.items;
  } catch (e) {
    balancesError =
      e instanceof ApiRequestError
        ? `${e.message}${e.code ? ` (${e.code})` : ''}`
        : 'Не удалось загрузить остатки готовой продукции';
  }

  try {
    shipments = await listOrderFinishedGoodsShipments(orderId);
  } catch (e) {
    shipmentsError =
      e instanceof ApiRequestError
        ? `${e.message}${e.code ? ` (${e.code})` : ''}`
        : 'Не удалось загрузить отгрузки готовой продукции';
  }

  const hasBalances = balances.length > 0;

  return (
    <AdminCard>
      <AdminSectionHeader
        icon={<Truck size={18} strokeWidth={1.7} aria-hidden />}
        title="Отгрузка готовой продукции"
        hint={
          shipments.length > 0
            ? `Отгрузок: ${shipments.length}`
            : 'Документов отгрузки пока нет'
        }
        actions={
          canManage && hasBalances ? (
            <CreateFinishedGoodsShipmentButton
              orderId={orderId}
              balances={balances}
            />
          ) : null
        }
      />

      {balancesError && (
        <div className="error-box" role="alert" style={{ marginBottom: 12 }}>
          {balancesError}
        </div>
      )}
      {shipmentsError && (
        <div className="error-box" role="alert" style={{ marginBottom: 12 }}>
          {shipmentsError}
        </div>
      )}

      {hasBalances ? (
        <FinishedGoodsBalancesPreview balances={balances} />
      ) : (
        <AdminEmptyState
          icon={<Truck size={26} strokeWidth={1.6} aria-hidden />}
          title="По заказу пока нет готовой продукции"
          hint="Готовые изделия появятся, когда паспорта пройдут операцию выпуска или будут упакованы."
        />
      )}

      <FinishedGoodsShipmentsTable items={shipments} />
    </AdminCard>
  );
}
