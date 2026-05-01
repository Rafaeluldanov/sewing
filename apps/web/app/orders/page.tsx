import Link from 'next/link';
import {
  ORDER_STATUSES,
  type OrderStatus,
  type ListOrdersQuery,
  type OrderSort,
  ORDER_SORTS,
} from '@sewing/shared/orders';
import { ApiRequestError } from '@/lib/api';
import { listOrders, ORDER_STATUS_LABELS } from '@/lib/orders-api';
import { getCurrentUserOrNull } from '@/lib/auth-api';
import { StatusBadge } from '@/components/status-badge';

export const dynamic = 'force-dynamic';

interface PageProps {
  searchParams?: {
    search?: string;
    status?: string;
    sort?: string;
    page?: string;
  };
}

const SORT_LABELS: Record<OrderSort, string> = {
  createdAt_desc: 'Создан — новые сверху',
  createdAt_asc: 'Создан — старые сверху',
  orderDate_desc: 'Дата заказа — новые сверху',
  orderDate_asc: 'Дата заказа — старые сверху',
};

function parseStatus(s: string | undefined): OrderStatus | undefined {
  if (!s) return undefined;
  return (ORDER_STATUSES as readonly string[]).includes(s)
    ? (s as OrderStatus)
    : undefined;
}

function parseSort(s: string | undefined): OrderSort {
  if (!s) return 'createdAt_desc';
  return (ORDER_SORTS as readonly string[]).includes(s)
    ? (s as OrderSort)
    : 'createdAt_desc';
}

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('ru-RU');
}

export default async function OrdersListPage({ searchParams }: PageProps) {
  const me = await getCurrentUserOrNull();
  const role = me?.user.role;
  const isManager = role === 'ADMIN' || role === 'SHOP_MANAGER';

  const query: ListOrdersQuery = {
    search: searchParams?.search?.trim() || undefined,
    status: parseStatus(searchParams?.status),
    sort: parseSort(searchParams?.sort),
    page: Math.max(1, Number(searchParams?.page ?? 1) || 1),
    pageSize: 50,
  };

  let data;
  let error: string | null = null;
  try {
    data = await listOrders(query);
  } catch (e) {
    error =
      e instanceof ApiRequestError
        ? `${e.message}${e.code ? ` (${e.code})` : ''}`
        : 'Не удалось загрузить заказы';
    data = { items: [], total: 0, page: 1, pageSize: query.pageSize };
  }

  return (
    <div>
      <div className="page-header">
        <h1>Заказы</h1>
        {isManager && (
          <Link className="btn btn-primary" href="/orders/new">
            + Создать заказ
          </Link>
        )}
      </div>

      {error && <div className="error-box">{error}</div>}

      <form className="toolbar" method="get">
        <input
          type="text"
          name="search"
          placeholder="Номер заказа…"
          defaultValue={query.search ?? ''}
        />
        <select name="status" defaultValue={query.status ?? ''}>
          <option value="">Все статусы</option>
          {ORDER_STATUSES.map((s) => (
            <option key={s} value={s}>
              {ORDER_STATUS_LABELS[s]}
            </option>
          ))}
        </select>
        <select name="sort" defaultValue={query.sort}>
          {ORDER_SORTS.map((s) => (
            <option key={s} value={s}>
              {SORT_LABELS[s]}
            </option>
          ))}
        </select>
        <button type="submit" className="btn">
          Применить
        </button>
        <Link className="btn btn-ghost" href="/orders">
          Сбросить
        </Link>
      </form>

      {data.items.length === 0 ? (
        <div className="card empty">Заказов пока нет.</div>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>Номер</th>
              <th>Дата</th>
              <th>Изделие</th>
              <th>Цвет</th>
              <th className="num">План, шт</th>
              <th>Статус</th>
              <th>Комментарий</th>
              <th>Создан</th>
            </tr>
          </thead>
          <tbody>
            {data.items.map((o) => (
              <tr key={o.id}>
                <td>
                  <Link href={`/orders/${o.id}`}>{o.number}</Link>
                </td>
                <td>{formatDate(o.orderDate)}</td>
                <td>{o.productName ?? '—'}</td>
                <td>{o.color ?? '—'}</td>
                <td className="num">{o.qtyPlanTotal}</td>
                <td>
                  <StatusBadge status={o.status} />
                </td>
                <td
                  title={o.comment ?? ''}
                  style={{
                    maxWidth: 240,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {o.comment ?? '—'}
                </td>
                <td>{formatDate(o.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <p className="meta-line" style={{ marginTop: '0.75rem' }}>
        Всего: <strong>{data.total}</strong>
      </p>
    </div>
  );
}
