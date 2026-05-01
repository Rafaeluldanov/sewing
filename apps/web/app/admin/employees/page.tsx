import Link from 'next/link';
import { ApiRequestError } from '@/lib/api';
import { COMPENSATION_LABELS, listEmployees } from '@/lib/employees-api';
import type { EmployeeListItemDto } from '@sewing/shared/employees';
import { Icon } from '@/components/icon';

export const dynamic = 'force-dynamic';

const ROLE_LABELS: Record<string, string> = {
  ADMIN: 'Администратор',
  SHOP_MANAGER: 'Начальник цеха',
  CUTTER: 'Раскройщик',
  CUTTER_ASSISTANT: 'Помощник раскройщика',
  SEAMSTRESS: 'Швея',
  QC: 'ОТК',
  IRONING: 'ВТО',
  PACKING: 'Упаковка',
};

function formatMoney(value: number | null): React.ReactNode {
  if (value === null || value === 0) {
    return <span className="meta-line">—</span>;
  }
  return (
    <strong>
      {value.toLocaleString('ru-RU', {
        minimumFractionDigits: 0,
        maximumFractionDigits: 2,
      })}{' '}
      ₽
    </strong>
  );
}

/**
 * Список сотрудников (см. `docs/screens.md §11`).
 *
 * Источник истины — `GET /api/employees` (роли `ADMIN`/`SHOP_MANAGER`).
 * Доступ к разделу режется выше — `app/admin/layout.tsx` редиректит
 * всех, кроме `ADMIN`/`SHOP_MANAGER`. Backend дополнительно
 * защищает `/api/employees/*` через `@Roles('SHOP_MANAGER', 'ADMIN')`.
 *
 * На MVP экран read-only по структуре (создание/удаление out-of-scope —
 * см. ADR-0021): открываем карточку для правки management-полей.
 */
export default async function AdminEmployeesListPage() {
  let items: EmployeeListItemDto[] = [];
  let error: string | null = null;
  try {
    items = await listEmployees();
  } catch (e) {
    error =
      e instanceof ApiRequestError
        ? `${e.message}${e.code ? ` (${e.code})` : ''}`
        : 'Не удалось загрузить список сотрудников';
  }

  const active = items.filter((e) => e.active);
  const archived = items.filter((e) => !e.active);

  return (
    <div className="admin-overview page-shell">
      <header className="admin-overview__header">
        <div>
          <div className="page-eyebrow">
            <Icon name="employees" />
            Справочник
          </div>
          <h1 className="page-title">
            <Icon name="employees" />
            Сотрудники
          </h1>
          <p className="page-subtitle">
            Управленческий справочник: тип компенсации (сдельная / оклад /
            смешанная) и ставка за смену. Окладные начисления автоматически
            создаются для сотрудников SALARY/MIXED при старте смены —
            см. /earnings и ADR-0021.
          </p>
        </div>
      </header>

      {error && <div className="error-box">{error}</div>}

      <section>
        <div className="section-header">
          <h2>
            <Icon name="success" />
            Активные ({active.length})
          </h2>
        </div>
        <EmployeesTable items={active} />
      </section>

      {archived.length > 0 && (
        <section>
          <div className="section-header">
            <h2>
              <Icon name="idle" />
              Архив ({archived.length})
            </h2>
          </div>
          <EmployeesTable items={archived} muted />
        </section>
      )}
    </div>
  );
}

function EmployeesTable({
  items,
  muted = false,
}: {
  items: EmployeeListItemDto[];
  muted?: boolean;
}) {
  if (items.length === 0) {
    return (
      <div className="empty-state">
        <span className="empty-state__icon">
          <Icon name="employees" />
        </span>
        <span className="empty-state__title">Пусто</span>
      </div>
    );
  }
  return (
    <table className="data-table" style={muted ? { opacity: 0.7 } : undefined}>
      <thead>
        <tr>
          <th>ФИО</th>
          <th>Логин</th>
          <th>Роль</th>
          <th>Тип оплаты</th>
          <th style={{ textAlign: 'right' }}>Ставка за смену</th>
          <th>Активен</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        {items.map((e) => (
          <tr key={e.id}>
            <td>
              <strong>{e.fullName}</strong>
            </td>
            <td>
              <code>{e.login}</code>
            </td>
            <td>{ROLE_LABELS[e.role] ?? e.role}</td>
            <td>{COMPENSATION_LABELS[e.compensationType]}</td>
            <td style={{ textAlign: 'right' }}>{formatMoney(e.salaryPerShift)}</td>
            <td>{e.active ? 'да' : <span className="meta-line">нет</span>}</td>
            <td>
              <Link href={`/admin/employees/${e.id}`}>
                Открыть <Icon name="arrow-right" size={13} />
              </Link>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
