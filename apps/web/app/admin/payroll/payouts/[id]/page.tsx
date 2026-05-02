import { notFound } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, BadgeRussianRuble } from 'lucide-react';
import type { PayrollPayoutLineDto } from '@sewing/shared/payroll-payouts';
import { ApiRequestError } from '@/lib/api';
import { getPayrollPayout } from '@/lib/payroll-payouts-api';
import {
  AdminCard,
  AdminEmptyState,
  AdminPageShell,
  AdminSectionHeader,
  AdminStatusBadge,
  AdminTable,
  type AdminTableColumn,
} from '@/components/admin';
import {
  formatDate,
  formatDateTime,
  formatRub,
  getLineKindLabel,
  getPayoutStatusLabel,
  getPayoutStatusTone,
  summarizePayoutLineSnapshot,
} from '../payout-ui';
import {
  cancelPayrollPayoutAction,
  issuePayrollPayoutAction,
  recomputePayrollPayoutAction,
} from '../actions';
import { PayoutActions } from './payout-actions';

export const dynamic = 'force-dynamic';

/**
 * Карточка выплаты зарплаты (PHASE 3 STEP 4).
 *
 * Показывает:
 *   - общие сведения (сотрудник, период, статус);
 *   - KPI-карточки (сдельно / оклад / итого);
 *   - хронологию (createdAt / issuedAt / acknowledgedAt / cancelledAt);
 *   - таблицу строк с snapshot-снимком;
 *   - кнопки действий (только для DRAFT и ISSUED; ACK — только сотрудник).
 */
export default async function AdminPayrollPayoutDetailPage({
  params,
}: {
  params: { id: string };
}) {
  let payout = null;
  try {
    payout = await getPayrollPayout(params.id);
  } catch (e) {
    if (e instanceof ApiRequestError && e.statusCode === 404) {
      notFound();
    }
    throw e;
  }

  const boundRecompute = recomputePayrollPayoutAction.bind(null, payout.id);
  const boundIssue = issuePayrollPayoutAction.bind(null, payout.id);
  const boundCancel = cancelPayrollPayoutAction.bind(null, payout.id);

  const lineColumns: AdminTableColumn<PayrollPayoutLineDto>[] = [
    {
      key: 'kind',
      header: 'Тип',
      render: (line) => getLineKindLabel(line.kind),
    },
    {
      key: 'occurredOn',
      header: 'Дата',
      render: (line) => formatDate(line.occurredOn),
    },
    {
      key: 'amount',
      header: 'Сумма, ₽',
      align: 'right',
      render: (line) => <strong>{formatRub(line.amountRub)}</strong>,
    },
    {
      key: 'source',
      header: 'Источник',
      render: (line) =>
        line.operationEntryId
          ? `OperationEntry ${line.operationEntryId.slice(0, 8)}…`
          : line.salaryEntryId
          ? `SalaryEntry ${line.salaryEntryId.slice(0, 8)}…`
          : '—',
    },
    {
      key: 'snapshot',
      header: 'Снимок',
      render: (line) => (
        <span className="admin-muted" style={{ fontSize: '0.82rem' }}>
          {summarizePayoutLineSnapshot(line)}
        </span>
      ),
    },
  ];

  return (
    <AdminPageShell
      icon={<BadgeRussianRuble size={22} strokeWidth={1.6} aria-hidden />}
      title="Выплата зарплаты"
      subtitle={`Сотрудник: ${payout.employee?.fullName ?? payout.employeeId}`}
      actions={
        <Link
          href="/admin/payroll/payouts"
          className="admin-btn admin-btn--ghost"
        >
          <ArrowLeft size={16} strokeWidth={1.6} aria-hidden />
          К списку
        </Link>
      }
    >
      {/* Общие сведения */}
      <AdminCard>
        <AdminSectionHeader title="Общие сведения" />
        <dl className="admin-deflist">
          <dt>Сотрудник</dt>
          <dd>
            {payout.employee ? (
              <Link href={`/admin/employees/${payout.employee.id}`}>
                {payout.employee.fullName}
              </Link>
            ) : (
              payout.employeeId
            )}
          </dd>
          <dt>Период</dt>
          <dd>
            {formatDate(payout.periodFrom)} – {formatDate(payout.periodTo)}
          </dd>
          <dt>Статус</dt>
          <dd>
            <AdminStatusBadge
              tone={getPayoutStatusTone(payout.status)}
              withDot
            >
              {getPayoutStatusLabel(payout.status)}
            </AdminStatusBadge>
          </dd>
        </dl>
      </AdminCard>

      {/* KPI */}
      <div className="kpi-grid">
        <div className="kpi-card">
          <div className="kpi-card__head">Сдельно</div>
          <div className="kpi-card__value">
            {formatRub(payout.amountPieceworkRub)}
          </div>
        </div>
        <div className="kpi-card">
          <div className="kpi-card__head">Оклад</div>
          <div className="kpi-card__value">
            {formatRub(payout.amountSalaryRub)}
          </div>
        </div>
        <div className="kpi-card kpi-card--accent">
          <div className="kpi-card__head">Итого</div>
          <div className="kpi-card__value">
            {formatRub(payout.amountTotalRub)}
          </div>
        </div>
      </div>

      {/* Хронология */}
      <AdminCard>
        <AdminSectionHeader title="Хронология" />
        <dl className="admin-deflist">
          <dt>Создано</dt>
          <dd>{formatDateTime(payout.createdAt)}</dd>
          {payout.issuedAt && (
            <>
              <dt>Выдано</dt>
              <dd>{formatDateTime(payout.issuedAt)}</dd>
            </>
          )}
          {payout.acknowledgedAt && (
            <>
              <dt>Подтверждено</dt>
              <dd>{formatDateTime(payout.acknowledgedAt)}</dd>
            </>
          )}
          {payout.cancelledAt && (
            <>
              <dt>Отменено</dt>
              <dd>{formatDateTime(payout.cancelledAt)}</dd>
            </>
          )}
        </dl>
        {payout.managerComment && (
          <div style={{ marginTop: '0.75rem' }}>
            <div
              className="admin-muted"
              style={{ fontSize: '0.85rem', marginBottom: '0.25rem' }}
            >
              Комментарий менеджера
            </div>
            <p>{payout.managerComment}</p>
          </div>
        )}
      </AdminCard>

      {/* Строки выплаты */}
      <AdminCard>
        <AdminSectionHeader
          title="Строки выплаты"
          hint={
            payout.lines !== undefined
              ? `${payout.lines.length} строк`
              : undefined
          }
        />
        <AdminTable
          rows={payout.lines ?? []}
          columns={lineColumns}
          rowKey={(l) => l.id}
          emptyContent={
            <AdminEmptyState
              icon={
                <BadgeRussianRuble size={24} strokeWidth={1.6} aria-hidden />
              }
              title="Строк нет"
              hint="Запустите пересчёт, чтобы собрать строки за период"
            />
          }
        />
      </AdminCard>

      {/* Кнопки действий */}
      <PayoutActions
        status={payout.status}
        recomputeAction={boundRecompute}
        issueAction={boundIssue}
        cancelAction={boundCancel}
      />
    </AdminPageShell>
  );
}
