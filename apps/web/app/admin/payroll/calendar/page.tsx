import Link from 'next/link';
import { ArrowLeft, CalendarDays } from 'lucide-react';
import {
  AdminCard,
  AdminPageShell,
  AdminSectionHeader,
} from '@/components/admin';
import { listPayrollCalendarSafe } from '@/lib/payroll-calendar-api';
import { PayrollCalendarYearForm } from './calendar-year-form';

export const dynamic = 'force-dynamic';

interface SearchParams {
  year?: string;
}

/**
 * Производственный календарь — норма рабочих дней и часов на месяц
 * (`/admin/payroll/calendar`, см. `docs/api.md §31a`,
 * `docs/domain.md §9a`).
 *
 * Зачем менеджеру этот экран. Сотруднику с МЕСЯЧНЫМ окладом система
 * всё равно обязана уметь посчитать стоимость часа: по ней идёт
 * доплата за подкрой (она почасовая по своей природе) и разнос оклада
 * на себестоимость. Курс — `оклад ÷ норма часов месяца`, и норму
 * из даты не вывести: она зависит от переносов праздников.
 *
 * Незаполненный месяц не ломает расчёт — он падает на дефолт
 * «21 день × 8 ч» (`DEFAULT_MONTH_NORM_HOURS`). Именно поэтому экран
 * подсвечивает пропуски: молчаливое приближение легко не заметить.
 */
export default async function AdminPayrollCalendarPage({
  searchParams,
}: {
  searchParams?: SearchParams;
}) {
  const now = new Date();
  const currentYear = Number(
    now.toLocaleString('ru-RU', {
      year: 'numeric',
      timeZone: 'Europe/Moscow',
    }),
  );
  const requested = Number(searchParams?.year ?? '');
  const year =
    Number.isInteger(requested) && requested >= 2000 && requested <= 2100
      ? requested
      : currentYear;

  const months = await listPayrollCalendarSafe(year);
  const filledCount = months.length;

  return (
    <AdminPageShell
      icon={<CalendarDays size={22} strokeWidth={1.6} aria-hidden />}
      title="Производственный календарь"
      subtitle={`${year} год · заполнено месяцев: ${filledCount} из 12`}
      actions={
        <Link
          href="/admin/payroll/settings"
          className="admin-btn admin-btn--ghost"
        >
          <ArrowLeft size={16} strokeWidth={1.6} aria-hidden />К настройкам
        </Link>
      }
    >
      <AdminCard>
        <AdminSectionHeader
          title="Норма месяца"
          actions={
            <div className="admin-actions-row">
              {[year - 1, year, year + 1].map((y) => (
                <Link
                  key={y}
                  href={`/admin/payroll/calendar?year=${y}`}
                  className={`admin-btn ${
                    y === year ? 'admin-btn--primary' : 'admin-btn--ghost'
                  }`}
                >
                  {y}
                </Link>
              ))}
            </div>
          }
        />
        <p className="admin-muted" style={{ marginBottom: '0.75rem' }}>
          Норма часов — знаменатель ставки ₽/час для сотрудников с
          месячным окладом: по ней считается доплата за подкрой и разнос
          оклада на себестоимость. На саму сумму месячного оклада норма
          не влияет — он начисляется за месяц целиком. Незаполненный
          месяц считается по умолчанию как 21 день × 8 ч (168 ч).
        </p>
        <PayrollCalendarYearForm year={year} months={months} />
      </AdminCard>
    </AdminPageShell>
  );
}
