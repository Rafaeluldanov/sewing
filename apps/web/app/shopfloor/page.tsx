import { ApiRequestError } from '@/lib/api';
import {
  getShopfloorState,
  listShopfloorOrders,
} from '@/lib/shopfloor-api';
import { ShopfloorBoard } from './shopfloor-board';

export const dynamic = 'force-dynamic';

interface PageProps {
  searchParams?: { orderId?: string };
}

/**
 * Экран «Цех» (Шаг 10 MVP). См. `docs/screens.md §9`.
 *
 * RSC делает initial fetch состояния и список активных заказов, чтобы
 * первая отрисовка не показывала спиннер. Дальше клиент-компонент
 * (`ShopfloorBoard`) поллит `/api/shopfloor/state` каждые 3 секунды и
 * подсвечивает изменившиеся ячейки (см. F11 / ADR-0007).
 */
export default async function ShopfloorPage({ searchParams }: PageProps) {
  const orderId = searchParams?.orderId?.trim() || undefined;

  let initialState;
  let initialError: string | null = null;
  try {
    initialState = await getShopfloorState(orderId);
  } catch (e) {
    initialError =
      e instanceof ApiRequestError
        ? `${e.message}${e.code ? ` (${e.code})` : ''}`
        : 'Не удалось загрузить состояние цеха';
    initialState = {
      updatedAt: new Date().toISOString(),
      scope: 'ALL_ACTIVE' as const,
      orderId: null,
      scopeLabel: '—',
      summary: {
        qtyCut: 0,
        qtySewing: 0,
        qtyQc: 0,
        qtyQcDone: 0,
        qtyWto: 0,
        qtyWtoDone: 0,
        qtyPacking: 0,
        qtyFinished: 0,
        qtyDefect: 0,
      },
      rows: [],
    };
  }

  let orders: Awaited<ReturnType<typeof listShopfloorOrders>> = [];
  try {
    orders = await listShopfloorOrders();
  } catch {
    orders = [];
  }

  return (
    <div className="shopfloor">
      {initialError && <div className="error-box">{initialError}</div>}
      <ShopfloorBoard
        initialState={initialState}
        initialOrderId={orderId ?? null}
        orders={orders}
      />
    </div>
  );
}
