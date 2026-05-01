import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ApiRequestError } from '@/lib/api';
import { COMPENSATION_LABELS, getEmployee } from '@/lib/employees-api';
import { listSalary } from '@/lib/salary-api';
import { Icon } from '@/components/icon';
import { DetailPageHeader } from '@/components/detail-page-header';
import { EmployeeEditForm } from './edit-form';

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

function formatDateOnly(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('ru-RU');
}

function formatMoney(value: number): string {
  return value.toLocaleString('ru-RU', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export default async function AdminEmployeeDetailPage({
  params,
}: {
  params: { id: string };
}) {
  let employee;
  try {
    employee = await getEmployee(params.id);
  } catch (e) {
    if (e instanceof ApiRequestError && e.statusCode === 404) {
      notFound();
    }
    throw e;
  }

  // Подтягиваем последние 14 окладных начислений для сводки на карточке.
  // Не критично если упадёт (например, если БД ещё не мигрирована
  // полностью) — fail-soft, основная форма всё равно отрисуется.
  let recentSalary;
  try {
    recentSalary = await listSalary({
      employeeId: employee.id,
      page: 1,
      pageSize: 14,
    });
  } catch {
    recentSalary = null;
  }

  const roleLabel = ROLE_LABELS[employee.role] ?? employee.role;

  return (
    <div className="page-shell">
      <DetailPageHeader
        eyebrow="Сотрудник"
        icon="employees"
        title={employee.fullName}
        subtitle="Управленческая карточка: тип компенсации, ставка за смену и архив. Поля login / role меняются через seed (см. ADR-0021)."
        backHref="/admin/employees"
        backLabel="К списку сотрудников"
        meta={
          <>
            <span>
              Логин: <code>{employee.login}</code>
            </span>
            <span>·</span>
            <span>{roleLabel}</span>
            <span>·</span>
            <span>В системе с {formatDateOnly(employee.createdAt)}</span>
          </>
        }
        badges={
          <>
            <span className={`pill ${employee.active ? 'pill--ok' : 'pill--ghost'}`}>
              <Icon name={employee.active ? 'success' : 'idle'} size={14} />
              {employee.active ? 'Активен' : 'В архиве'}
            </span>
            <span className="pill pill--accent">
              <Icon name="earnings" size={14} />
              {COMPENSATION_LABELS[employee.compensationType]}
            </span>
          </>
        }
      />

      <section className="card">
        <div className="section-header">
          <h2>
            <Icon name="info" />
            Основное
          </h2>
        </div>
        <div className="data-list">
          <div className="data-list__item">
            <span className="data-list__label">ФИО</span>
            <span className="data-list__value">{employee.fullName}</span>
          </div>
          <div className="data-list__item">
            <span className="data-list__label">Логин</span>
            <span className="data-list__value">
              <code>{employee.login}</code>
            </span>
          </div>
          <div className="data-list__item">
            <span className="data-list__label">Роль</span>
            <span className="data-list__value">{roleLabel}</span>
          </div>
          <div className="data-list__item">
            <span className="data-list__label">В системе с</span>
            <span className="data-list__value">
              {formatDateOnly(employee.createdAt)}
            </span>
          </div>
        </div>
      </section>

      <section className="card">
        <div className="section-header">
          <h2>
            <Icon name="earnings" />
            Оплата
          </h2>
          <span className="section-header__hint">
            Источник истины — этот блок (см. /earnings и ADR-0021).
          </span>
        </div>
        <div className="data-list" style={{ marginBottom: '1rem' }}>
          <div className="data-list__item">
            <span className="data-list__label">Тип компенсации</span>
            <span className="data-list__value">
              {COMPENSATION_LABELS[employee.compensationType]}
            </span>
          </div>
          <div className="data-list__item">
            <span className="data-list__label">Ставка за смену</span>
            <span className="data-list__value">
              {employee.salaryPerShift !== null ? (
                <>{formatMoney(employee.salaryPerShift)} ₽</>
              ) : (
                <span className="data-list__value--muted">—</span>
              )}
            </span>
          </div>
          <div className="data-list__item">
            <span className="data-list__label">Тип оплаты (legacy)</span>
            <span className="data-list__value">
              {employee.paymentType === 'SALARY' ? 'Оклад' : 'Сдельная'}
              {employee.salaryBase !== null && (
                <span className="data-list__value--muted">
                  {' '}· {formatMoney(employee.salaryBase)} ₽/мес
                </span>
              )}
            </span>
          </div>
          <div className="data-list__item">
            <span className="data-list__label">Статус</span>
            <span className="data-list__value">
              {employee.active ? (
                <span className="pill pill--ok">
                  <Icon name="success" size={14} /> Активен
                </span>
              ) : (
                <span className="pill pill--ghost">
                  <Icon name="idle" size={14} /> В архиве
                </span>
              )}
            </span>
          </div>
        </div>
        <EmployeeEditForm employee={employee} />
      </section>

      <section className="card">
        <div className="section-header">
          <h2>
            <Icon name="output" />
            Последние начисления
          </h2>
          <Link href="/earnings" className="section-header__hint">
            Открыть «Зарплата» →
          </Link>
        </div>
        {recentSalary && recentSalary.items.length > 0 ? (
          <div className="inline-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Дата</th>
                  <th className="num">Сумма, ₽</th>
                  <th>Источник</th>
                  <th>Комментарий</th>
                </tr>
              </thead>
              <tbody>
                {recentSalary.items.map((s) => (
                  <tr key={s.id}>
                    <td>{formatDateOnly(s.date)}</td>
                    <td className="num">
                      <strong>{formatMoney(s.amount)}</strong>
                      {s.editedManually && (
                        <div className="data-list__value--muted" style={{ fontSize: '0.78rem' }}>
                          исправлено вручную
                        </div>
                      )}
                    </td>
                    <td>
                      {s.source === 'SHIFT_DAY' ? (
                        <span className="pill">
                          <Icon name="period" size={13} /> смена
                        </span>
                      ) : (
                        <span className="pill pill--accent">
                          <Icon name="edit" size={13} /> вручную
                        </span>
                      )}
                    </td>
                    <td>
                      {s.managerComment ? (
                        <span>{s.managerComment}</span>
                      ) : (
                        <span className="data-list__value--muted">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty-state">
            <span className="empty-state__icon">
              <Icon name="earnings" />
            </span>
            <span className="empty-state__title">Окладных начислений пока нет</span>
            <span className="empty-state__hint">
              Они появятся автоматически при старте смены (для SALARY/MIXED).
              Вручную — через `/earnings`.
            </span>
          </div>
        )}
      </section>
    </div>
  );
}
