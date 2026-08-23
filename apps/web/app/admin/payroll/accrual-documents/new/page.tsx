import Link from 'next/link';
import { BadgeRussianRuble } from 'lucide-react';
import {
  AdminCard,
  AdminPageShell,
  AdminSectionHeader,
} from '@/components/admin';
import { listEmployees } from '@/lib/employees-api';
import {
  PAYROLL_CUTOFF_BASIS_LABELS,
} from '@sewing/shared/payroll-schedule';
import {
  getPayrollAccrualPreviewSafe,
  getPayrollScheduleSafe,
} from '@/lib/payroll-schedule-api';
import { CreateAccrualDocumentForm } from './create-form';

export const dynamic = 'force-dynamic';

/**
 * Страница создания документа начисления зарплаты (PHASE 3 STEP 6.3).
 *
 * Менеджер указывает `accrualDate` — дату расчёта включительно — и
 * опционально конкретного сотрудника (иначе документ формируется по
 * всем сотрудникам). Система включает в документ все неоплаченные
 * утверждённые начисления и окладные дни до этой даты.
 */
export default async function AdminNewAccrualDocumentPage() {
  const employees = await listEmployees({ active: true }).catch(() => []);

  // Расписание подставляет дату и показывает, что войдёт в документ, а
  // что останется отложенным. Обе ручки fail-soft: без расписания форма
  // работает ровно как раньше — дата «сегодня», без справки.
  const schedule = await getPayrollScheduleSafe();
  const nextScheduled = schedule?.upcoming[0] ?? null;
  // Подставляем дату расписания, только если она уже наступила. Иначе
  // менеджер, формирующий документ ДОСРОЧНО (20-го при начислении 25-го),
  // получил бы документ с работой по 20-е, но с периодом по 25-е — и
  // сотрудник увидел бы в расчётке период, часть которого не оплачена.
  const today = moscowToday();
  const dateReached = nextScheduled ? nextScheduled.date <= today : false;
  const defaultDate = dateReached ? nextScheduled!.date : null;
  const preview = await getPayrollAccrualPreviewSafe(defaultDate ?? today);

  return (
    <AdminPageShell
      icon={<BadgeRussianRuble size={22} strokeWidth={1.6} aria-hidden />}
      title="Начислить зарплату"
      subtitle="Сформировать документ начисления зарплаты на дату"
      actions={
        <Link
          href="/admin/payroll/accrual-documents"
          className="admin-btn admin-btn--ghost"
        >
          ← К списку
        </Link>
      }
    >
      <AdminCard>
        <AdminSectionHeader title="Параметры начисления" />
        <p
          className="admin-muted"
          style={{ marginBottom: '1rem', fontSize: '0.9rem' }}
        >
          Документ включит только неоплаченные утверждённые начисления и
          окладные дни до выбранной даты включительно. Можно ограничить
          документ одним сотрудником.
        </p>
        <CreateAccrualDocumentForm
          employees={employees}
          defaultAccrualDate={defaultDate}
          periodFrom={dateReached ? (nextScheduled?.periodFrom ?? null) : null}
          nextScheduledDate={
            nextScheduled && !dateReached ? nextScheduled.date : null
          }
        />
      </AdminCard>

      {preview && (
        <AdminCard>
          <AdminSectionHeader
            title={`Что войдёт в документ на ${formatDate(preview.accrualDate)}`}
            hint={`Правило отсечки: ${PAYROLL_CUTOFF_BASIS_LABELS[preview.cutoffBasis]}`}
          />
          <table className="admin-table">
            <tbody>
              <tr>
                <td>Сдельно — пошив, ОТК, ВТО</td>
                <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{money(preview.pieceworkAmount)}</td>
              </tr>
              <tr>
                <td>Раскрой</td>
                <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{money(preview.cuttingAmount)}</td>
              </tr>
              <tr>
                <td>Оклад и часы смены</td>
                <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{money(preview.salaryAmount)}</td>
              </tr>
              <tr>
                <td>Подкрой (почасовая доплата)</td>
                <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{money(preview.recutAmount)}</td>
              </tr>
              <tr>
                <td>
                  <b>Итого к начислению</b>
                </td>
                <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                  <b>{money(preview.totalAmount)}</b>
                </td>
              </tr>
            </tbody>
          </table>

          {preview.deferredAmount > 0 && (
            <div className="admin-hint" style={{ marginTop: '0.75rem' }}>
              <b>Не войдёт: {money(preview.deferredAmount)}</b> — сдельщина по
              заказам, не прошедшим отсечку. Суммы не сгорают: попадут в
              документ, следующий за закрытием заказа.
              <ul className="admin-deflist" style={{ marginTop: '0.4rem' }}>
                {preview.deferredOrders.slice(0, 8).map((o) => (
                  <li key={o.orderId}>
                    <b>{o.orderNumber}</b> — {o.orderStatusLabel}, упаковано{' '}
                    {o.packedQty} из {o.totalQty} — {money(o.amount)}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </AdminCard>
      )}
    </AdminPageShell>
  );
}

function money(v: number): string {
  return `${v.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₽`;
}

function formatDate(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${d}.${m}.${y}`;
}

/** Сегодняшняя дата по Москве — весь домен живёт в московских сутках. */
function moscowToday(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Moscow',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}
