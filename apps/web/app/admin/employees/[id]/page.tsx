import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  ArrowLeft,
  ArrowRight,
  BadgeRussianRuble,
  Clock3,
  Printer,
  ScanLine,
  Users,
} from 'lucide-react';
import { ApiRequestError } from '@/lib/api';
import { getCurrentUserOrNull } from '@/lib/auth-api';
import { getEmployee, getEmployeeBlockers } from '@/lib/employees-api';
import { listCompanyDivisions } from '@/lib/company-settings-api';
import { listCashFlowItems } from '@/lib/treasury-api';
import { EmployeeDangerZone } from './danger-zone';
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

  // Blockers preflight для блока «Опасная зона». Если backend упал —
  // показываем «опасную зону» в безопасном дефолте (всё запрещено),
  // чтобы менеджер случайно не нажал «удалить» без preflight.
  const viewer = await getCurrentUserOrNull();
  const blockers = await getEmployeeBlockers(params.id).catch(() => ({
    archiveAllowed: false,
    hardDeleteAllowed: false,
    hasDisplayScreenConfig: false,
    archiveBlockers: [],
    hardDeleteBlockers: [],
  }));

  // PHASE 2 STEP 2: подгружаем активные подразделения для select-а
  // в форме. Если backend упал — рендерим без selectа (форма
  // продолжает работать с прежним набором полей).
  const divisions = await listCompanyDivisions({ includeInactive: false }).catch(
    () => [],
  );
  const divisionOptions = divisions.map((d) => ({
    id: d.id,
    code: d.code,
    name: d.name,
  }));

  // Активные статьи ДДС для select-а «Статья ДДС (выплаты)» в форме
  // «Доступ». Падение казначейства не должно ронять карточку сотрудника
  // — деградируем до пустого списка (select покажет только опцию
  // «— из настроек казначейства —» + текущую привязку, если она есть).
  const cashFlowItems = await listCashFlowItems({ activeOnly: true }).catch(
    () => [],
  );

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
              {/*
               * PHASE 2 STEP 5 — explicit «оси компенсации» в карточке.
               * Раньше эти поля были видны только в форме редактирования
               * (`EmployeeEditForm`), и менеджеру/админу приходилось
               * открывать форму, чтобы понять «есть ли у сотрудника
               * ставка за смену» или «какой у CUTTER B2B-процент». Теперь
               * — всегда в read-режиме, по описанному правилу: ставка
               * показывается только для SALARY/MIXED, B2B-процент —
               * только для CUTTER. Для остальных комбинаций строка не
               * рендерится, чтобы не плодить пустые «—» для read-only
               * пользователей (см. `docs/screens.md §«/admin/employees/[id]»`).
               */}
              {(employee.compensationType === 'SALARY' ||
                employee.compensationType === 'MIXED') && (
                <>
                  <dt>Ставка, ₽/час</dt>
                  <dd>
                    {employee.salaryPerHour !== null ? (
                      <>
                        {employee.salaryPerHour.toLocaleString('ru-RU', {
                          minimumFractionDigits: 2,
                          maximumFractionDigits: 2,
                        })}{' '}
                        ₽/час
                      </>
                    ) : (
                      <span className="admin-muted">
                        — не задана (требуется для оклада) —
                      </span>
                    )}
                  </dd>
                </>
              )}
              {employee.role === 'CUTTER' && (
                <>
                  <dt>Процент B2B (раскрой)</dt>
                  <dd>
                    {employee.cutterB2bSewingPercent !== null &&
                    employee.cutterB2bSewingPercent !== undefined ? (
                      <>
                        {employee.cutterB2bSewingPercent.toLocaleString(
                          'ru-RU',
                          {
                            minimumFractionDigits: 2,
                            maximumFractionDigits: 2,
                          },
                        )}{' '}
                        %
                      </>
                    ) : (
                      <span className="admin-muted">
                        — не задан, fallback из ENV
                        <code style={{ marginLeft: 4 }}>
                          CUTTER_B2B_SEWING_PERCENT
                        </code>{' '}
                        —
                      </span>
                    )}
                  </dd>
                </>
              )}
              <dt>Подразделение</dt>
              <dd>
                {employee.companyDivision ? (
                  <>
                    {employee.companyDivision.name}{' '}
                    <code style={{ fontSize: '0.85rem' }}>
                      {employee.companyDivision.code}
                    </code>
                  </>
                ) : (
                  <span className="admin-muted">— без привязки —</span>
                )}
              </dd>
              <dt>Статья ДДС (выплаты)</dt>
              <dd>
                {employee.salaryCashFlowItemId ? (
                  employee.salaryCashFlowItemName ?? (
                    <code style={{ fontSize: '0.85rem' }}>
                      {employee.salaryCashFlowItemId}
                    </code>
                  )
                ) : (
                  <span className="admin-muted">
                    — из настроек казначейства —
                  </span>
                )}
              </dd>
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
            <EmployeeEditForm
              employee={employee}
              divisionOptions={divisionOptions}
              cashFlowItems={cashFlowItems}
            />
          </AdminCard>

          <AdminCard>
            <AdminSectionHeader title="Тайм-трекер" />
            <p className="admin-muted" style={{ marginTop: 0 }}>
              Рабочий день во времени: начало сеанса, какие операции
              выполнялись внутри смены и её завершение. Сводка за неделю/месяц
              (часы, выработка, брак) и таймлайн каждого сеанса. Read-only.
            </p>
            <Link
              href={`/admin/employees/${employee.id}/time-tracker`}
              className="admin-btn admin-btn--primary"
            >
              <Clock3 size={16} strokeWidth={1.6} aria-hidden />
              Открыть тайм-трекер
              <ArrowRight size={14} strokeWidth={1.6} aria-hidden />
            </Link>
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
            ]}
          />

          <EmployeeDangerZone
            employee={employee}
            blockers={blockers}
            viewerRole={viewer?.user.role ?? ''}
            isSelf={viewer?.user.id === employee.id}
          />
        </div>
      </div>
    </AdminPageShell>
  );
}
