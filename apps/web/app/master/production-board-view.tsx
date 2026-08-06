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

// Состояние «таблица растянута на всю ширину экрана» (только десктоп).
// `.master-page` фиксирован на 720px, поэтому матрица «движение тиража»
// в обычном режиме скроллится горизонтально. На больших мониторах мастер
// просил иметь возможность раскрывать её на всю ширину — переключатель
// рядом с «⟳ Обновить», состояние помнится между сессиями.
const EXPANDED_LS_KEY = 'master.pboard.expanded.v1';

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
  // Топ-2 сотрудников: active (синий) и released (зелёный) идут одним
  // списком, но каждая запись — отдельная плашка с собственным стилем.
  // Бэк уже сортирует: сначала active по убыванию, потом released.
  const topEmps = bucket.employees.slice(0, 2);
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
        <span className="pboard__cell-released-num">
          выпущено {bucket.released}
        </span>
        {here > 0 && (
          <span className="pboard__cell-here-num"> · сейчас {here}</span>
        )}
      </div>
      {topEmps.length > 0 && (
        <div className="pboard__cell-emps">
          {topEmps.map((e, i) => {
            const shortName =
              e.employeeId === ''
                ? 'буфер'
                : e.employeeName.split(' ')[0] || e.employeeName;
            return (
              <span
                key={`${e.employeeId || 'none'}:${e.released ? 'r' : 'a'}:${i}`}
                className={
                  'pboard__emp-chip' +
                  (e.released ? ' pboard__emp-chip--released' : '')
                }
              >
                {e.released && '✔ '}
                {shortName}·{e.passports}
              </span>
            );
          })}
        </div>
      )}
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
  const [expanded, setExpanded] = useState(false);

  // Читаем сохранённое состояние «растянуть» из localStorage уже после
  // монтирования, чтобы не ломать гидрацию (server render всегда стартует
  // в обычном режиме).
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      if (window.localStorage.getItem(EXPANDED_LS_KEY) === '1') {
        setExpanded(true);
      }
    } catch {
      /* приватный режим/квота — молча игнорируем */
    }
  }, []);

  const toggleExpanded = useCallback(() => {
    setExpanded((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(EXPANDED_LS_KEY, next ? '1' : '0');
      } catch {
        /* приватный режим/квота — состояние сохраняется только в сессии */
      }
      return next;
    });
  }, []);

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

  // Видимые колонки десктоп-матрицы: колонки доски — объединение
  // маршрутов ВСЕХ заказов окна, поэтому колонку прячем целиком, только
  // если она не в маршруте НИ у одной когорты (`inRoute === false` во
  // всех бакетах; отсутствие поля = старый API = видима). ВАЖНО: шапку
  // и ячейки строк фильтровать ОДНИМ этим Set-ом, иначе поедет
  // выравнивание колонок.
  const visibleStageCodes = new Set<string>();
  if (board) {
    for (const c of board.cohorts) {
      for (const b of c.stages) {
        if (b.inRoute !== false) visibleStageCodes.add(b.code);
      }
    }
  }

  return (
    <div className={'pboard' + (expanded ? ' pboard--wide' : '')}>
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
        <button
          type="button"
          className="pboard__expand"
          onClick={toggleExpanded}
          aria-pressed={expanded}
          title={
            expanded
              ? 'Свернуть таблицу до обычной ширины'
              : 'Растянуть таблицу на всю ширину экрана'
          }
        >
          {expanded ? '⇔ Свернуть' : '⇔ Растянуть'}
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
                  {board.stages
                    .filter((s) => visibleStageCodes.has(s.code))
                    .map((s) => (
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
                    {c.stages
                      .filter((b) => visibleStageCodes.has(b.code))
                      .map((b) =>
                        // Колонка видима из-за другой когорты, а у этой
                        // операции в маршруте нет — нейтральная ячейка
                        // вместо «—», чтобы мастер отличал «не наш шаг»
                        // от «сюда ещё не дошло».
                        b.inRoute === false ? (
                          <td key={b.code}>
                            <div
                              className="pboard__cell pboard__cell--na"
                              title="Операции нет в маршруте заказов этой даты"
                            >
                              ·
                            </div>
                          </td>
                        ) : (
                          <td key={b.code}>
                            <StageCell c={c} bucket={b} onOpen={openDrill} />
                          </td>
                        ),
                      )}
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
                      {/* Фантомные карточки (операция из маршрута заказа
                          другой даты) в аккордеон не попадают вовсе. */}
                      {c.stages
                        .filter((b) => b.inRoute !== false)
                        .map((b) => (
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
                  <div
                    key={
                      (g.employeeId ?? g.employeeName) +
                      (g.released ? ':r' : ':a')
                    }
                    className={
                      'pboard__emp-sec' +
                      (g.released ? ' pboard__emp-sec--released' : '')
                    }
                  >
                    <div className="pboard__emp-sec-h">
                      <span>
                        {g.released && '✔ '}
                        {g.employeeName}
                      </span>
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
