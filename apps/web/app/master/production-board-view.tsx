'use client';

/**
 * Вкладка «Движение тиража» кабинета мастера.
 *
 * Модель — когорта по дате выдачи кроя (см.
 * `packages/shared/src/production-board.ts`,
 * `apps/api/src/modules/production-board/*`). Десктоп — матрица
 * (строка = дата кроя, колонки = операции), мобайл — аккордеон по
 * датам; переключение чисто CSS-медиазапросом (`pboard__desktop` /
 * `pboard__mobile`). Клик по ячейке → drill-down со списком паспортов.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  PRODUCTION_BOARD_RELEASED,
  type ProductionBoardCohortDto,
  type ProductionBoardDrillDto,
  type ProductionBoardDto,
  type ProductionBoardStageBucketDto,
} from '@sewing/shared';
import {
  loadProductionBoardAction,
  loadProductionBoardDrillAction,
} from './production-board-actions';

const PERIODS = [7, 14, 30] as const;

function ReconBlock({ c }: { c: ProductionBoardCohortDto }) {
  const bad = c.notPickedPassports > 0;
  return (
    <div className="pboard__recon">
      <div className="pboard__recon-line">
        <span className="pboard__muted">Выдано</span>{' '}
        <b>{c.issuedPassports} п</b> · <b>{c.issuedQty} шт</b>
      </div>
      <div
        className={
          'pboard__chip ' + (bad ? 'pboard__chip--bad' : 'pboard__chip--ok')
        }
        title={
          bad
            ? `${c.notPickedPassports} паспорт(ов) выдано, но не взято ни в одну операцию`
            : 'Все выданные паспорта взяты в операцию'
        }
      >
        {bad
          ? `⚠ ${c.notPickedPassports} не взято`
          : '✓ все взяты'}
      </div>
      <div className="pboard__recon-line">
        <span className="pboard__muted">В работе</span>{' '}
        <b>{c.inOpsPassports} п</b> · <b>{c.inOpsQty} шт</b>
      </div>
    </div>
  );
}

function StageCell({
  c,
  bucket,
  onOpen,
}: {
  c: ProductionBoardCohortDto;
  bucket: ProductionBoardStageBucketDto;
  onOpen: (issueDate: string, stage: string) => void;
}) {
  // Накопительная модель «партии на конвейере» (см.
  // `ProductionBoardStageBucketDto` shared-DTO): ячейка пуста только
  // если ни один паспорт когорты не коснулся этой колонки. Иначе
  // показываем «дошло X / выпущено Y / сейчас K». Клик → drill-down
  // с тем же списком «сейчас здесь», что и раньше (по `passports`).
  const empty = bucket.received === 0;
  const here = bucket.passports;
  const top = bucket.employees
    .slice(0, 2)
    .map((e) => `${e.employeeName.split(' ')[0]}·${e.passports}`)
    .join('  ');
  const more = bucket.employees.length - 2;
  const showDefect = bucket.code === 'QC' && bucket.defects > 0;
  if (empty) {
    return <div className="pboard__cell pboard__cell--empty">—</div>;
  }
  return (
    <button
      type="button"
      className="pboard__cell"
      onClick={() => onOpen(c.issueDate, bucket.code)}
    >
      <div className="pboard__cell-top">
        <span className="pboard__cell-received">дошло {bucket.received}</span>
        {showDefect && (
          <span className="pboard__badge-def">брак {bucket.defects}</span>
        )}
      </div>
      <div className="pboard__cell-flow">
        <span>выпущено {bucket.released}</span>
        {here > 0 && (
          <span className="pboard__muted"> · сейчас {here}</span>
        )}
      </div>
      {top && <div className="pboard__cell-emps">{top}</div>}
      {more > 0 && <div className="pboard__cell-more">ещё {more} ▾</div>}
    </button>
  );
}

function ReleasedCell({
  c,
  onOpen,
}: {
  c: ProductionBoardCohortDto;
  onOpen: (issueDate: string, stage: string) => void;
}) {
  const pct = c.issuedPassports
    ? Math.round((c.releasedPassports / c.issuedPassports) * 100)
    : 0;
  return (
    <button
      type="button"
      className="pboard__cell pboard__cell--released"
      onClick={() => onOpen(c.issueDate, PRODUCTION_BOARD_RELEASED)}
    >
      <div className="pboard__cell-top">
        {c.releasedPassports} <span className="pboard__muted">пасп</span>
      </div>
      <div className="pboard__released-qty">{c.releasedQty} шт</div>
      <div className="pboard__released-pct">{pct}% от выданного</div>
    </button>
  );
}

export function ProductionBoardView() {
  const [days, setDays] = useState<number>(14);
  const [board, setBoard] = useState<ProductionBoardDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openAcc, setOpenAcc] = useState<string | null>(null);
  const [drill, setDrill] = useState<ProductionBoardDrillDto | null>(null);
  const [drillLoading, setDrillLoading] = useState(false);

  const load = useCallback(async (d: number) => {
    setLoading(true);
    setError(null);
    const r = await loadProductionBoardAction(d);
    if (r.ok) setBoard(r.data);
    else setError(r.error);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load(days);
  }, [days, load]);

  const openDrill = useCallback(
    async (issueDate: string, stage: string) => {
      setDrillLoading(true);
      setDrill(null);
      const r = await loadProductionBoardDrillAction({ issueDate, stage });
      if (r.ok) setDrill(r.data);
      else setError(r.error);
      setDrillLoading(false);
    },
    [],
  );

  return (
    <div className="pboard">
      <div className="pboard__bar">
        <span className="pboard__muted">Период выдачи:</span>
        {PERIODS.map((p) => (
          <button
            key={p}
            type="button"
            className={
              'pboard__period' + (p === days ? ' is-active' : '')
            }
            onClick={() => setDays(p)}
          >
            {p} дн
          </button>
        ))}
        <button
          type="button"
          className="pboard__refresh"
          onClick={() => void load(days)}
          disabled={loading}
        >
          {loading ? 'Загрузка…' : '⟳ Обновить'}
        </button>
      </div>

      {error && (
        <div className="master-page__error" role="alert">
          {error}
        </div>
      )}

      {!error && board && board.cohorts.length === 0 && (
        <div className="master-page__empty">
          <p>За выбранный период выдачи кроя нет</p>
        </div>
      )}

      {board && board.cohorts.length > 0 && (
        <>
          {/* ===== Десктоп: матрица ===== */}
          <div className="pboard__desktop">
            <table className="pboard__table">
              <thead>
                <tr>
                  <th className="pboard__rowhead">Дата выдачи</th>
                  {board.stages.map((s) => (
                    <th key={s.code}>
                      {s.label}
                      {s.code === 'QC' && (
                        <span className="pboard__muted"> (брак)</span>
                      )}
                    </th>
                  ))}
                  <th className="pboard__th-released">Выпущено</th>
                </tr>
              </thead>
              <tbody>
                {board.cohorts.map((c) => (
                  <tr key={c.issueDate}>
                    <td className="pboard__rowhead">
                      <div className="pboard__date">{c.issueDate}</div>
                      <div className="pboard__order">{c.orderLabel}</div>
                      <ReconBlock c={c} />
                    </td>
                    {c.stages.map((b) => (
                      <td key={b.code}>
                        <StageCell c={c} bucket={b} onOpen={openDrill} />
                      </td>
                    ))}
                    <td>
                      <ReleasedCell c={c} onOpen={openDrill} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* ===== Мобайл: аккордеон ===== */}
          <div className="pboard__mobile">
            {board.cohorts.map((c) => {
              const isOpen = openAcc === c.issueDate;
              return (
                <div key={c.issueDate} className="pboard__acc">
                  <button
                    type="button"
                    className="pboard__acc-head"
                    onClick={() =>
                      setOpenAcc(isOpen ? null : c.issueDate)
                    }
                    aria-expanded={isOpen}
                  >
                    <div>
                      <div className="pboard__date">{c.issueDate}</div>
                      <div className="pboard__order">{c.orderLabel}</div>
                      <ReconBlock c={c} />
                    </div>
                    <span className="pboard__caret">
                      {isOpen ? '▾' : '▸'}
                    </span>
                  </button>
                  {isOpen && (
                    <div className="pboard__acc-body">
                      {c.stages.map((b) => (
                        <div key={b.code} className="pboard__stagecard">
                          <div className="pboard__stagecard-h">
                            <span>
                              {board.stages.find(
                                (s) => s.code === b.code,
                              )?.label ?? b.code}
                            </span>
                          </div>
                          <StageCell
                            c={c}
                            bucket={b}
                            onOpen={openDrill}
                          />
                        </div>
                      ))}
                      <div className="pboard__stagecard pboard__stagecard--released">
                        <div className="pboard__stagecard-h">
                          <span>Выпущено</span>
                          <span className="pboard__released-strong">
                            {c.releasedPassports} пасп · {c.releasedQty}{' '}
                            шт
                          </span>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}

      {(drill || drillLoading) && (
        <div
          className="pboard__overlay"
          onClick={() => {
            setDrill(null);
            setDrillLoading(false);
          }}
        >
          <div
            className="pboard__panel"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="pboard__panel-head">
              <div>
                <div className="pboard__panel-title">
                  {drill
                    ? `${drill.stageLabel} · ${drill.issueDate}`
                    : 'Загрузка…'}
                </div>
                {drill && (
                  <div className="pboard__panel-sub">
                    {drill.totalPassports} пасп · {drill.totalQty} шт
                    {drill.totalDefects > 0 &&
                      ` · брак ${drill.totalDefects}`}
                  </div>
                )}
              </div>
              <button
                type="button"
                className="pboard__x"
                onClick={() => {
                  setDrill(null);
                  setDrillLoading(false);
                }}
              >
                ✕
              </button>
            </div>
            <div className="pboard__panel-body">
              {drillLoading && (
                <div className="pboard__muted">Загрузка…</div>
              )}
              {drill &&
                drill.groups.map((g) => (
                  <div key={g.employeeId ?? g.employeeName} className="pboard__emp-sec">
                    <div className="pboard__emp-sec-h">
                      <span>{g.employeeName}</span>
                      <span className="pboard__muted">
                        {g.passports} пасп · <b>{g.qty} шт</b>
                        {g.defects > 0 && (
                          <span className="pboard__def-text">
                            {' '}
                            · брак {g.defects}
                          </span>
                        )}
                      </span>
                    </div>
                    {g.rows.map((r) => (
                      <div key={r.passportId} className="pboard__pp">
                        <span>
                          <span className="pboard__qty">{r.qty} шт</span>
                          <b>{r.number}</b>{' '}
                          <span className="pboard__muted">
                            разм {r.sizeCode}
                          </span>
                          {r.defects > 0 && (
                            <span className="pboard__badge-def">
                              брак {r.defects}
                            </span>
                          )}
                        </span>
                      </div>
                    ))}
                  </div>
                ))}
              {drill && drill.groups.length === 0 && (
                <div className="master-page__empty">
                  <p>Паспортов нет</p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
