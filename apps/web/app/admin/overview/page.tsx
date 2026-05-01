import Link from 'next/link';
import { Activity, RefreshCw } from 'lucide-react';
import { ApiRequestError } from '@/lib/api';
import { getAdminOverview } from '@/lib/admin-api';
import type { AdminOverviewDto } from '@sewing/shared/admin';
import {
  AdminCard,
  AdminPageShell,
  AdminSectionHeader,
  AdminStatusBadge,
} from '@/components/admin';

export const dynamic = 'force-dynamic';

/**
 * Operational overview (Admin UI 2.5, ADR-0014).
 *
 * Backend / DTO не меняем. Read-only страница: счётчики + три
 * таблицы. Без поллинга, кнопка «Обновить» делает GET страницы.
 */
export default async function AdminOverviewPage() {
  let overview: AdminOverviewDto | null = null;
  let error: string | null = null;
  try {
    overview = await getAdminOverview();
  } catch (e) {
    error =
      e instanceof ApiRequestError
        ? `${e.message}${e.code ? ` (${e.code})` : ''}`
        : 'Не удалось загрузить операционный обзор';
  }

  if (!overview) {
    return (
      <AdminPageShell
        icon={<Activity size={22} strokeWidth={1.6} aria-hidden />}
        title="Операционный обзор"
        subtitle="Состояние производства сейчас"
      >
        {error && (
          <div className="error-box" role="alert">
            {error}
          </div>
        )}
      </AdminPageShell>
    );
  }

  const c = overview.counters;
  const updatedAtLabel = new Date(overview.updatedAt).toLocaleString('ru-RU');

  return (
    <AdminPageShell
      icon={<Activity size={22} strokeWidth={1.6} aria-hidden />}
      title="Операционный обзор"
      subtitle={`Обновлено ${updatedAtLabel}`}
      actions={
        <form action="">
          <button type="submit" className="admin-btn">
            <RefreshCw size={16} strokeWidth={1.6} aria-hidden />
            Обновить
          </button>
        </form>
      }
    >
      <section
        className="admin-overview__counters"
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
          gap: 'var(--admin-space-md)',
        }}
      >
        <Counter label="Активные смены" value={c.activeShifts} />
        <Counter label="Открытые коробки" value={c.openBoxes} />
        <Counter label="Паспорта в работе" value={c.passportsInProgress} />
        <Counter label="В ячейках" value={c.passportsInCells} />
        <Counter label="Создано сегодня" value={c.passportsCreatedToday} />
        <Counter label="Событий за 24ч" value={c.eventsLast24h} />
      </section>

      <AdminCard>
        <AdminSectionHeader
          title="Активные смены"
          hint={`${overview.shifts.length}`}
        />
        {overview.shifts.length === 0 ? (
          <p className="admin-muted" style={{ margin: 0 }}>
            Нет активных смен.
          </p>
        ) : (
          <table className="admin-table">
            <thead>
              <tr>
                <th>С</th>
                <th>Сотрудник</th>
                <th>Операция</th>
                <th>Оборудование</th>
              </tr>
            </thead>
            <tbody>
              {overview.shifts.map((s) => (
                <tr key={s.shiftId}>
                  <td>{new Date(s.startedAt).toLocaleTimeString('ru-RU')}</td>
                  <td>
                    {s.employeeName}
                    <span className="admin-muted" style={{ fontSize: '0.8rem' }}>
                      {' · '}
                      {s.employeeRole}
                    </span>
                  </td>
                  <td>{s.operationName}</td>
                  <td>{s.equipmentName}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </AdminCard>

      <AdminCard>
        <AdminSectionHeader
          title="Открытые коробки"
          hint={`${overview.openBoxes.length}`}
        />
        {overview.openBoxes.length === 0 ? (
          <p className="admin-muted" style={{ margin: 0 }}>
            Открытых коробок нет.
          </p>
        ) : (
          <table className="admin-table">
            <thead>
              <tr>
                <th>Коробка</th>
                <th>Заполнение</th>
                <th>Партия</th>
                <th>Создана</th>
              </tr>
            </thead>
            <tbody>
              {overview.openBoxes.map((b) => (
                <tr key={b.boxId}>
                  <td>
                    <Link href={`/packing/boxes/${b.boxId}`}>{b.number}</Link>
                  </td>
                  <td>
                    {b.totalQty} / {b.maxQty}
                    <span className="admin-muted" style={{ fontSize: '0.8rem' }}>
                      {' '}
                      ({b.itemsCount})
                    </span>
                  </td>
                  <td>
                    {b.productName ? (
                      <>
                        {b.productName} · {b.color} · {b.sizeCode}
                      </>
                    ) : (
                      <span className="admin-muted">—</span>
                    )}
                  </td>
                  <td>{new Date(b.createdAt).toLocaleString('ru-RU')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </AdminCard>

      <AdminCard>
        <AdminSectionHeader
          title="Паспорта в работе и в ячейках"
          hint={`${overview.passports.length}`}
        />
        {overview.passports.length === 0 ? (
          <p className="admin-muted" style={{ margin: 0 }}>
            Сейчас в цехе нет живых паспортов.
          </p>
        ) : (
          <table className="admin-table">
            <thead>
              <tr>
                <th>Паспорт</th>
                <th>Изделие</th>
                <th>Размер</th>
                <th>Кол-во</th>
                <th>Где</th>
                <th>Операция</th>
              </tr>
            </thead>
            <tbody>
              {overview.passports.map((p) => (
                <tr key={p.passportId}>
                  <td>
                    <Link href={`/passports/${p.passportId}`}>{p.number}</Link>{' '}
                    <AdminStatusBadge
                      tone={p.status === 'IN_PROGRESS' ? 'info' : 'muted'}
                    >
                      {p.status === 'IN_PROGRESS' ? 'В работе' : 'Создан'}
                    </AdminStatusBadge>
                  </td>
                  <td>
                    {p.productName} · {p.color}
                  </td>
                  <td>{p.sizeCode}</td>
                  <td>
                    {p.qtyCut}
                    {p.qtyGood !== p.qtyCut && (
                      <span className="admin-muted" style={{ fontSize: '0.8rem' }}>
                        {' '}
                        (годных {p.qtyGood})
                      </span>
                    )}
                  </td>
                  <td>
                    {p.location === 'EMPLOYEE' && p.currentEmployeeName}
                    {p.location === 'CELL' && <>ячейка {p.currentCellCode}</>}
                    {p.location === 'UNASSIGNED' && (
                      <span className="admin-muted">—</span>
                    )}
                  </td>
                  <td>
                    {p.currentOperationName ? (
                      <>{p.currentOperationName}</>
                    ) : (
                      <span className="admin-muted">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </AdminCard>
    </AdminPageShell>
  );
}

function Counter({ label, value }: { label: string; value: number }) {
  return (
    <div
      className="admin-card"
      style={{
        padding: 'var(--admin-space-md)',
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
      }}
    >
      <div style={{ fontSize: '1.5rem', fontWeight: 700 }}>{value}</div>
      <div className="admin-muted" style={{ fontSize: '0.85rem' }}>
        {label}
      </div>
    </div>
  );
}
