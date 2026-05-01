import Link from 'next/link';
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
import { Icon, type IconName } from '@/components/icon';
import { ProductionDashboardTrendChart } from './trend-chart';

export const dynamic = 'force-dynamic';

interface SearchParams {
  days?: string;
}

/**
 * «Дашборд начальника производства» (`docs/screens.md §18`).
 *
 * Единый управленческий экран. RBAC закрывает `app/admin/layout.tsx`
 * (`canSeeAdmin`); backend (`/api/dashboard/production`) дополнительно
 * защищён `@Roles('SHOP_MANAGER', 'ADMIN')`.
 *
 * Содержимое (порядок фиксирован):
 *   1. KPI-карточки сверху (выпуск/WIP/себестоимость/простой/загрузка).
 *   2. Pipeline — где сейчас изделия (CUT … FINISHED) + bottleneck.
 *   3. Динамика выпуска / себестоимости / простоя — компактный SVG-чарт.
 *   4. Загрузка по ролям (ОТК / ВТО / Упаковка) за день.
 *   5. Алерты «Требует внимания».
 *   6. Quick links — переходы в другие управленческие разделы.
 *
 * Источник истины — backend; страница ничего не пересчитывает руками
 * (см. `apps/api/src/modules/dashboard`).
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
      <div className="page-shell">
        <div>
          <div className="page-eyebrow">
            <Icon name="dashboard" />
            Управление производством
          </div>
          <h1 className="page-title">
            <Icon name="dashboard" />
            Дашборд начальника производства
          </h1>
        </div>
        {error && <div className="error-box">{error}</div>}
      </div>
    );
  }

  const { kpi, pipeline, trend, roleLoad, alerts } = dto;
  const generatedAtLabel = new Date(dto.generatedAt).toLocaleString('ru-RU');

  return (
    <div className="prod-dashboard page-shell">
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          gap: '1rem',
          flexWrap: 'wrap',
        }}
      >
        <div>
          <div className="page-eyebrow">
            <Icon name="dashboard" />
            Управление производством
          </div>
          <h1 className="page-title">
            <Icon name="dashboard" />
            Дашборд начальника производства
          </h1>
          <p className="page-subtitle">
            Единый управленческий экран. KPI «сегодня» считаются по UTC-сегодня;
            график и сводки за период — за {dto.periodDays} дней
            ({formatDate(dto.dateFrom)} — {formatDate(dto.dateTo)}).
          </p>
          <div className="meta-line" style={{ marginTop: '0.4rem' }}>
            <Icon name="refresh" size={13} /> Обновлено: {generatedAtLabel}
          </div>
        </div>
        <PeriodSwitcher current={dto.periodDays} />
      </div>

      {/* 1. KPI cards ----------------------------------------------------- */}
      <section aria-label="Ключевые показатели">
        <div className="kpi-grid">
          <KpiCard
            icon="output"
            tone="ok"
            label="Выпущено сегодня"
            value={`${formatInt(kpi.producedToday)} шт`}
            sub={`${formatInt(kpi.producedPeriod)} шт за период`}
          />
          <KpiCard
            icon="pulse"
            tone="accent"
            label="В работе сейчас"
            value={`${formatInt(kpi.wipUnits)} шт`}
            sub={`${formatInt(kpi.wipPassports)} паспортов`}
          />
          <KpiCard
            icon="orders"
            label="Заказы в производстве"
            value={`${formatInt(kpi.ordersInProduction)} шт`}
          />
          <KpiCard
            icon="price"
            tone="accent"
            label="Себестоимость / шт сегодня"
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
            icon="idle"
            tone={kpi.idleCostToday > 0 ? 'danger' : undefined}
            label="Простой сегодня"
            value={`${formatMoney(kpi.idleCostToday)} ₽`}
            sub={`${formatMoney(kpi.idleCostPeriod)} ₽ за период`}
          />
          <KpiCard
            icon="dashboard"
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
      <section className="card">
        <div className="section-header">
          <h2>
            <Icon name="shopfloor" />
            Где сейчас изделия
          </h2>
          <Link href="/shopfloor" className="meta-line">
            Открыть «Цех» →
          </Link>
        </div>
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
                  {isBottleneck && <Icon name="bottleneck" />}
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
              <Icon name="error" />
              Брак (всего)
            </div>
            <div
              className="stage-card__value"
              style={{
                color: pipeline.defectQty > 0 ? 'var(--color-danger-fg)' : undefined,
              }}
            >
              {formatInt(pipeline.defectQty)}
              <span className="stage-card__value-unit">шт</span>
            </div>
          </div>
        </div>
        {pipeline.bottleneckStage && pipeline.bottleneckQty > 0 && (
          <div className="meta-line" style={{ marginTop: '0.6rem' }}>
            <Icon name="bottleneck" size={13} /> Узкое место:{' '}
            {PRODUCTION_DASHBOARD_STAGE_LABELS[pipeline.bottleneckStage]}
            {' — '}
            {formatInt(pipeline.bottleneckQty)} шт.
          </div>
        )}
      </section>

      {/* 3. Trend chart -------------------------------------------------- */}
      <section className="card">
        <div className="section-header">
          <h2>
            <Icon name="pulse" />
            Динамика по дням
          </h2>
          <span className="section-header__hint">
            Выпуск, себестоимость, простой
          </span>
        </div>
        <ProductionDashboardTrendChart days={trend} />
      </section>

      {/* 4. Role load ---------------------------------------------------- */}
      <section className="card">
        <div className="section-header">
          <h2>
            <Icon name="employees" />
            Загрузка по ролям ({formatDate(dto.dateTo)})
          </h2>
          <Link href="/production-cost" className="meta-line">
            Подробнее в «Себестоимости» →
          </Link>
        </div>
        {roleLoad.every((r) => r.employees === 0 && r.trackedMinutes === 0) ? (
          <div className="empty-state">
            <span className="empty-state__icon">
              <Icon name="info" />
            </span>
            <span className="empty-state__title">Нет данных за день</span>
            <span className="empty-state__hint">
              За {formatDate(dto.dateTo)} нет ни смен окладных сотрудников, ни
              учтённых минут.
            </span>
          </div>
        ) : (
          <table className="data-table">
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
                  <td style={{ textAlign: 'right' }}>{formatInt(r.paidMinutes)}</td>
                  <td style={{ textAlign: 'right' }}>{formatInt(r.trackedMinutes)}</td>
                  <td style={{ textAlign: 'right' }}>{formatInt(r.idleMinutes)}</td>
                  <td
                    style={{
                      textAlign: 'right',
                      color: r.idleCost > 0 ? 'var(--color-danger-fg)' : undefined,
                    }}
                  >
                    {formatMoney(r.idleCost)}
                  </td>
                  <td style={{ textAlign: 'right' }}>{r.utilization}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* 5. Alerts ------------------------------------------------------- */}
      <section className="card">
        <div className="section-header">
          <h2>
            <Icon name="warning" />
            Требует внимания
          </h2>
          {alerts.length > 0 && (
            <span className="section-header__hint">
              {alerts.length} {alerts.length === 1 ? 'алерт' : 'алертов'}
            </span>
          )}
        </div>
        {alerts.length === 0 ? (
          <div className="empty-state">
            <span className="empty-state__icon" style={{ background: 'var(--color-ok-soft)', color: 'var(--color-ok-fg)' }}>
              <Icon name="success" />
            </span>
            <span className="empty-state__title">Сегодня всё спокойно</span>
            <span className="empty-state__hint">Алертов нет.</span>
          </div>
        ) : (
          <div className="alert-stack">
            {alerts.map((a, i) => (
              <AlertRow key={`${a.type}-${i}`} {...a} />
            ))}
          </div>
        )}
      </section>

      {/* 6. Quick actions ------------------------------------------------ */}
      <section className="card">
        <div className="section-header">
          <h2>
            <Icon name="arrow-right" />
            Быстрые переходы
          </h2>
        </div>
        <div className="quick-grid">
          <QuickLink href="/shopfloor" icon="shopfloor" label="Цех" />
          <QuickLink href="/production-cost" icon="production-cost" label="Себестоимость выпуска" />
          <QuickLink href="/earnings" icon="earnings" label="Зарплата" />
          <QuickLink href="/admin/employees" icon="employees" label="Сотрудники" />
          <QuickLink href="/admin/operations" icon="operations" label="Операции" />
          <QuickLink href="/admin/warehouses" icon="warehouses" label="Склад" />
          <QuickLink href="/orders" icon="orders" label="Заказы" />
          <QuickLink href="/admin/overview" icon="overview" label="Операционный обзор" />
        </div>
      </section>
    </div>
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
          <Icon name="period" size={14} />
          {p} дней
        </Link>
      ))}
    </div>
  );
}

type KpiTone = 'ok' | 'warn' | 'danger' | 'accent';
function KpiCard({
  icon,
  label,
  value,
  sub,
  tone,
}: {
  icon: IconName;
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
          <Icon name={icon} />
        </span>
        {label}
      </div>
      <div className="kpi-card__value">{value}</div>
      {sub && <div className="kpi-card__sub">{sub}</div>}
    </div>
  );
}

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
  const severityToIcon: Record<ProductionDashboardAlertSeverity, IconName> = {
    INFO: 'info',
    WARN: 'warning',
    CRIT: 'error',
  };
  const valueLabel =
    value === undefined
      ? null
      : `${unit === '₽' ? formatMoney(value) : formatInt(value)}${unit ? ` ${unit}` : ''}`;
  const cls = `alert-row alert-row--${severityToTone[severity]}`;
  const inner = (
    <>
      <span className="alert-row__icon" aria-hidden>
        <Icon name={severityToIcon[severity]} />
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
  icon,
}: {
  href: string;
  label: string;
  icon: IconName;
}) {
  return (
    <Link className="quick-link" href={href}>
      <span className="quick-link__icon">
        <Icon name={icon} />
      </span>
      <span className="quick-link__label">{label}</span>
      <span className="quick-link__chev" aria-hidden>
        <Icon name="arrow-right" size={16} />
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
