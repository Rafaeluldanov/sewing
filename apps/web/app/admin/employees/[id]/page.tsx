import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  ArrowLeft,
  ArrowRight,
  BadgeRussianRuble,
  Printer,
  ScanLine,
  Users,
} from 'lucide-react';
import { ApiRequestError } from '@/lib/api';
import { getEmployee } from '@/lib/employees-api';
import {
  AdminCard,
  AdminPageShell,
  AdminSectionHeader,
  AdminStatusBadge,
  AdminTechInfo,
} from '@/components/admin';
import {
  buildEmployeePrintPath,
  buildEmployeeQrPath,
} from '@/lib/browser-api-paths';
import {
  formatCompensation,
  formatRole,
  formatStatus,
  statusTone,
} from '@/lib/admin-labels';
import { EmployeeEditForm } from './edit-form';

export const dynamic = 'force-dynamic';

function formatDateOnly(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('ru-RU');
}

/**
 * Карточка сотрудника (Admin UI 2.5).
 *
 * Структура — единый стандарт detail-pages:
 *   - `AdminPageShell` с именем, ролью/active-бейджами и primary-action
 *     «Печать QR»;
 *   - две колонки на desktop, одна на mobile (`.admin-grid-2`):
 *       Левая: «Основная информация» + «Доступ»
 *       Правая: «QR сотрудника» + «Техническая информация»
 *   - длинных описаний и тех. кодов в основном UI больше нет;
 *     id/login/createdAt спрятаны в collapsible `<AdminTechInfo>`.
 *
 * Backend / DTO не меняем — `EmployeeEditForm` остаётся прежним и
 * по-прежнему правит compensationType/salaryPerShift/active. PIN и
 * login у Шага 19 остаются read-only management-полями (см. ADR-0021).
 */
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

  const qrUrl = buildEmployeeQrPath(employee.id);
  const printUrl = buildEmployeePrintPath(employee.id);

  return (
    <AdminPageShell
      icon={<Users size={22} strokeWidth={1.6} aria-hidden />}
      title={employee.fullName}
      subtitle={formatRole(employee.role)}
      actions={
        <>
          <Link
            href="/admin/employees"
            className="admin-btn admin-btn--ghost"
          >
            <ArrowLeft size={16} strokeWidth={1.6} aria-hidden />
            К списку
          </Link>
          <AdminStatusBadge tone={statusTone(employee.active)}>
            {formatStatus(employee.active)}
          </AdminStatusBadge>
          <a
            href={printUrl}
            className="admin-btn admin-btn--primary"
            target="_blank"
            rel="noopener noreferrer"
          >
            <Printer size={16} strokeWidth={1.6} aria-hidden />
            Печать QR
          </a>
        </>
      }
    >
      <div className="admin-grid-2">
        <div className="admin-stack">
          <AdminCard>
            <AdminSectionHeader title="Основная информация" />
            <dl className="admin-deflist">
              <dt>ФИО</dt>
              <dd>{employee.fullName}</dd>
              <dt>Роль</dt>
              <dd>{formatRole(employee.role)}</dd>
              <dt>Тип оплаты</dt>
              <dd>{formatCompensation(employee.compensationType)}</dd>
              <dt>В системе с</dt>
              <dd>{formatDateOnly(employee.createdAt)}</dd>
            </dl>
          </AdminCard>

          <AdminCard>
            <AdminSectionHeader title="Доступ" />
            <dl className="admin-deflist">
              <dt>PIN</dt>
              <dd className="admin-muted">скрыт</dd>
              <dt>Логин</dt>
              <dd>
                <code style={{ fontSize: '0.85rem' }}>{employee.login}</code>
              </dd>
            </dl>
            <EmployeeEditForm employee={employee} />
          </AdminCard>

          <AdminCard>
            <AdminSectionHeader title="Зарплата за период" />
            <p className="admin-muted" style={{ marginTop: 0 }}>
              Карточка сотрудника в управленческом payroll-отчёте
              (PHASE 1, read-only). Показывает смены, сдельные и
              окладные начисления за выбранный период; редактирование
              окладной части по-прежнему живёт в{' '}
              <Link href="/earnings">/earnings</Link>.
            </p>
            <Link
              href={`/admin/payroll/employees/${employee.id}`}
              className="admin-btn admin-btn--primary"
            >
              <BadgeRussianRuble size={16} strokeWidth={1.6} aria-hidden />
              Открыть в «Зарплате»
              <ArrowRight size={14} strokeWidth={1.6} aria-hidden />
            </Link>
          </AdminCard>
        </div>

        <div className="admin-stack">
          <AdminCard>
            <AdminSectionHeader title="QR сотрудника" />
            <div className="admin-qr-card__body">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={qrUrl}
                alt={`QR сотрудника ${employee.fullName}`}
                width={160}
                height={160}
                className="admin-qr-card__image"
              />
              <div className="admin-qr-card__actions">
                <a
                  href={qrUrl}
                  className="admin-btn"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <ScanLine size={16} strokeWidth={1.6} aria-hidden />
                  Открыть QR
                </a>
                <a
                  href={printUrl}
                  className="admin-btn admin-btn--primary"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <Printer size={16} strokeWidth={1.6} aria-hidden />
                  Печать
                </a>
              </div>
            </div>
          </AdminCard>

          <AdminTechInfo
            items={[
              { label: 'ID', value: <code>{employee.id}</code> },
              { label: 'Логин', value: <code>{employee.login}</code> },
              { label: 'Роль (enum)', value: <code>{employee.role}</code> },
              {
                label: 'Тип оплаты (enum)',
                value: <code>{employee.compensationType}</code>,
              },
              {
                label: 'Создан',
                value: new Date(employee.createdAt).toLocaleString('ru-RU'),
              },
              ...(employee.salaryBase !== null
                ? [
                    {
                      label: 'salaryBase (legacy)',
                      value: `${employee.salaryBase} ₽/мес`,
                    },
                  ]
                : []),
            ]}
          />
        </div>
      </div>
    </AdminPageShell>
  );
}
