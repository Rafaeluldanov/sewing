import Link from 'next/link';
import {
  Activity,
  AlertCircle,
  AlertTriangle,
  ArrowRight,
  BarChart3,
  CheckCircle2,
  Clock,
  Coins,
  Factory,
  Info,
  LayoutDashboard,
  PauseCircle,
  Scissors,
  Sparkles,
  Users,
  Warehouse,
  type LucideIcon,
} from 'lucide-react';
import { ApiRequestError } from '@/lib/api';
import { getProductionDashboard } from '@/lib/dashboard-api';
import {
  PRODUCTION_DASHBOARD_PERIODS,
  PRODUCTION_DASHBOARD_ROLE_LABELS,
  PRODUCTION_DASHBOARD_STAGE_LABELS,
  type ProductionDashboardAlertSeverity,
  type ProductionDashboardDto,
  type ProductionDashboardPeriod,
} from '@sewing/shared/dashboard';
import {
  AdminCard,
  AdminEmptyState,
  AdminPageShell,
  AdminSectionHeader,
} from '@/components/admin';
import { ProductionDashboardTrendChart } from './trend-chart';

export const dynamic = 'force-dynamic';

interface SearchParams {
  days?: string;
}

/**
 * «Дашборд начальника производства» (`docs/screens.md §18`).
 *
 * Источник истины — backend (`/api/dashboard/production`). Эта
 * страница только рендерит DTO; вычисления и API не меняем. UI
 * приведён к Admin UI 2.6: AdminPageShell + AdminCard + lucide-react,
 * никаких dark backgrounds и старых строковых иконок.
 */
export default async function ProductionDashboardPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const days = parsePeriod(searchParams.days);
  let dto: ProductionDashboardDto | null = null;
  let error: string | null = null;
  try {
    dto = await getProductionDashboard({ days });
  } catch (e) {
    error =
      e instanceof ApiRequestError
        ? `${e.message}${e.code ? ` (${e.code})` : ''}`
        : 'Не удалось загрузить дашборд';
  }

  if (!dto) {
    return (
      <AdminPageShell
        icon={<LayoutDashboard size={22} strokeWidth={1.6} aria-hidden />}
        title="Дашборд производства"
        subtitle="Управленческий обзор"
      >
        {error && (
          <div className="error-box" role="alert">
            {error}
          </div>
        )}
      </AdminPageShell>
    );
  }

  const { kpi, pipeline, trend, roleLoad, alerts } = dto;
  const generatedAtLabel = new Date(dto.generatedAt).toLocaleString('ru-RU');

  return (
    <AdminPageShell
      icon={<LayoutDashboard size={22} strokeWidth={1.6} aria-hidden />}
      title="Дашборд производства"
      subtitle={`${dto.periodDays} дней · ${formatDate(dto.dateFrom)} — ${formatDate(dto.dateTo)} · обновлено ${generatedAtLabel}`}
      actions={<PeriodSwitcher current={dto.periodDays} />}
    >
      {/* 1. KPI cards ----------------------------------------------------- */}
      <section aria-label="Ключевые показатели">
        <div className="kpi-grid">
          <KpiCard
            Icon={CheckCircle2}
            tone="ok"
            label="Выпущено сегодня"
            value={`${formatInt(kpi.producedToday)} шт`}
            sub={`${formatInt(kpi.producedPeriod)} шт за период`}
          />
          <KpiCard
            Icon={Activity}
            tone="accent"
            label="В работе сейчас"
            value={`${formatInt(kpi.wipUnits)} шт`}
            sub={`${formatInt(kpi.wipPassports)} паспортов`}
          />
          <KpiCard
            Icon={BarChart3}
            label="Заказы в производстве"
            value={`${formatInt(kpi.ordersInProduction)} шт`}
          />
          <KpiCard
            Icon={Coins}
            tone="accent"
            label="Себестоимость / шт"
            value={
              kpi.avgCostPerUnitToday > 0
                ? `${formatMoney(kpi.avgCostPerUnitToday)} ₽`
                : '—'
            }
            sub={
              kpi.totalCostPeriod > 0
                ? `${formatMoney(kpi.totalCostPeriod)} ₽ за период`
                : 'Выпуска ещё не было'
            }
          />
          <KpiCard
            Icon={PauseCircle}
            tone={kpi.idleCostToday > 0 ? 'danger' : undefined}
            label="Простой сегодня"
            value={`${formatMoney(kpi.idleCostToday)} ₽`}
            sub={`${formatMoney(kpi.idleCostPeriod)} ₽ за период`}
          />
          <KpiCard
            Icon={LayoutDashboard}
            tone={
              kpi.utilizationToday >= 60
                ? 'ok'
                : kpi.utilizationToday >= 30
                  ? undefined
                  : 'danger'
            }
            label="Загрузка цеха сегодня"
            value={`${kpi.utilizationToday}%`}
            sub="ОТК + ВТО + Упаковка, день"
          />
        </div>
      </section>

      {/* 2. Pipeline ----------------------------------------------------- */}
      <AdminCard>
        <AdminSectionHeader
          icon={<Factory size={16} strokeWidth={1.6} aria-hidden />}
          title="Где сейчас изделия"
          actions={
            <Link href="/shopfloor" className="admin-table__action-link">
              Открыть «Цех»
              <ArrowRight size={14} strokeWidth={1.6} aria-hidden />
            </Link>
          }
        />
        <div className="stage-grid">
          {pipeline.stages.map((s) => {
            const isBottleneck =
              pipeline.bottleneckStage === s.stage && s.qty > 0;
            return (
              <div
                key={s.stage}
                className={`stage-card${isBottleneck ? ' stage-card--bottleneck' : ''}`}
              >
                <div className="stage-card__head">
                  {isBottleneck && (
                    <AlertTriangle size={14} strokeWidth={1.6} aria-hidden />
                  )}
                  {PRODUCTION_DASHBOARD_STAGE_LABELS[s.stage]}
                </div>
                <div className="stage-card__value">
                  {formatInt(s.qty)}
                  <span className="stage-card__value-unit">шт</span>
                </div>
                <div className="stage-card__meta">{s.passports} паспортов</div>
              </div>
            );
          })}
          <div className="stage-card stage-card--ghost">
            <div className="stage-card__head">
              <AlertCircle size={14} strokeWidth={1.6} aria-hidden />
              Брак (всего)
            </div>
            <div
              className="stage-card__value"
              style={{
                color:
                  pipeline.defectQty > 0 ? 'var(--color-danger-fg)' : undefined,
              }}
            >
              {formatInt(pipeline.defectQty)}
              <span className="stage-card__value-unit">шт</span>
            </div>
          </div>
        </div>
        {pipeline.bottleneckStage && pipeline.bottleneckQty > 0 && (
          <p className="admin-muted" style={{ margin: '0.5rem 0 0' }}>
            <AlertTriangle size={13} strokeWidth={1.6} aria-hidden /> Узкое
            место: {PRODUCTION_DASHBOARD_STAGE_LABELS[pipeline.bottleneckStage]}
            {' — '}
            {formatInt(pipeline.bottleneckQty)} шт.
          </p>
        )}
      </AdminCard>

      {/* 3. Trend chart -------------------------------------------------- */}
      <AdminCard>
        <AdminSectionHeader
          icon={<Activity size={16} strokeWidth={1.6} aria-hidden />}
          title="Динамика по дням"
          hint="Выпуск, себестоимость, простой"
        />
        <ProductionDashboardTrendChart days={trend} />
      </AdminCard>

      {/* 4. Role load ---------------------------------------------------- */}
      <AdminCard>
        <AdminSectionHeader
          icon={<Users size={16} strokeWidth={1.6} aria-hidden />}
          title={`Загрузка по ролям (${formatDate(dto.dateTo)})`}
          actions={
            <Link
              href="/production-cost"
              className="admin-table__action-link"
            >
              Подробнее в «Себестоимости»
              <ArrowRight size={14} strokeWidth={1.6} aria-hidden />
            </Link>
          }
        />
        {roleLoad.every((r) => r.employees === 0 && r.trackedMinutes === 0) ? (
          <AdminEmptyState
            icon={<Info size={26} strokeWidth={1.6} aria-hidden />}
            title="Нет данных за день"
            hint={`За ${formatDate(dto.dateTo)} нет ни смен, ни учтённых минут.`}
          />
        ) : (
          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Роль</th>
                  <th style={{ textAlign: 'right' }}>Окладников</th>
                  <th style={{ textAlign: 'right' }}>Оплачено, мин</th>
                  <th style={{ textAlign: 'right' }}>Учтено, мин</th>
                  <th style={{ textAlign: 'right' }}>Простой, мин</th>
                  <th style={{ textAlign: 'right' }}>Простой, ₽</th>
                  <th style={{ textAlign: 'right' }}>Загрузка</th>
                </tr>
              </thead>
              <tbody>
                {roleLoad.map((r) => (
                  <tr key={r.role}>
                    <td>{PRODUCTION_DASHBOARD_ROLE_LABELS[r.role]}</td>
                    <td style={{ textAlign: 'right' }}>{r.employees}</td>
                    <td style={{ textAlign: 'right' }}>
                      {formatInt(r.paidMinutes)}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      {formatInt(r.trackedMinutes)}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      {formatInt(r.idleMinutes)}
                    </td>
                    <td
                      style={{
                        textAlign: 'right',
                        color:
                          r.idleCost > 0
                            ? 'var(--color-danger-fg)'
                            : undefined,
                      }}
                    >
                      {formatMoney(r.idleCost)}
                    </td>
                    <td style={{ textAlign: 'right' }}>{r.utilization}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </AdminCard>

      {/* 5. Alerts ------------------------------------------------------- */}
      <AdminCard>
        <AdminSectionHeader
          icon={<AlertTriangle size={16} strokeWidth={1.6} aria-hidden />}
          title="Требует внимания"
          hint={
            alerts.length > 0
              ? `${alerts.length} ${alerts.length === 1 ? 'алерт' : 'алертов'}`
              : undefined
          }
        />
        {alerts.length === 0 ? (
          <AdminEmptyState
            icon={<Sparkles size={26} strokeWidth={1.6} aria-hidden />}
            title="Сегодня всё спокойно"
            hint="Алертов нет."
          />
        ) : (
          <div className="alert-stack">
            {alerts.map((a, i) => (
              <AlertRow key={`${a.type}-${i}`} {...a} />
            ))}
          </div>
        )}
      </AdminCard>

      {/* 6. Quick actions ------------------------------------------------ */}
      <AdminCard>
        <AdminSectionHeader
          icon={<ArrowRight size={16} strokeWidth={1.6} aria-hidden />}
          title="Быстрые переходы"
        />
        <div className="quick-grid">
          <QuickLink href="/shopfloor" Icon={Factory} label="Цех" />
          <QuickLink
            href="/production-cost"
            Icon={Coins}
            label="Себестоимость"
          />
          <QuickLink href="/earnings" Icon={Coins} label="Зарплата" />
          <QuickLink
            href="/admin/employees"
            Icon={Users}
            label="Сотрудники"
          />
          <QuickLink
            href="/admin/operations"
            Icon={Scissors}
            label="Операции"
          />
          <QuickLink
            href="/admin/warehouses"
            Icon={Warehouse}
            label="Склад"
          />
          <QuickLink
            href="/orders"
            Icon={BarChart3}
            label="Заказы"
          />
          <QuickLink
            href="/admin/overview"
            Icon={LayoutDashboard}
            label="Операционный обзор"
          />
        </div>
      </AdminCard>
    </AdminPageShell>
  );
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function parsePeriod(raw: string | undefined): ProductionDashboardPeriod {
  if (!raw) return 7;
  const n = Number(raw);
  if (
    Number.isInteger(n) &&
    (PRODUCTION_DASHBOARD_PERIODS as readonly number[]).includes(n)
  ) {
    return n as ProductionDashboardPeriod;
  }
  return 7;
}

function PeriodSwitcher({ current }: { current: ProductionDashboardPeriod }) {
  return (
    <div className="toggle-group" role="group" aria-label="Период">
      {PRODUCTION_DASHBOARD_PERIODS.map((p) => (
        <Link
          key={p}
          href={`/admin/production-dashboard?days=${p}`}
          className={`toggle-group__item${p === current ? ' is-active' : ''}`}
          aria-current={p === current ? 'page' : undefined}
        >
          <Clock size={14} strokeWidth={1.6} aria-hidden />
          {p} дней
        </Link>
      ))}
    </div>
  );
}

type KpiTone = 'ok' | 'warn' | 'danger' | 'accent';
function KpiCard({
  Icon,
  label,
  value,
  sub,
  tone,
}: {
  Icon: LucideIcon;
  label: string;
  value: string;
  sub?: string;
  tone?: KpiTone;
}) {
  const cls = `kpi-card${tone ? ` kpi-card--${tone}` : ''}`;
  return (
    <div className={cls}>
      <div className="kpi-card__head">
        <span className="kpi-card__icon">
          <Icon size={16} strokeWidth={1.6} aria-hidden />
        </span>
        {label}
      </div>
      <div className="kpi-card__value">{value}</div>
      {sub && <div className="kpi-card__sub">{sub}</div>}
    </div>
  );
}

const SEVERITY_ICON: Record<ProductionDashboardAlertSeverity, LucideIcon> = {
  INFO: Info,
  WARN: AlertTriangle,
  CRIT: AlertCircle,
};

function AlertRow({
  severity,
  message,
  value,
  unit,
  href,
}: {
  severity: ProductionDashboardAlertSeverity;
  message: string;
  value?: number;
  unit?: '₽' | 'шт' | 'мин' | '%';
  href?: string;
}) {
  const severityToTone: Record<ProductionDashboardAlertSeverity, string> = {
    INFO: 'info',
    WARN: 'warn',
    CRIT: 'crit',
  };
  const Icon = SEVERITY_ICON[severity];
  const valueLabel =
    value === undefined
      ? null
      : `${unit === '₽' ? formatMoney(value) : formatInt(value)}${unit ? ` ${unit}` : ''}`;
  const cls = `alert-row alert-row--${severityToTone[severity]}`;
  const inner = (
    <>
      <span className="alert-row__icon" aria-hidden>
        <Icon size={14} strokeWidth={1.6} />
      </span>
      <span className="alert-row__msg">{message}</span>
      {valueLabel && <span className="alert-row__value">{valueLabel}</span>}
    </>
  );
  return href ? (
    <Link href={href} className={cls}>
      {inner}
    </Link>
  ) : (
    <div className={cls}>{inner}</div>
  );
}

function QuickLink({
  href,
  label,
  Icon,
}: {
  href: string;
  label: string;
  Icon: LucideIcon;
}) {
  return (
    <Link className="quick-link" href={href}>
      <span className="quick-link__icon">
        <Icon size={16} strokeWidth={1.6} aria-hidden />
      </span>
      <span className="quick-link__label">{label}</span>
      <span className="quick-link__chev" aria-hidden>
        <ArrowRight size={16} strokeWidth={1.6} />
      </span>
    </Link>
  );
}

function formatDate(iso: string): string {
  if (!iso) return '—';
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

function formatInt(value: number): string {
  return value.toLocaleString('ru-RU');
}
