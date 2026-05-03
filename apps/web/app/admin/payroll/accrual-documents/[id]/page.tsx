import { notFound } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, BadgeRussianRuble } from 'lucide-react';
import type { PayrollAccrualDocumentLineDto } from '@sewing/shared/payroll-accrual-documents';
import { ApiRequestError } from '@/lib/api';
import { getPayrollAccrualDocument } from '@/lib/payroll-accrual-documents-api';
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
  formatSignedRub,
  getAccrualDocumentStatusLabel,
  getAccrualDocumentStatusTone,
  getPayBlockedReason,
} from '../accrual-document-ui';
import {
  cancelPayrollAccrualDocumentAction,
  payPayrollAccrualDocumentAction,
  recomputePayrollAccrualDocumentAction,
  updatePayrollAccrualDocumentLineAction,
} from '../actions';
import { DocumentActions } from './document-actions';
import { LineAdjustmentForm } from './line-adjustment-form';

export const dynamic = 'force-dynamic';

/**
 * Карточка документа начисления зарплаты (PHASE 3 STEP 6.3).
 *
 * DRAFT — редактируемые строки + кнопки действий.
 * PAID  — read-only, показывает ссылки на выплаты.
 * CANCELLED — read-only.
 */
export default async function AdminAccrualDocumentDetailPage({
  params,
}: {
  params: { id: string };
}) {
  let doc = null;
  try {
    doc = await getPayrollAccrualDocument(params.id);
  } catch (e) {
    if (e instanceof ApiRequestError && e.statusCode === 404) {
      notFound();
    }
    throw e;
  }

  const isDraft = doc.status === 'DRAFT';

  const boundRecompute = recomputePayrollAccrualDocumentAction.bind(
    null,
    doc.id,
  );
  const boundPay = payPayrollAccrualDocumentAction.bind(null, doc.id);
  const boundCancel = cancelPayrollAccrualDocumentAction.bind(null, doc.id);

  const payBlockedReason = getPayBlockedReason(doc);

  const lineColumns: AdminTableColumn<PayrollAccrualDocumentLineDto>[] = [
    {
      key: 'employee',
      header: 'Сотрудник',
      render: (line) => (
        <Link href={`/admin/employees/${line.employee.id}`}>
          {line.employee.fullName}
        </Link>
      ),
    },
    {
      key: 'piecework',
      header: 'Сдельно',
      align: 'right',
      render: (line) => formatRub(line.amountPieceworkRub),
    },
    {
      key: 'salary',
      header: 'Оклад',
      align: 'right',
      render: (line) => formatRub(line.amountSalaryRub),
    },
    {
      key: 'adjust',
      header: 'Корректировка',
      align: 'right',
      render: (line) =>
        isDraft ? (
          <LineAdjustmentForm
            lineId={line.id}
            initialAdjust={line.manualAdjustRub}
            initialComment={line.manualComment}
            updateAction={updatePayrollAccrualDocumentLineAction.bind(
              null,
              doc!.id,
              line.id,
            )}
          />
        ) : line.manualAdjustRub !== 0 ? (
          <span>{formatSignedRub(line.manualAdjustRub)}</span>
        ) : (
          '—'
        ),
    },
    {
      key: 'comment',
      header: 'Комментарий',
      render: (line) =>
        isDraft ? null : (
          <span className="admin-muted" style={{ fontSize: '0.85rem' }}>
            {line.manualComment ?? '—'}
          </span>
        ),
    },
    {
      key: 'total',
      header: 'Итого к выплате',
      align: 'right',
      render: (line) => <strong>{formatRub(line.amountToPayRub)}</strong>,
    },
    {
      key: 'payout',
      header: 'Выплата',
      render: (line) =>
        line.payoutId ? (
          <Link
            href={`/admin/payroll/payouts/${line.payoutId}`}
            className="admin-btn admin-btn--ghost admin-btn--sm"
          >
            Открыть
          </Link>
        ) : (
          '—'
        ),
    },
  ];

  return (
    <AdminPageShell
      icon={<BadgeRussianRuble size={22} strokeWidth={1.6} aria-hidden />}
      title="Документ начисления"
      subtitle={`Дата: ${formatDate(doc.accrualDate)}`}
      actions={
        <Link
          href="/admin/payroll/accrual-documents"
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
          <dt>Статус</dt>
          <dd>
            <AdminStatusBadge
              tone={getAccrualDocumentStatusTone(doc.status)}
              withDot
            >
              {getAccrualDocumentStatusLabel(doc.status)}
            </AdminStatusBadge>
          </dd>
          <dt>Дата начисления</dt>
          <dd>{formatDate(doc.accrualDate)}</dd>
          {doc.managerComment && (
            <>
              <dt>Комментарий менеджера</dt>
              <dd>{doc.managerComment}</dd>
            </>
          )}
        </dl>
      </AdminCard>

      {/* KPI */}
      <div className="kpi-grid">
        <div className="kpi-card">
          <div className="kpi-card__head">Сдельно</div>
          <div className="kpi-card__value">
            {formatRub(doc.totalPieceworkRub)}
          </div>
        </div>
        <div className="kpi-card">
          <div className="kpi-card__head">Оклад</div>
          <div className="kpi-card__value">
            {formatRub(doc.totalSalaryRub)}
          </div>
        </div>
        <div className="kpi-card">
          <div className="kpi-card__head">Корректировки</div>
          <div className="kpi-card__value">
            {doc.totalAdjustRub !== 0
              ? formatSignedRub(doc.totalAdjustRub)
              : '—'}
          </div>
        </div>
        <div className="kpi-card kpi-card--accent">
          <div className="kpi-card__head">Итого к выплате</div>
          <div className="kpi-card__value">
            {formatRub(doc.totalToPayRub)}
          </div>
        </div>
        <div className="kpi-card">
          <div className="kpi-card__head">Сотрудников</div>
          <div className="kpi-card__value">{doc.lines.length}</div>
        </div>
      </div>

      {/* Хронология */}
      <AdminCard>
        <AdminSectionHeader title="Хронология" />
        <dl className="admin-deflist">
          <dt>Создано</dt>
          <dd>{formatDateTime(doc.createdAt)}</dd>
          {doc.paidAt && (
            <>
              <dt>Выплачено</dt>
              <dd>{formatDateTime(doc.paidAt)}</dd>
            </>
          )}
          {doc.cancelledAt && (
            <>
              <dt>Отменено</dt>
              <dd>{formatDateTime(doc.cancelledAt)}</dd>
            </>
          )}
          {doc.cancelReason && (
            <>
              <dt>Причина отмены</dt>
              <dd>{doc.cancelReason}</dd>
            </>
          )}
        </dl>
      </AdminCard>

      {/* Таблица строк */}
      <AdminCard>
        <AdminSectionHeader
          title="Строки документа"
          hint={`${doc.lines.length} сотрудников`}
        />
        <AdminTable
          rows={doc.lines}
          columns={lineColumns}
          rowKey={(l) => l.id}
          emptyContent={
            <AdminEmptyState
              icon={
                <BadgeRussianRuble size={24} strokeWidth={1.6} aria-hidden />
              }
              title="Нет начислений к выплате на выбранную дату"
              hint="Нет неоплаченных утверждённых начислений или окладных дней до указанной даты"
            />
          }
        />
      </AdminCard>

      {/* Действия */}
      {isDraft && (
        <DocumentActions
          status={doc.status}
          payBlockedReason={payBlockedReason}
          hasAdjustments={doc.totalAdjustRub !== 0}
          recomputeAction={boundRecompute}
          payAction={boundPay}
          cancelAction={boundCancel}
        />
      )}
    </AdminPageShell>
  );
}
