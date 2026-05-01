import Link from 'next/link';
import { MonitorSmartphone, Plus } from 'lucide-react';
import { ApiRequestError } from '@/lib/api';
import { listDisplayScreens } from '@/lib/display-screens-api';
import {
  ORDER_DIVISION_LABELS,
  type OrderDivision,
} from '@sewing/shared/orders';
import type { DisplayScreenListItemDto } from '@sewing/shared/display-screens';
import {
  AdminCard,
  AdminEmptyState,
  AdminPageShell,
  AdminSectionHeader,
  AdminStatusBadge,
  AdminTable,
  type AdminTableColumn,
} from '@/components/admin';

export const dynamic = 'force-dynamic';

/**
 * Список display-экранов (Admin UI 2.5).
 *
 * Backend / DTO не меняем. Каждый экран — это пара
 * «DISPLAY-учётка + подразделение». Создание/редактирование пары —
 * отдельные страницы.
 */
export default async function AdminDisplayScreensListPage() {
  let items: DisplayScreenListItemDto[] = [];
  let error: string | null = null;
  try {
    items = await listDisplayScreens();
  } catch (e) {
    error =
      e instanceof ApiRequestError
        ? `${e.message}${e.code ? ` (${e.code})` : ''}`
        : 'Не удалось загрузить список display-экранов';
  }

  const active = items.filter((s) => s.isActive);
  const archived = items.filter((s) => !s.isActive);

  return (
    <AdminPageShell
      icon={<MonitorSmartphone size={22} strokeWidth={1.6} aria-hidden />}
      title="Display-экраны"
      subtitle={`Активных: ${active.length} · Отключённых: ${archived.length}`}
      actions={
        <Link
          href="/admin/display-screens/new"
          className="admin-btn admin-btn--primary"
        >
          <Plus size={16} strokeWidth={1.6} aria-hidden />
          Создать экран
        </Link>
      }
    >
      {error && (
        <div className="error-box" role="alert">
          {error}
        </div>
      )}

      <AdminCard>
        <AdminSectionHeader title="Активные" hint={`${active.length}`} />
        <DisplayScreensTable items={active} />
      </AdminCard>

      {archived.length > 0 && (
        <AdminCard>
          <AdminSectionHeader title="Отключённые" hint={`${archived.length}`} />
          <DisplayScreensTable items={archived} muted />
        </AdminCard>
      )}
    </AdminPageShell>
  );
}

function DisplayScreensTable({
  items,
  muted = false,
}: {
  items: DisplayScreenListItemDto[];
  muted?: boolean;
}) {
  const columns: AdminTableColumn<DisplayScreenListItemDto>[] = [
    {
      key: 'name',
      header: 'Название',
      render: (s) => <span className="admin-table__primary">{s.name}</span>,
    },
    {
      key: 'division',
      header: 'Подразделение',
      // PHASE 1 «CompanyDivision как master-справочник» (см.
      // `docs/domain.md §«Подразделения заказа»»): UI предпочитает
      // live-имя `companyDivision.name`, fallback на legacy
      // `ORDER_DIVISION_LABELS[s.division]` оставляем для исторических
      // конфигов до миграции (PHASE 2 уберёт fallback).
      render: (s) =>
        s.companyDivision?.name ??
        ORDER_DIVISION_LABELS[s.division as OrderDivision],
    },
    {
      key: 'login',
      header: 'Логин',
      render: (s) => (
        <code style={{ fontSize: '0.85rem' }}>{s.employeeLogin}</code>
      ),
    },
    {
      key: 'status',
      header: 'Статус',
      render: (s) => (
        <AdminStatusBadge tone={s.isActive ? 'success' : 'muted'}>
          {s.isActive ? 'активен' : 'отключён'}
        </AdminStatusBadge>
      ),
    },
  ];
  return (
    <div style={muted ? { opacity: 0.7 } : undefined}>
      <AdminTable
        rows={items}
        columns={columns}
        rowKey={(s) => s.id}
        emptyContent={
          <AdminEmptyState
            icon={
              <MonitorSmartphone size={26} strokeWidth={1.6} aria-hidden />
            }
            title="Пусто"
          />
        }
      />
    </div>
  );
}
