import { notFound, redirect } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, BadgeRussianRuble } from 'lucide-react';
import { getCurrentUserOrNull } from '@/lib/auth-api';
import { getPayrollPayout } from '@/lib/payroll-payouts-api';
import { ApiRequestError } from '@/lib/api';
import type { PayrollPayoutLineDto, PayrollPayoutDto } from '@sewing/shared/payroll-payouts';
import { acknowledgePayrollPayoutAction } from '../actions';
import { AckButton } from './ack-button';

export const dynamic = 'force-dynamic';

function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(`${iso.slice(0, 10)}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('ru-RU');
}

function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatRub(value: number): string {
  return `${value.toLocaleString('ru-RU', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  })} ₽`;
}

function statusLabel(status: PayrollPayoutDto['status']): string {
  switch (status) {
    case 'DRAFT':
      return 'Черновик';
    case 'ISSUED':
      return 'Ожидает подтверждения';
    case 'ACKNOWLEDGED':
      return 'Получено';
    case 'CANCELLED':
      return 'Отменено';
  }
}

function statusStyle(
  status: PayrollPayoutDto['status'],
): React.CSSProperties {
  switch (status) {
    case 'ISSUED':
      return {
        background: '#fef9c3',
        color: '#854d0e',
        border: '1px solid #fde047',
      };
    case 'ACKNOWLEDGED':
      return {
        background: '#e4f4e6',
        color: '#2f7d4e',
        border: '1px solid #a9d9b5',
      };
    case 'CANCELLED':
      return {
        background: '#f1f1ef',
        color: '#5f5f5c',
        border: '1px solid #d4d4d0',
      };
    default:
      return {
        background: '#f1f1ef',
        color: '#374151',
        border: '1px solid #d4d4d0',
      };
  }
}

function lineKindLabel(kind: PayrollPayoutLineDto['kind']): string {
  switch (kind) {
    case 'PIECEWORK':
      return 'Сдельно';
    case 'SALARY':
      return 'Оклад';
    case 'BONUS':
      return 'Бонус';
    case 'DEDUCTION':
      return 'Удержание';
    case 'ADVANCE':
      return 'Аванс';
    case 'ADJUSTMENT':
      return 'Корректировка';
    default:
      return kind;
  }
}

function formatSignedRub(value: number): string {
  if (value === 0) return '0 ₽';
  const prefix = value > 0 ? '+' : '';
  return `${prefix}${value.toLocaleString('ru-RU', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  })} ₽`;
}

import type React from 'react';

/**
 * Карточка выплаты для сотрудника (PHASE 3 STEP 5).
 *
 * Показывает детали выплаты в read-only режиме.
 * Кнопка «Деньги получил» доступна только при статусе ISSUED.
 * Никаких кнопок cancel / recompute / issue нет.
 */
export default async function EmployeePayoutDetailPage({
  params,
}: {
  params: { id: string };
}) {
  const me = await getCurrentUserOrNull();
  if (!me) redirect(`/login?next=/earnings/payouts/${params.id}`);

  let payout: PayrollPayoutDto;
  try {
    payout = await getPayrollPayout(params.id);
  } catch (e) {
    if (e instanceof ApiRequestError && e.statusCode === 404) {
      notFound();
    }
    throw e;
  }

  const boundAck = acknowledgePayrollPayoutAction.bind(null, payout.id);

  return (
    <div className="page-shell">
      {/* Шапка */}
      <div>
        <div className="page-eyebrow">
          <BadgeRussianRuble size={18} strokeWidth={1.6} aria-hidden />
          Мои выплаты
        </div>
        <h1 className="page-title">Выплата зарплаты</h1>
        <p className="page-subtitle">
          {formatDate(payout.periodFrom)} — {formatDate(payout.periodTo)}
        </p>
      </div>

      {/* Статус */}
      <div>
        <span
          style={{
            ...statusStyle(payout.status),
            display: 'inline-block',
            borderRadius: '9999px',
            padding: '0.3rem 0.9rem',
            fontSize: '0.875rem',
            fontWeight: 600,
          }}
        >
          {statusLabel(payout.status)}
        </span>
      </div>

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

      {/* Детали */}
      <div className="card">
        <h2 style={{ margin: '0 0 0.75rem', fontWeight: 600 }}>
          Детали
        </h2>
        <dl
          style={{
            display: 'grid',
            gridTemplateColumns: 'auto 1fr',
            gap: '0.375rem 1rem',
            margin: 0,
          }}
        >
          <dt style={{ color: '#5f5f5c', fontWeight: 500 }}>Период</dt>
          <dd style={{ margin: 0 }}>
            {formatDate(payout.periodFrom)} — {formatDate(payout.periodTo)}
          </dd>
          {payout.issuedAt && (
            <>
              <dt style={{ color: '#5f5f5c', fontWeight: 500 }}>Выдано</dt>
              <dd style={{ margin: 0 }}>{formatDateTime(payout.issuedAt)}</dd>
            </>
          )}
          {payout.acknowledgedAt && (
            <>
              <dt style={{ color: '#5f5f5c', fontWeight: 500 }}>Подтверждено</dt>
              <dd style={{ margin: 0 }}>{formatDateTime(payout.acknowledgedAt)}</dd>
            </>
          )}
          {payout.managerComment && (
            <>
              <dt style={{ color: '#5f5f5c', fontWeight: 500 }}>Комментарий</dt>
              <dd style={{ margin: 0 }}>{payout.managerComment}</dd>
            </>
          )}
        </dl>
      </div>

      {/* Строки выплаты */}
      {payout.lines && payout.lines.length > 0 && (
        <div className="card">
          <h2
            style={{ margin: '0 0 0.75rem', fontWeight: 600 }}
          >
            Строки выплаты
          </h2>
          <table className="data-table">
            <thead>
              <tr>
                <th>Дата</th>
                <th>Тип</th>
                <th style={{ textAlign: 'right' }}>Сумма, ₽</th>
              </tr>
            </thead>
            <tbody>
              {payout.lines.map((line) => (
                <tr key={line.id}>
                  <td>{formatDate(line.occurredOn)}</td>
                  <td>
                    {lineKindLabel(line.kind)}
                    {line.kind === 'ADJUSTMENT' &&
                      line.snapshot &&
                      typeof line.snapshot === 'object' &&
                      typeof (line.snapshot as Record<string, unknown>).manualComment === 'string' && (
                        <span
                          style={{
                            display: 'block',
                            fontSize: '0.8rem',
                            color: '#5f5f5c',
                            marginTop: '0.15rem',
                          }}
                        >
                          {String((line.snapshot as Record<string, unknown>).manualComment)}
                        </span>
                      )}
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <strong>
                      {line.kind === 'ADJUSTMENT'
                        ? formatSignedRub(line.amountRub)
                        : formatRub(line.amountRub)}
                    </strong>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Кнопка подтверждения — только для ISSUED */}
      {payout.status === 'ISSUED' && (
        <div className="card">
          <h2
            style={{ margin: '0 0 0.5rem', fontWeight: 600 }}
          >
            Подтверждение получения
          </h2>
          <p style={{ color: '#5f5f5c', marginBottom: '1rem', marginTop: 0 }}>
            Нажмите кнопку ниже, чтобы подтвердить, что вы получили эту
            выплату.
          </p>
          <AckButton ackAction={boundAck} />
        </div>
      )}

      {payout.status === 'ACKNOWLEDGED' && (
        <div
          style={{
            background: '#e4f4e6',
            border: '1px solid #a9d9b5',
            borderRadius: '0.5rem',
            padding: '0.875rem 1rem',
            color: '#2f7d4e',
            fontWeight: 500,
          }}
        >
          Вы подтвердили получение этой выплаты. Спасибо!
        </div>
      )}

      {payout.status === 'CANCELLED' && (
        <div
          style={{
            background: '#f1f1ef',
            border: '1px solid #d4d4d0',
            borderRadius: '0.5rem',
            padding: '0.875rem 1rem',
            color: '#5f5f5c',
          }}
        >
          Эта выплата была отменена.
        </div>
      )}

      <div>
        <Link href="/earnings/payouts" className="btn btn-ghost">
          <ArrowLeft size={16} strokeWidth={1.6} aria-hidden />
          К списку выплат
        </Link>
      </div>
    </div>
  );
}
