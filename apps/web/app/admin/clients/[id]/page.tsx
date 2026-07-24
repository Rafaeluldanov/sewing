import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, ArrowRight, Building2, Package } from 'lucide-react';
import type { OrderListItemDto } from '@sewing/shared/orders';
import { ApiRequestError } from '@/lib/api';
import { getClient } from '@/lib/clients-api';
import { listOrders, ORDER_STATUS_LABELS } from '@/lib/orders-api';
import {
  AdminCard,
  AdminEmptyState,
  AdminPageShell,
  AdminSectionHeader,
  AdminStatusBadge,
  AdminTable,
  AdminTechInfo,
  type AdminTableColumn,
} from '@/components/admin';
import type { AdminStatusTone } from '@/lib/admin-labels';
import { formatStatus, statusTone } from '@/lib/admin-labels';
import { formatDateRu } from '@/lib/date-format';
import { ClientMainFields } from './client-main-fields';

export const dynamic = 'force-dynamic';

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('ru-RU');
}

/**
 * Карточка клиента (`/admin/clients/[id]`).
 *
 * Упрощённая структура — ровно ДВА блока (стек в одну колонку):
 *   1. «Основное» — имя, статус (переключатель активности), телефон,
 *      email, комментарий. Контакты слиты сюда же; каждое поле правится
 *      на месте по «карандашику» (см. `./client-main-fields`). Тех-инфа
 *      (id/createdAt/updatedAt) свёрнута в disclosure внутри блока.
 *   2. «Заказы клиента» — тонкий preview последних 5 заказов из
 *      `GET /api/orders?clientId=…` (см. `OrdersService.list`); полный
 *      список — на `/admin/orders` с фильтром по клиенту. Бейдж
 *      «контроля срока» — тот же, что и в основном списке (см.
 *      `@sewing/shared/order-deadlines`).
 *
 * Отдельной формы «Редактирование» и карточки «Контакты» больше нет —
 * их роль взяло inline-редактирование блока «Основное».
 */
export default async function AdminClientDetailPage({
  params,
}: {
  params: { id: string };
}) {
  let client;
  try {
    client = await getClient(params.id);
  } catch (e) {
    if (e instanceof ApiRequestError && e.statusCode === 404) {
      notFound();
    }
    throw e;
  }

  // Подгружаем последние заказы клиента отдельно: ошибка здесь не
  // должна валить карточку клиента, поэтому ловим исключение на месте
  // и показываем пустой блок (тот же UX, что у KPI на /admin).
  let recentOrders: OrderListItemDto[] = [];
  try {
    const data = await listOrders({
      clientId: client.id,
      pageSize: 5,
      page: 1,
      sort: 'createdAt_desc',
    });
    recentOrders = data.items;
  } catch {
    recentOrders = [];
  }

  return (
    <AdminPageShell
      icon={<Building2 size={22} strokeWidth={1.6} aria-hidden />}
      title={client.name}
      subtitle="Управленческая карточка клиента"
      actions={
        <>
          <Link href="/admin/clients" className="admin-btn admin-btn--ghost">
            <ArrowLeft size={16} strokeWidth={1.6} aria-hidden />
            К списку
          </Link>
          <AdminStatusBadge tone={statusTone(client.isActive)}>
            {formatStatus(client.isActive)}
          </AdminStatusBadge>
        </>
      }
    >
      <div className="admin-stack">
        <AdminCard>
          <AdminSectionHeader title="Основное" />
          <ClientMainFields client={client} />
          <AdminTechInfo
            items={[
              { label: 'ID', value: <code>{client.id}</code> },
              { label: 'Создан', value: formatDateTime(client.createdAt) },
              { label: 'Обновлён', value: formatDateTime(client.updatedAt) },
            ]}
          />
        </AdminCard>

        <AdminCard>
          <AdminSectionHeader
            title="Заказы клиента"
            hint={
              recentOrders.length > 0
                ? `последние ${recentOrders.length}`
                : undefined
            }
            actions={
              <Link
                href={`/admin/orders?clientId=${encodeURIComponent(client.id)}`}
                className="admin-table__action-link"
              >
                Все заказы
                <ArrowRight size={14} strokeWidth={1.6} aria-hidden />
              </Link>
            }
          />
          {recentOrders.length === 0 ? (
            <AdminEmptyState
              icon={<Package size={26} strokeWidth={1.6} aria-hidden />}
              title="Заказов у клиента нет"
              hint="Они появятся, когда менеджер заведёт заказ на этого клиента."
            />
          ) : (
            <ClientOrdersTable rows={recentOrders} />
          )}
        </AdminCard>
      </div>
    </AdminPageShell>
  );
}

/**
 * Компактный preview-список последних заказов клиента. Полный список
 * со всеми фильтрами живёт на `/admin/orders?clientId=…` (см. ссылку
 * «Все заказы» в шапке блока).
 */
function ClientOrdersTable({ rows }: { rows: OrderListItemDto[] }) {
  const columns: AdminTableColumn<OrderListItemDto>[] = [
    {
      key: 'number',
      header: 'Номер',
      render: (o) => (
        <Link
          href={`/admin/orders/${o.id}`}
          className="admin-table__action-link"
        >
          <strong>{o.number}</strong>
        </Link>
      ),
    },
    {
      key: 'date',
      header: 'Дата',
      render: (o) => formatDateRu(o.orderDate),
    },
    {
      key: 'status',
      header: 'Статус',
      render: (o) => (
        <AdminStatusBadge tone={statusTone(o.status)}>
          {ORDER_STATUS_LABELS[o.status]}
        </AdminStatusBadge>
      ),
    },
    {
      key: 'deadline',
      header: 'Срок',
      render: (o) => {
        const d = o.deadline;
        if (!d) return <span className="admin-muted">—</span>;
        const tone = (d.tone as AdminStatusTone) ?? 'muted';
        return (
          <div className="admin-deadline-cell">
            <div className="admin-deadline-cell__row">
              <span className="admin-deadline-cell__date">
                {formatDateRu(o.dueDate)}
              </span>
              <AdminStatusBadge tone={tone}>{d.label}</AdminStatusBadge>
            </div>
          </div>
        );
      },
    },
  ];
  return (
    <AdminTable
      rows={rows}
      columns={columns}
      rowKey={(o) => o.id}
      rowHref={(o) => `/admin/orders/${o.id}`}
    />
  );
}
