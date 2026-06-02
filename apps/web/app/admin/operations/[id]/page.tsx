import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, Calculator, Scissors } from 'lucide-react';
import { ApiRequestError } from '@/lib/api';
import { getCurrentUserOrNull } from '@/lib/auth-api';
import { getOperation, getOperationBlockers } from '@/lib/operations-api';
import {
  AdminCard,
  AdminPageShell,
  AdminSectionHeader,
  AdminStatusBadge,
} from '@/components/admin';
import {
  formatOperationCategory,
  formatStatus,
  statusTone,
} from '@/lib/admin-labels';
import { formatDuration } from '@/lib/operations-time-norm';
import {
  calculateOperationDailyEconomics,
  calculateSalaryPlanEconomics,
  formatCostPerUnit,
  formatEarningsPerDay,
  formatUnitsPerDay,
  groupOperationEconomicsRows,
  type OperationEconomicsSizeRow,
} from '@/lib/operation-economics';
import type { OperationDetailDto } from '@sewing/shared/operations';
import { OperationEditForm } from './edit-form';
import { OperationDangerZone } from './delete-operation';

export const dynamic = 'force-dynamic';

interface Params {
  params: { id: string };
}

/**
 * Карточка операции (Admin UI 2.5, см. ADR-0020).
 *
 * Backend / DTO не меняем. UI приведён к компактному двухколоночному
 * layout-у:
 *   - `AdminPageShell` сверху;
 *   - левая колонка — карточка «Основная информация» с формой
 *     (`OperationEditForm`) — все секции тарифа / нормы времени и кнопка
 *     «Сохранить» внутри;
 *   - правая колонка — карточка «Экономика операции» с плановым расчётом
 *     выработки и заработка за 8-часовую смену (см.
 *     `lib/operation-economics.ts`). Это **только справочный расчёт**:
 *     payroll / SalaryEntry / OperationEntry он не подменяет.
 *
 * Старая правая колонка с технической информацией (ID / code / enums)
 * удалена — она почти не несла ценности и забирала место под более
 * полезный блок экономики. Сам компонент-обёртка остаётся в проекте и
 * используется на других detail-страницах (`/admin/employees/[id]`,
 * `/admin/equipment/[id]`, …) — здесь он просто не импортируется.
 *
 * Дублирующая широкая карточка «Экономика операции» под grid'ом тоже
 * убрана: блок теперь отображается ровно один раз — в правой колонке.
 */
export default async function AdminOperationDetailPage({ params }: Params) {
  let operation;
  try {
    operation = await getOperation(params.id);
  } catch (e) {
    if (e instanceof ApiRequestError && e.statusCode === 404) {
      notFound();
    }
    throw e;
  }

  // Опасная зона (физическое удаление) — preflight блокеров и роль
  // viewer'а. Роль нужна, чтобы скрыть/задизейблить удаление для
  // не-ADMIN (backend всё равно вернёт 403). Если preflight упал —
  // зону просто не показываем, карточка остаётся рабочей.
  const [me, blockers] = await Promise.all([
    getCurrentUserOrNull(),
    getOperationBlockers(params.id).catch(() => null),
  ]);

  return (
    <AdminPageShell
      icon={<Scissors size={22} strokeWidth={1.6} aria-hidden />}
      title={operation.name}
      subtitle={formatOperationCategory(operation.category)}
      actions={
        <>
          <Link href="/admin/operations" className="admin-btn admin-btn--ghost">
            <ArrowLeft size={16} strokeWidth={1.6} aria-hidden />
            К списку
          </Link>
          <AdminStatusBadge tone={statusTone(operation.isActive)}>
            {formatStatus(operation.isActive)}
          </AdminStatusBadge>
        </>
      }
    >
      <div className="admin-grid-2">
        <AdminCard>
          <AdminSectionHeader title="Основная информация" />
          <OperationEditForm operation={operation} />
        </AdminCard>

        <AdminCard>
          <AdminSectionHeader
            icon={<Calculator size={18} strokeWidth={1.6} aria-hidden />}
            title="Экономика операции"
            hint={
              <span className="admin-muted">
                Плановая оценка за 8-часовую смену
              </span>
            }
          />
          <OperationEconomicsBlock operation={operation} />
        </AdminCard>
      </div>

      {blockers && (
        <AdminCard>
          <OperationDangerZone
            operation={operation}
            blockers={blockers}
            viewerRole={me?.user.role ?? ''}
          />
        </AdminCard>
      )}
    </AdminPageShell>
  );
}

/**
 * Тело секции «Экономика операции».
 *
 * Логика расчёта не менялась — она целиком живёт в
 * `lib/operation-economics.ts` (`calculateOperationDailyEconomics`).
 * Здесь только presentation:
 *   - `pricingMode = SALARY_ONLY` ⇒ только пояснение, что заработок
 *     за 8 часов не считается (норма времени — отдельная ось и может
 *     быть задана, но это не превращает операцию в сдельную);
 *   - `pricingMode = FIXED` и `timeNormMode = FIXED` ⇒ компактные
 *     4 строки: ставка / норма / выработка за 8 часов / заработок за
 *     8 часов;
 *   - иначе (`BY_SIZE` хотя бы по одной из осей) ⇒ компактные
 *     карточки-группы (по одной на набор размеров с одинаковой
 *     ставкой / нормой / выработкой / заработком). Раньше здесь
 *     выводилась широкая таблица по каждому размеру — она не
 *     помещалась в правую колонку и часто содержала 21 одинаковую
 *     строку. Группировка делается helper-ом
 *     `groupOperationEconomicsRows`.
 *
 * Если для конкретного размера ставка или норма не заданы — показываем
 * «Ставка не задана» / «Норма времени не задана» и не считаем то, чего
 * посчитать нельзя. Размеры без ставки/нормы естественно собираются в
 * отдельную группу (за счёт ключа группировки).
 */
function OperationEconomicsBlock({
  operation,
}: {
  operation: OperationDetailDto;
}) {
  if (operation.pricingMode === 'SALARY_ONLY') {
    return (
      <SalaryOnlyEconomicsBlock operation={operation} />
    );
  }

  const isFixedRate = operation.pricingMode === 'FIXED';
  const isFixedNorm = operation.timeNormMode === 'FIXED';

  if (isFixedRate && isFixedNorm) {
    const econ = calculateOperationDailyEconomics({
      rateRub: operation.fixedRate,
      timeNormSec: operation.timeNormSec,
    });
    return (
      <dl className="admin-tech-info" style={{ display: 'block', margin: 0 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16 }}>
          <dt className="admin-muted">Ставка за единицу</dt>
          <dd>
            {operation.fixedRate !== null
              ? `${operation.fixedRate.toFixed(2)} \u20BD`
              : <span className="admin-muted">Ставка не задана</span>}
          </dd>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16 }}>
          <dt className="admin-muted">Норма времени</dt>
          <dd>
            {operation.timeNormSec !== null && operation.timeNormSec > 0 ? (
              formatDuration(operation.timeNormSec)
            ) : (
              <span className="admin-muted">Норма времени не задана</span>
            )}
          </dd>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16 }}>
          <dt className="admin-muted">Ожидаемая выработка за 8 часов</dt>
          <dd>
            {econ.unitsPerDay !== null ? (
              <strong>{formatUnitsPerDay(econ.unitsPerDay)} шт</strong>
            ) : (
              <span className="admin-muted">—</span>
            )}
          </dd>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16 }}>
          <dt className="admin-muted">Ожидаемый заработок за 8 часов</dt>
          <dd>
            {econ.earningsPerDayRub !== null ? (
              <strong>{formatEarningsPerDay(econ.earningsPerDayRub)}</strong>
            ) : (
              <span className="admin-muted">—</span>
            )}
          </dd>
        </div>
      </dl>
    );
  }

  // BY_SIZE по одной из осей — компактные карточки-группы по размерам.
  if (operation.sizes.length === 0) {
    return (
      <p className="admin-muted" style={{ margin: 0 }}>
        В справочнике размеров нет строк — добавьте размеры, чтобы
        рассчитать экономику операции.
      </p>
    );
  }

  const ratesBySize = new Map<string, number>();
  for (const r of operation.ratesBySize) ratesBySize.set(r.sizeId, r.rate);
  const normsBySize = new Map<string, number>();
  for (const r of operation.timeNormsBySize) normsBySize.set(r.sizeId, r.seconds);

  const rows: OperationEconomicsSizeRow[] = operation.sizes.map((s) => {
    const rate = isFixedRate
      ? operation.fixedRate
      : (ratesBySize.get(s.id) ?? null);
    const norm = isFixedNorm
      ? operation.timeNormSec
      : (normsBySize.get(s.id) ?? null);
    const econ = calculateOperationDailyEconomics({
      rateRub: rate,
      timeNormSec: norm,
    });
    return {
      sizeId: s.id,
      sizeCode: s.code,
      sizeSortOrder: s.sortOrder,
      rateRub: rate,
      timeNormSec: norm,
      unitsPerDay: econ.unitsPerDay,
      earningsPerDayRub: econ.earningsPerDayRub,
    };
  });

  const groups = groupOperationEconomicsRows(rows);

  return (
    <div className="operation-economics-groups">
      {groups.map((g) => {
        const key = g.sizes.map((s) => s.sizeId).join('|');
        return (
          <div key={key} className="operation-economics-group">
            <div
              className="operation-economics-group__sizes"
              title={g.sizeTitle}
            >
              {g.sizeLabel}
            </div>
            <div className="operation-economics-group__metrics">
              <div className="operation-economics-group__metric">
                <span className="operation-economics-group__label">
                  Ставка
                </span>
                <span className="operation-economics-group__value">
                  {g.rateRub !== null ? (
                    `${g.rateRub.toFixed(2)} \u20BD`
                  ) : (
                    <span className="admin-muted">Ставка не задана</span>
                  )}
                </span>
              </div>
              <div className="operation-economics-group__metric">
                <span className="operation-economics-group__label">
                  Норма
                </span>
                <span className="operation-economics-group__value">
                  {g.timeNormSec !== null && g.timeNormSec > 0 ? (
                    formatDuration(g.timeNormSec)
                  ) : (
                    <span className="admin-muted">
                      Норма времени не задана
                    </span>
                  )}
                </span>
              </div>
              <div className="operation-economics-group__metric">
                <span className="operation-economics-group__label">8ч</span>
                <span className="operation-economics-group__value">
                  {g.unitsPerDay !== null ? (
                    <>{formatUnitsPerDay(g.unitsPerDay)} шт</>
                  ) : (
                    <span className="admin-muted">—</span>
                  )}
                </span>
              </div>
              <div className="operation-economics-group__metric">
                <span className="operation-economics-group__label">Доход</span>
                <span className="operation-economics-group__value">
                  {g.earningsPerDayRub !== null ? (
                    formatEarningsPerDay(g.earningsPerDayRub)
                  ) : (
                    <span className="admin-muted">—</span>
                  )}
                </span>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Секция «Экономика операции» для `pricingMode = SALARY_ONLY`.
 *
 * Показывает плановую окладную стоимость операции:
 *   - норма времени;
 *   - плановая стоимость смены (`salaryPlanRubPerShift`);
 *   - стоимость на изделие = смена / выработка за смену;
 *   - выработка за смену = `salaryPlanShiftSeconds` / `timeNormSec`.
 *
 * Это **только справочный расчёт** — payroll / `SalaryEntry` /
 * `OperationEntry` / `Employee.salaryPerShift` он не подменяет.
 * Та же формула используется в `OrderOperationPlanService` для
 * расчёта плановой себестоимости окладных операций в плане заказа
 * (см. ТЗ «Плановая стоимость окладных операций»).
 *
 * Если плановая ставка не задана — рисуем подсказку «Плановая
 * окладная ставка не задана» (норму времени всё равно показываем,
 * если она есть).
 */
function SalaryOnlyEconomicsBlock({
  operation,
}: {
  operation: OperationDetailDto;
}) {
  const econ = calculateSalaryPlanEconomics({
    salaryPlanRubPerShift: operation.salaryPlanRubPerShift,
    salaryPlanShiftSeconds: operation.salaryPlanShiftSeconds,
    timeNormSec: operation.timeNormSec,
  });
  const hours = econ.effectiveShiftSeconds / 3600;
  const hoursLabel = Number.isInteger(hours) ? `${hours}` : hours.toFixed(2);

  return (
    <dl className="admin-tech-info" style={{ display: 'block', margin: 0 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16 }}>
        <dt className="admin-muted">Норма времени</dt>
        <dd>
          {operation.timeNormSec !== null && operation.timeNormSec > 0 ? (
            formatDuration(operation.timeNormSec)
          ) : operation.timeNormMode === 'BY_SIZE' ? (
            <span className="admin-muted">По размерам</span>
          ) : (
            <span className="admin-muted">Норма времени не задана</span>
          )}
        </dd>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16 }}>
        <dt className="admin-muted">Плановая стоимость смены</dt>
        <dd>
          {operation.salaryPlanRubPerShift !== null ? (
            <strong>
              {formatEarningsPerDay(operation.salaryPlanRubPerShift)}
              <span className="admin-muted" style={{ fontWeight: 400 }}>
                {' '}
                / {hoursLabel}ч
              </span>
            </strong>
          ) : (
            <span className="admin-muted">
              Плановая окладная ставка не задана
            </span>
          )}
        </dd>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16 }}>
        <dt className="admin-muted">Стоимость на изделие</dt>
        <dd>
          {econ.costPerUnitRub !== null ? (
            <strong>{formatCostPerUnit(econ.costPerUnitRub)}</strong>
          ) : (
            <span className="admin-muted">—</span>
          )}
        </dd>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16 }}>
        <dt className="admin-muted">Выработка за смену</dt>
        <dd>
          {econ.unitsPerShift !== null ? (
            <strong>{formatUnitsPerDay(econ.unitsPerShift)} шт</strong>
          ) : (
            <span className="admin-muted">—</span>
          )}
        </dd>
      </div>
      {operation.salaryPlanRubPerShift === null && (
        <p
          className="admin-muted"
          style={{ marginTop: '0.5rem', fontSize: '0.85rem' }}
        >
          Задайте плановую стоимость смены в форме слева, чтобы
          посчитать плановую себестоимость окладной операции.
          Фактическая зарплата сотрудников при этом не меняется.
        </p>
      )}
    </dl>
  );
}
