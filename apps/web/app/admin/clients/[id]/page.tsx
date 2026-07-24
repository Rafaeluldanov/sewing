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
import { EditClientForm } from './edit-form';

export const dynamic = 'force-dynamic';

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('ru-RU');
}

/**
 * Карточка клиента (`/admin/clients/[id]`).
 *
 * Структура — стандартный admin detail-page:
 *   - `AdminPageShell` с названием карточки и статус-бейджем;
 *   - две колонки на desktop, одна на mobile (`.admin-grid-2`):
 *       Левая: «Основное» (имя + комментарий) + «Контакты»
 *              + «Заказы клиента» (последние 5) + форма редактирования
 *       Правая: «Техническая информация» (id/createdAt/updatedAt)
 *
 * «Заказы клиента»: тонкий preview из `GET /api/orders?clientId=…`
 * (см. `OrdersService.list`). Показываем только последние 5 — менеджеру
 * нужен быстрый «контекст», полный список заказов он уже видит на
 * `/admin/orders` с фильтром по клиенту. Бейдж «контроля срока» —
 * тот же, что и в основном списке (см. `@sewing/shared/order-deadlines`).
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
      <div className="admin-grid-2">
        <div className="admin-stack">
          <AdminCard>
            <AdminSectionHeader title="Основное" />
            <dl className="admin-deflist">
              <dt>Название</dt>
              <dd>{client.name}</dd>
              <dt>Статус</dt>
              <dd>
                <AdminStatusBadge tone={statusTone(client.isActive)}>
                  {formatStatus(client.isActive)}
                </AdminStatusBadge>
              </dd>
              <dt>Комментарий</dt>
              <dd>
                {client.comment ?? <span className="admin-muted">—</span>}
              </dd>
            </dl>
          </AdminCard>

          <AdminCard>
            <AdminSectionHeader title="Контакты" />
            <dl className="admin-deflist">
              <dt>Телефон</dt>
              <dd>{client.phone ?? <span className="admin-muted">—</span>}</dd>
              <dt>Email</dt>
              <dd>{client.email ?? <span className="admin-muted">—</span>}</dd>
            </dl>
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

          <AdminCard>
            <AdminSectionHeader title="Редактирование" />
            <EditClientForm client={client} />
          </AdminCard>
        </div>

        <div className="admin-stack">
          <AdminTechInfo
            items={[
              { label: 'ID', value: <code>{client.id}</code> },
              { label: 'Создан', value: formatDateTime(client.createdAt) },
              { label: 'Обновлён', value: formatDateTime(client.updatedAt) },
            ]}
          />
        </div>
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
