import Link from 'next/link';
import { ArrowLeft, CalendarClock } from 'lucide-react';
import {
  PAYROLL_CUTOFF_BASES,
  PAYROLL_CUTOFF_BASIS_LABELS,
  type PayrollCutoffBasis,
} from '@sewing/shared/payroll-schedule';
import {
  AdminCard,
  AdminPageShell,
  AdminSectionHeader,
} from '@/components/admin';
import { ApiRequestError, errorText } from '@/lib/api';
import {
  getPayrollAccrualPreviewSafe,
  getPayrollSchedule,
  type PayrollPreviewRuleOverride,
} from '@/lib/payroll-schedule-api';
import { PayrollScheduleForm } from './schedule-form';

export const dynamic = 'force-dynamic';

/**
 * «Правила начисления» — когда считаем зарплату и что попадает в
 * расчёт (`PayrollAccrualSchedule`).
 *
 * Экран живёт внутри «Настроек зарплаты» рядом с производственным
 * календарём: обе настройки не относятся ни к операциям, ни к
 * сотрудникам, но напрямую двигают деньги.
 *
 * Справа — предпросмотр на ближайшую дату начисления: сколько войдёт и
 * сколько отложено по незакрытым заказам. Он же служит проверкой
 * правила: менеджер видит последствие переключателя до того, как
 * сформирует документ.
 */
export default async function AdminPayrollSchedulePage({
  searchParams,
}: {
  searchParams?: Record<string, string | string[] | undefined>;
}) {
  let schedule = null;
  let error: string | null = null;
  try {
    schedule = await getPayrollSchedule();
  } catch (e) {
    error =
      e instanceof ApiRequestError
        ? errorText(e)
        : 'Не удалось загрузить правила начисления';
  }

  // Правило из query — то, что менеджер выбрал в форме, но ещё не
  // сохранил: предпросмотр обязан считать по нему, иначе переключатель
  // не двигает сумму и проверить последствие можно только применив его
  // к деньгам.
  const draftRule = readDraftRule(searchParams);
  const preview = schedule
    ? await getPayrollAccrualPreviewSafe(undefined, draftRule)
    : null;
  const previewIsDraft =
    schedule !== null &&
    preview !== null &&
    (preview.cutoffBasis !== schedule.cutoffBasis ||
      preview.appliesToSewing !== schedule.appliesToSewing ||
      preview.appliesToCutting !== schedule.appliesToCutting);

  return (
    <AdminPageShell
      icon={<CalendarClock size={22} strokeWidth={1.6} aria-hidden />}
      title="Правила начисления"
      subtitle="Когда считаем зарплату и что попадает в расчёт"
      actions={
        <Link
          href="/admin/payroll/settings"
          className="admin-btn admin-btn--ghost"
        >
          <ArrowLeft size={16} strokeWidth={1.6} aria-hidden />
          К настройкам
        </Link>
      }
    >
      {error && (
        <div className="error-box" role="alert">
          {error}
        </div>
      )}

      {schedule && (
        <div className="admin-grid-2">
          <AdminCard>
            <AdminSectionHeader
              title="Расписание"
              hint={
                schedule.updatedByFullName
                  ? `Изменено: ${formatDateTime(schedule.updatedAt)}, ${schedule.updatedByFullName}`
                  : undefined
              }
            />
            <PayrollScheduleForm schedule={schedule} />
          </AdminCard>

          <div>
            <AdminCard>
              <AdminSectionHeader title="Ближайшие начисления" />
              {schedule.upcoming.length === 0 ? (
                <p className="admin-muted">
                  Расписание выключено: даты не заданы, черновик автоматически не
                  создаётся, дата в форме документа не подставляется.
                </p>
              ) : (
                <ul className="admin-deflist">
                  {schedule.upcoming.map((o) => (
                    <li key={o.date}>
                      <b>{formatDate(o.date)}</b>{' '}
                      <span className="admin-muted">
                        {o.daysLeft === 0
                          ? '— сегодня'
                          : `— через ${o.daysLeft} дн.`}
                      </span>
                      <div className="admin-hint">
                        период {formatDate(o.periodFrom)} — {formatDate(o.date)}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </AdminCard>

            {preview && (
              <AdminCard>
                <AdminSectionHeader
                  title={`Предпросмотр на ${formatDate(preview.accrualDate)}`}
                  hint={`Правило отсечки: ${PAYROLL_CUTOFF_BASIS_LABELS[preview.cutoffBasis]}${
                    previewIsDraft ? ' (выбрано в форме, не сохранено)' : ''
                  }`}
                />
                {!preview.appliesToSewing && !preview.appliesToCutting && (
                  <p className="admin-hint" style={{ marginBottom: '0.5rem' }}>
                    Охват снят: правило отсечки сейчас ни на что не
                    распространяется, поэтому сумма одинакова для всех трёх
                    вариантов. Включите «Пошив» и/или «Раскрой» ниже в форме.
                  </p>
                )}
                <ul className="admin-deflist">
                  <li>
                    Войдёт в расчёт: <b>{money(preview.totalAmount)}</b>{' '}
                    <span className="admin-muted">
                      ({preview.employeeCount} сотр.)
                    </span>
                  </li>
                  <li>
                    Сдельно: {money(preview.pieceworkAmount)} · раскрой:{' '}
                    {money(preview.cuttingAmount)} · оклад:{' '}
                    {money(preview.salaryAmount)} · подкрой:{' '}
                    {money(preview.recutAmount)}
                  </li>
                  <li>
                    Отложено: <b>{money(preview.deferredAmount)}</b>
                  </li>
                </ul>
                {preview.deferredOrders.length > 0 && (
                  <>
                    <p className="admin-hint" style={{ marginTop: '0.5rem' }}>
                      Не проходит отсечку — заказы не закрыты:
                    </p>
                    <ul className="admin-deflist">
                      {preview.deferredOrders.slice(0, 8).map((o) => (
                        <li key={o.orderId}>
                          <b>{o.orderNumber}</b> — {o.orderStatusLabel}, упаковано{' '}
                          {o.packedQty} из {o.totalQty} — {money(o.amount)}
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </AdminCard>
            )}
          </div>
        </div>
      )}
    </AdminPageShell>
  );
}

/**
 * Разбор несохранённого правила из query. Значения проверяются здесь, а
 * не отдаются бэку как есть: мусор в адресной строке дал бы 400, а
 * `...Safe` превратил бы его в пропавшую карточку предпросмотра.
 */
function readDraftRule(
  sp?: Record<string, string | string[] | undefined>,
): PayrollPreviewRuleOverride | undefined {
  if (!sp) return undefined;
  const rule: PayrollPreviewRuleOverride = {};
  const basis = first(sp.cutoffBasis);
  if (basis && (PAYROLL_CUTOFF_BASES as readonly string[]).includes(basis)) {
    rule.cutoffBasis = basis as PayrollCutoffBasis;
  }
  const sewing = first(sp.appliesToSewing);
  if (sewing === '0' || sewing === '1') rule.appliesToSewing = sewing === '1';
  const cutting = first(sp.appliesToCutting);
  if (cutting === '0' || cutting === '1') rule.appliesToCutting = cutting === '1';
  return Object.keys(rule).length > 0 ? rule : undefined;
}

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

function money(v: number): string {
  return `${v.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₽`;
}

function formatDate(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${d}.${m}.${y}`;
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('ru-RU', {
    timeZone: 'Europe/Moscow',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
