'use client';

/**
 * Объединённая матрица «операции · сотрудники · размеры» внутри одного
 * лекала (вкладка «По номенклатуре» отчёта `/admin/production-cost`).
 *
 * Склеивает три исторических разреза в один:
 *
 *   - строки — операции; **и сдельные, и окладные раскрываются в
 *     сотрудников** (chevron). Сдельные (PIECEWORK) считают `qty`/`за 1
 *     ед.`; окладные (SALARY: ОТК/ВТО/Упаковка/Деление кроя) берут ₽ из
 *     разнесённого времени и не имеют сдельного `qty` (там «—»);
 *   - колонки — размеры; в ячейках ₽ начислений/оклада **или** количество
 *     (переключатель ₽/шт);
 *   - правый блок — Кол-во / Сумма / За 1 ед. по строке;
 *   - футер — «Итого» по колонкам и отдельная строка «Выпущено, шт»
 *     (`Passport.qtyGood`, PACKED — другая метрика, не qty операций).
 *
 * Данные приходят готовыми из бэка
 * (`ProductionCostNomenclatureGroupDto.operationMatrix` / `sizeColumns`),
 * компонент только рендерит + держит локальный UI-стейт (режим ячеек,
 * раскрытие операций). Стили — `.cost-matrix*` в `globals.css`
 * (компактные, со скроллом и прилипающей первой колонкой).
 */
import { Fragment, useState } from 'react';
import { ChevronDown, ChevronRight, Coins, Hash } from 'lucide-react';
import type {
  ProductionCostMatrixCellDto,
  ProductionCostMatrixOperationRowDto,
  ProductionCostMatrixSizeColumnDto,
} from '@sewing/shared/production-cost';
import { AdminSectionHeader } from '@/components/admin';

type CellMode = 'rub' | 'qty';

interface OperationSizeMatrixProps {
  nomenclatureName: string | null;
  nomenclatureArticle: string | null;
  sizeColumns: ProductionCostMatrixSizeColumnDto[];
  operationMatrix: ProductionCostMatrixOperationRowDto[];
}

function formatMoney(value: string | number | null): string {
  if (value === null || value === undefined) return '—';
  const num = typeof value === 'string' ? Number(value) : value;
  if (!Number.isFinite(num)) return '—';
  return num.toLocaleString('ru-RU', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatQty(value: number | null): string {
  if (value === null || value === undefined) return '—';
  return value.toLocaleString('ru-RU');
}

/**
 * «Кол-во» окладной строки = разнесённое реальное время (мин). Те же
 * данные, что в табе «Операции / сотрудники» (колонка «Время, мин»).
 */
function formatMinutes(value: number | null): string {
  if (!value) return '—';
  return `${value.toLocaleString('ru-RU')} мин`;
}

/**
 * «За 1 ед.» окладной строки = ₽/мин (`rub / minutes`), как в табе
 * «Операции / сотрудники» (колонка «₽ / мин»).
 */
function formatRubPerMinute(rub: string, minutes: number): string {
  if (!minutes) return '—';
  const perMin = Number(rub) / minutes;
  if (!Number.isFinite(perMin)) return '—';
  return `${formatMoney(perMin)} ₽/мин`;
}

function cellText(cell: ProductionCostMatrixCellDto, mode: CellMode): string {
  if (mode === 'rub') {
    const num = Number(cell.rub);
    return num ? formatMoney(cell.rub) : '—';
  }
  return cell.qty ? formatQty(cell.qty) : '—';
}

export function OperationSizeMatrix({
  nomenclatureName,
  nomenclatureArticle,
  sizeColumns,
  operationMatrix,
}: OperationSizeMatrixProps) {
  const [mode, setMode] = useState<CellMode>('rub');
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const toggle = (key: string) =>
    setExpanded((prev) => ({ ...prev, [key]: !prev[key] }));

  const hasData = operationMatrix.length > 0 || sizeColumns.length > 0;

  const colSums = sizeColumns.map((_, i) =>
    operationMatrix.reduce((acc, op) => {
      const c = op.cells[i];
      if (!c) return acc;
      return acc + (mode === 'rub' ? Number(c.rub) : c.qty);
    }, 0),
  );
  const totalQty = operationMatrix.reduce((acc, op) => acc + op.qty, 0);
  const totalRub = operationMatrix.reduce(
    (acc, op) => acc + Number(op.rub),
    0,
  );
  const totalReleased = sizeColumns.reduce((acc, s) => acc + s.releasedQty, 0);

  return (
    <div style={{ marginTop: 16 }}>
      <AdminSectionHeader
        title={`${nomenclatureName ?? '—'} · разрез`}
        hint={nomenclatureArticle ? `Артикул: ${nomenclatureArticle}` : undefined}
        actions={
          <div
            role="group"
            aria-label="Что показывать в ячейках по размерам"
            style={{ display: 'inline-flex', gap: 4 }}
          >
            <ModeButton
              active={mode === 'rub'}
              onClick={() => setMode('rub')}
              Icon={Coins}
              label="₽"
            />
            <ModeButton
              active={mode === 'qty'}
              onClick={() => setMode('qty')}
              Icon={Hash}
              label="шт"
            />
          </div>
        }
      />
      <div
        style={{ fontSize: 12, color: 'var(--admin-muted)', marginBottom: 8 }}
      >
        Строки — операции (раскрываются в сотрудников; окладные помечены
        «оклад»). В ячейках по размерам —{' '}
        {mode === 'rub' ? 'сумма, ₽' : 'количество, шт'}. У окладных операций
        «Кол-во» — это разнесённое время (мин), «За 1 ед.» — ₽/мин (как в табе
        «Операции / сотрудники»). «Выпущено» — годные упакованные единицы
        (PACKED), отдельная от выработки метрика.
      </div>

      {!hasData ? (
        <div style={{ color: 'var(--admin-muted)' }}>—</div>
      ) : (
        <div className="cost-matrix-wrap">
          <table className="cost-matrix">
            <thead>
              <tr>
                <th className="cost-matrix__sticky">Операция / Сотрудник</th>
                {sizeColumns.map((s) => (
                  <th
                    key={s.sizeId ?? s.sizeCode}
                    className="cost-matrix__num"
                  >
                    {s.sizeCode}
                  </th>
                ))}
                <th className="cost-matrix__num">Кол-во</th>
                <th className="cost-matrix__num">Сумма, ₽</th>
                <th className="cost-matrix__num">За 1 ед.</th>
              </tr>
            </thead>
            <tbody>
              {operationMatrix.map((op) => {
                const key = `${op.kind}:${op.operationId}`;
                const isOpen = expanded[key] ?? false;
                const hasEmployees = op.employees.length > 0;
                const isSalary = op.kind === 'SALARY';
                return (
                  <Fragment key={key}>
                    <tr>
                      <td className="cost-matrix__sticky">
                        <button
                          type="button"
                          onClick={hasEmployees ? () => toggle(key) : undefined}
                          aria-expanded={hasEmployees ? isOpen : undefined}
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 6,
                            background: 'none',
                            border: 'none',
                            padding: 0,
                            font: 'inherit',
                            color: 'inherit',
                            cursor: hasEmployees ? 'pointer' : 'default',
                            textAlign: 'left',
                          }}
                        >
                          {hasEmployees ? (
                            isOpen ? (
                              <ChevronDown size={14} strokeWidth={1.6} aria-hidden />
                            ) : (
                              <ChevronRight size={14} strokeWidth={1.6} aria-hidden />
                            )
                          ) : (
                            <span
                              style={{ display: 'inline-block', width: 14 }}
                              aria-hidden
                            />
                          )}
                          <strong>{op.operationName}</strong>
                          {isSalary && (
                            <span
                              style={{
                                fontSize: 11,
                                fontWeight: 600,
                                color: 'var(--admin-muted)',
                                border: '1px solid var(--admin-border)',
                                borderRadius: 4,
                                padding: '0 4px',
                              }}
                            >
                              оклад
                            </span>
                          )}
                        </button>
                      </td>
                      {op.cells.map((c, i) => (
                        <td key={i} className="cost-matrix__num">
                          {cellText(c, mode)}
                        </td>
                      ))}
                      <td className="cost-matrix__num">
                        {isSalary
                          ? formatMinutes(op.minutes)
                          : formatQty(op.qty)}
                      </td>
                      <td className="cost-matrix__num">
                        <strong>{formatMoney(op.rub)}</strong>
                      </td>
                      <td className="cost-matrix__num">
                        {isSalary
                          ? formatRubPerMinute(op.rub, op.minutes)
                          : op.unitCostAvg
                            ? formatMoney(op.unitCostAvg)
                            : '—'}
                      </td>
                    </tr>
                    {isOpen &&
                      op.employees.map((emp) => (
                        <tr key={emp.employeeId}>
                          <td
                            className="cost-matrix__sticky"
                            style={{
                              paddingLeft: 32,
                              color: 'var(--admin-muted)',
                            }}
                          >
                            {emp.employeeName}
                          </td>
                          {emp.cells.map((c, i) => (
                            <td key={i} className="cost-matrix__num">
                              {cellText(c, mode)}
                            </td>
                          ))}
                          <td className="cost-matrix__num">
                            {isSalary
                              ? formatMinutes(emp.minutes)
                              : formatQty(emp.qty)}
                          </td>
                          <td className="cost-matrix__num">
                            {formatMoney(emp.rub)}
                          </td>
                          <td className="cost-matrix__num">
                            {isSalary
                              ? formatRubPerMinute(emp.rub, emp.minutes)
                              : emp.unitCostAvg
                                ? formatMoney(emp.unitCostAvg)
                                : '—'}
                          </td>
                        </tr>
                      ))}
                  </Fragment>
                );
              })}
            </tbody>
            <tfoot>
              <tr>
                <td className="cost-matrix__sticky">
                  <strong>
                    {mode === 'rub' ? 'Итого операции, ₽' : 'Итого операции, шт'}
                  </strong>
                </td>
                {colSums.map((sum, i) => (
                  <td key={i} className="cost-matrix__num">
                    {sum
                      ? mode === 'rub'
                        ? formatMoney(sum)
                        : formatQty(sum)
                      : '—'}
                  </td>
                ))}
                <td className="cost-matrix__num">{formatQty(totalQty)}</td>
                <td className="cost-matrix__num">
                  <strong>{formatMoney(totalRub)}</strong>
                </td>
                <td className="cost-matrix__num">—</td>
              </tr>
              <tr>
                <td className="cost-matrix__sticky">Выпущено, шт</td>
                {sizeColumns.map((s, i) => (
                  <td key={i} className="cost-matrix__num">
                    {s.releasedQty ? formatQty(s.releasedQty) : '—'}
                  </td>
                ))}
                <td className="cost-matrix__num">
                  <strong>{formatQty(totalReleased)}</strong>
                </td>
                <td className="cost-matrix__num">—</td>
                <td className="cost-matrix__num">—</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  );
}

function ModeButton({
  active,
  onClick,
  Icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  Icon: typeof Coins;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`admin-btn ${active ? 'admin-btn--primary' : 'admin-btn--ghost'}`}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        padding: '4px 10px',
        fontSize: 12,
      }}
    >
      <Icon size={13} strokeWidth={1.6} aria-hidden />
      {label}
    </button>
  );
}
