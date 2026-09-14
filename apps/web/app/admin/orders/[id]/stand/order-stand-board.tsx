'use client';

/**
 * Клиентская доска «Схема стенда» по заказу (см. `page.tsx`).
 *
 * Рисует букву «П» из реального маршрута заказа:
 *   - левая нога (снизу вверх): 1 Заказ → 2 Расчёт → 3 Материал;
 *   - перекладина: 4 Раскрой → шаги маршрута кроме упаковки;
 *   - правая нога (сверху вниз): шаг упаковки → «Заказ готов»;
 *   - в центре: стеллаж (ячейки с QR) и паспорта заказа.
 * Сетка: `--ostand-cols = 2 + число шагов перекладины`; при < 1100px
 * блоки складываются столбиком по номерам (см. globals.css `.ostand`).
 *
 * Данные: `GET /api/orders/:id/stand` — поллинг раз в 5 с (recursive
 * `setTimeout`, пауза на скрытой вкладке), как у `/shopfloor/display`,
 * только проще: одна страница — один заказ, без backoff-гимнастики.
 * Первый срез приходит с сервера (`initial`) — страница сразу
 * заполнена, без пустого кадра.
 *
 * QR — только через `QrCodeView` (единый рендерер, см. smoke-тест
 * `qr-rendering-regression`). Payload'ы приходят с backend в штатных
 * форматах ADR-0008 и не собираются на клиенте.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  OrderStandDto,
  OrderStandPassportDto,
  OrderStandStepDto,
  OrderStandWorkplaceDto,
} from '@sewing/shared/order-stand';
import { ORDER_STAND_PLACE_LABELS } from '@sewing/shared/order-stand';
import { CUT_READINESS_STATUS_LABELS } from '@sewing/shared/cut-readiness';
import { CUTTING_TASK_STATUS_LABELS } from '@sewing/shared/cutting-tasks';
import type { CuttingTaskStatus } from '@sewing/shared/cutting-tasks';
import { ORDER_STATUS_LABELS } from '@sewing/shared/orders';
import type { OrderStatus } from '@sewing/shared/orders';
import { getApiBaseUrl } from '@/lib/api-base';
import { QrCodeView } from '@/components/qr/qr-code-view';

const POLL_MS = 5000;
const MSK = 'Europe/Moscow';

// Путь дублирован из `lib/order-stand-api.ts` намеренно: тот модуль тянет
// `next/headers` (server-only) и в клиентский бандл попадать не должен.
const standPath = (orderId: string) => `/orders/${encodeURIComponent(orderId)}/stand`;

interface Props {
  orderId: string;
  initial: OrderStandDto;
}

type LiveState = 'live' | 'stale' | 'auth';

export function OrderStandBoard({ orderId, initial }: Props) {
  const [data, setData] = useState<OrderStandDto>(initial);
  const [live, setLive] = useState<LiveState>('live');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const aborted = useRef(false);

  const refresh = useCallback(async () => {
    const base = getApiBaseUrl().replace(/\/+$/, '');
    try {
      const res = await fetch(`${base}${standPath(orderId)}`, {
        credentials: 'include',
        cache: 'no-store',
      });
      if (res.status === 401 || res.status === 403) {
        setLive('auth');
        return;
      }
      if (!res.ok) {
        setLive('stale');
        return;
      }
      const next = (await res.json()) as OrderStandDto;
      if (!aborted.current) {
        setData(next);
        setLive('live');
      }
    } catch {
      if (!aborted.current) setLive('stale');
    }
  }, [orderId]);

  useEffect(() => {
    aborted.current = false;
    const tick = async () => {
      if (document.visibilityState === 'visible') await refresh();
      if (!aborted.current) timer.current = setTimeout(tick, POLL_MS);
    };
    timer.current = setTimeout(tick, POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      aborted.current = true;
      if (timer.current) clearTimeout(timer.current);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [refresh]);

  // Шаги категории CUTTING (печать лекал, настил, сам раскрой) живут внутри
  // блока «Раскрой» — на перекладине они дублировали бы его; PACKING —
  // правая нога. На перекладине остаётся пошив / ОТК / ВТО / прочее.
  const cutSteps = data.steps.filter((s) => s.category === 'CUTTING');
  const topSteps = data.steps.filter((s) => s.category !== 'PACKING' && s.category !== 'CUTTING');
  const packingStep = data.steps.find((s) => s.category === 'PACKING') ?? null;
  const cols = Math.max(3, 2 + topSteps.length);
  const lastCol = cols;
  const order = data.order;
  const stepNo = (i: number) => 4 + i + 1; // 4 = раскрой, дальше по перекладине
  const packingNo = 4 + topSteps.length + 1;
  const doneNo = packingNo + 1;

  return (
    <div className="ostand">
      <div className="ostand__toolbar">
        <div className="ostand__summary">
          <span>
            Клиент <b>{order.clientName ?? '—'}</b>
          </span>
          <span>
            Изделие <b>{order.patternName ?? '—'}</b>
          </span>
          {order.colors.length > 0 && (
            <span>
              Расцветка <b>{order.colors.join(', ')}</b>
            </span>
          )}
          <span>
            Тираж <b>{order.qtyPlanTotal} шт</b>
            {data.sizes.length > 0 && (
              <> · {data.sizes.map((s) => `${s.code} ${s.qtyPlan}`).join(' · ')}</>
            )}
          </span>
          {order.dueDate && (
            <span>
              Срок <b>{fmtDate(order.dueDate)}</b>
            </span>
          )}
        </div>
        <div className={`ostand__live ostand__live--${live}`} role="status">
          <i aria-hidden />
          {live === 'live' && `обновлено ${fmtTime(data.updatedAt)} · каждые 5 с`}
          {live === 'stale' && `нет связи — показано на ${fmtTime(data.updatedAt)}`}
          {live === 'auth' && 'сессия истекла — войдите заново'}
        </div>
      </div>

      <section
        className="ostand__board"
        style={{ ['--ostand-cols' as string]: String(cols) }}
        aria-label="Схема движения заказа по маршруту"
      >
        {/* ── левая нога ─────────────────────────────────────────────── */}
        <article className="ostand-blk" style={{ gridArea: `3 / 1` }}>
          <Port side="in" label="Клиент" />
          <BlkEyebrow zone="Офис" note={fmtDateTime(order.createdAt)} />
          <BlkHead no={1} title="Заказ" />
          <dl className="ostand-blk__kv">
            <dt>Клиент</dt>
            <dd>{order.clientName ?? '—'}</dd>
            <dt>Изделие</dt>
            <dd>{order.patternName ?? '—'}</dd>
            <dt>Тираж</dt>
            <dd>
              {order.qtyPlanTotal} шт · {data.sizes.length} разм.
            </dd>
            <dt>Маршрут</dt>
            <dd>{order.routeTemplateCode ?? (data.steps.length > 0 ? 'свой' : 'нет')}</dd>
          </dl>
          <div className="ostand-blk__foot">
            <span className={`ostand-pill ostand-pill--${order.status === 'DONE' ? 'ok' : 'blue'}`}>
              {ORDER_STATUS_LABELS[order.status as OrderStatus] ?? order.status}
            </span>
          </div>
          <Arrow dir="u" />
        </article>

        <article className="ostand-blk" style={{ gridArea: `2 / 1` }}>
          <BlkEyebrow zone="Офис" note={order.costEstimateCompletedAt ? fmtDate(order.costEstimateCompletedAt) : '—'} />
          <BlkHead no={2} title="Расчёт" />
          <p className="ostand-blk__body">
            {order.costEstimateTotalRub ? (
              <>
                Плановая себестоимость <b>{fmtMoney(order.costEstimateTotalRub)}</b>.
              </>
            ) : (
              <>
                Плановая себестоимость <b>не завершена</b> — заказ идёт без неё.
              </>
            )}
          </p>
          <div className="ostand-blk__foot">
            <span className={`ostand-pill ostand-pill--${order.costEstimateCompletedAt ? 'ok' : 'wait'}`}>
              {order.costEstimateCompletedAt ? 'расчёт завершён' : 'расчёт не завершён'}
            </span>
          </div>
          <Arrow dir="u" />
        </article>

        <article className="ostand-blk" style={{ gridArea: `1 / 1` }}>
          <BlkEyebrow zone="Склад" note={data.readiness ? `${data.readiness.materials.length} матер.` : '—'} />
          <BlkHead no={3} title="Материал" />
          {data.readiness ? (
            <>
              <p className="ostand-blk__body">
                {data.readiness.materials.length === 0
                  ? 'Потребность в материалах не рассчитана.'
                  : data.readiness.materials
                      .slice(0, 3)
                      .map((m) => `${m.description}: ${m.receivedQty} из ${m.targetQty} ${m.unit}`)
                      .join('; ')}
                {data.readiness.materials.length > 3 && ' …'}
              </p>
              <div className="ostand-blk__foot">
                <span
                  className={`ostand-pill ostand-pill--${
                    data.readiness.status === 'READY'
                      ? 'ok'
                      : data.readiness.status === 'WARNING_ONLY'
                        ? 'warn'
                        : 'wait'
                  }`}
                >
                  {CUT_READINESS_STATUS_LABELS[data.readiness.status]}
                </span>
              </div>
            </>
          ) : (
            <p className="ostand-blk__body">Готовность к крою недоступна.</p>
          )}
          <Arrow dir="r" />
        </article>

        {/* ── перекладина: раскрой + шаги маршрута ───────────────────── */}
        <article className="ostand-blk ostand-blk--shop ostand-blk--born" style={{ gridArea: `1 / 2` }}>
          <BlkEyebrow
            zone="Цех · раскрой"
            note={
              data.cutting.taskStatus
                ? CUTTING_TASK_STATUS_LABELS[data.cutting.taskStatus as CuttingTaskStatus] ?? data.cutting.taskStatus
                : 'до маршрута'
            }
          />
          <BlkHead no={4} title="Раскрой" />
          <p className="ostand-blk__body">
            {data.cutting.passports === 0 ? (
              <>Паспорта ещё не выпущены.</>
            ) : (
              <>
                Выпущено <b>{data.cutting.passports}</b> паспорт
                {plural(data.cutting.passports, '', 'а', 'ов')}, размеров {data.cutting.sizesCut} из{' '}
                {data.cutting.sizesTotal}.
              </>
            )}
            {cutSteps.length > 0 && (
              <>
                {' '}
                Шаги маршрута:{' '}
                {cutSteps.map((s, i) => (
                  <span key={s.index}>
                    {i > 0 && ' · '}
                    {s.operationName}{' '}
                    <b>{s.qtyDone > 0 ? `✔ ${s.qtyDone}` : s.qtyInWork > 0 ? `▶ ${s.qtyInWork}` : '—'}</b>
                  </span>
                ))}
                .
              </>
            )}
          </p>
          <div className="ostand-blk__foot">
            <Count value={data.cutting.qtyCut} label={`шт выпущено\nиз ${data.totals.qtyPlan}`} />
            <Workplace wp={data.cutting.workplace} others={data.cutting.otherWorkplaces} />
          </div>
          <Arrow dir={topSteps.length > 0 ? 'r' : 'd'} />
        </article>

        {topSteps.map((s, i) => {
          const isLast = i === topSteps.length - 1;
          return (
            <article
              key={s.index}
              className={`ostand-blk ostand-blk--shop${s.qtyInWork > 0 ? ' ostand-blk--active' : ''}`}
              style={{ gridArea: `1 / ${3 + i}` }}
            >
              <BlkEyebrow
                zone={`Цех · ${zoneOf(s)}`}
                note={`шаг ${s.index + 1} из ${data.steps.length}${s.parallelGroup != null ? ' · параллельно' : ''}${s.outsourced ? ' · подряд' : ''}`}
              />
              <BlkHead no={stepNo(i)} title={s.operationName} />
              <p className="ostand-blk__body">
                <StepNow step={s} />
              </p>
              <div className="ostand-blk__foot">
                <Count value={s.qtyDone} label={`шт ${doneVerb(s)}\nиз ${data.totals.qtyCut || data.totals.qtyPlan}`} zero={s.qtyDone === 0} />
                <Workplace wp={s.workplace} others={s.otherWorkplaces} />
              </div>
              <Arrow dir={isLast ? 'd' : 'r'} />
            </article>
          );
        })}

        {/* ── правая нога ───────────────────────────────────────────── */}
        <article
          className={`ostand-blk ostand-blk--out ostand-blk--born${packingStep && packingStep.qtyInWork > 0 ? ' ostand-blk--active' : ''}`}
          style={{ gridArea: `2 / ${lastCol}` }}
        >
          <BlkEyebrow
            zone="Выпуск · упаковка"
            note={packingStep ? `шаг ${packingStep.index + 1} из ${data.steps.length}` : 'вне маршрута'}
          />
          <BlkHead no={packingNo} title={packingStep?.operationName ?? 'Упаковка'} />
          <p className="ostand-blk__body">
            Коробок по заказу: <b>{data.boxes.length}</b>
            {data.boxes.length > 0 && (
              <>
                {' — '}
                {data.boxes
                  .map((b) => `${b.number}${b.closedAt ? ' ✔' : ` (${b.passports} п.)`}`)
                  .join(', ')}
              </>
            )}
            .
          </p>
          <div className="ostand-blk__foot">
            <Count
              value={data.totals.qtyPacking + data.totals.qtyFinished}
              label={`шт в коробках\nиз ${data.totals.qtyPlan}`}
              zero={data.totals.qtyPacking + data.totals.qtyFinished === 0}
            />
            <Workplace wp={packingStep?.workplace ?? null} others={packingStep?.otherWorkplaces ?? []} />
          </div>
          {data.boxes.length > 0 && (
            <div className="ostand-blk__boxes">
              {data.boxes.map((b) => (
                <figure key={b.id} className="ostand-qr ostand-qr--sm">
                  <QrCodeView value={b.qrPayload} size={56} title={`QR коробки ${b.number}`} />
                  <figcaption>
                    {b.number}
                    <small>{b.closedAt ? 'закрыта' : `${b.totalQty} шт, открыта`}</small>
                  </figcaption>
                </figure>
              ))}
            </div>
          )}
          <Arrow dir="d" />
        </article>

        <article className="ostand-blk ostand-blk--out" style={{ gridArea: `3 / ${lastCol}` }}>
          <Port side="out" label="Отгрузка" />
          <BlkEyebrow zone="Выпуск" note={order.completedAt ? fmtDateTime(order.completedAt) : 'авто'} />
          <BlkHead no={doneNo} title="Заказ готов" />
          <p className="ostand-blk__body">
            {order.status === 'DONE' ? (
              <>
                Заказ <b>закрыт</b>: документ выпуска и факт себестоимости сформированы.
              </>
            ) : (
              <>
                Закроется сам, когда упакованы все <b>{data.totals.qtyPlan} шт</b>.
              </>
            )}
          </p>
          <div className="ostand-blk__foot">
            <Count value={data.totals.qtyFinished} label={`из ${data.totals.qtyPlan} готово`} zero={data.totals.qtyFinished === 0} />
          </div>
        </article>

        {/* ── сердцевина: стеллаж + паспорта ────────────────────────── */}
        <div className="ostand-core" style={{ gridArea: `2 / 2 / 4 / ${lastCol}` }}>
          <div className="ostand-core__head">
            <h2 className="ostand-core__title">Стеллаж и паспорта заказа</h2>
            <p className="ostand-core__hint">
              Раскройщик: скан ячейки → скан паспорта → положил. Швея: скан паспорта → взяла.
            </p>
          </div>

          {data.cells.length > 0 ? (
            <div className="ostand-shelf">
              {data.cells.map((c) => (
                <div key={c.id} className={`ostand-cell${c.passports > 0 ? ' ostand-cell--has' : ''}`}>
                  <QrCodeView value={c.qrPayload} size={64} title={`QR ячейки ${c.code}`} className="ostand-cell__qr" />
                  <div>
                    <div className="ostand-cell__code">{c.code}</div>
                    <div className="ostand-cell__meta">
                      {c.passports > 0 ? `паспортов заказа: ${c.passports} · ${c.qty} шт` : 'пусто'}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="ostand-core__hint">Активных ячеек нет — заведите стеллаж в «Склады».</p>
          )}

          {data.steps.length === 0 && data.passports.length > 0 && (
            <p className="ostand-core__hint">
              У заказа нет маршрута: паспорта идут по операциям смен, шаги на перекладине не показываются.
            </p>
          )}

          {data.passports.length === 0 ? (
            <p className="ostand-core__empty">
              Паспортов пока нет — они появятся здесь сразу после выпуска на раскрое.
            </p>
          ) : (
            <div className="ostand-plist">
              {data.passports
                .filter((p) => p.place !== 'CANCELLED')
                .map((p) => (
                  <PassportRow key={p.id} p={p} steps={data.steps} />
                ))}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------

function PassportRow({ p, steps }: { p: OrderStandPassportDto; steps: OrderStandStepDto[] }) {
  const tone =
    p.place === 'PACKED' ? 'packed' : p.place === 'IN_WORK' ? 'work' : p.place === 'STEP_DONE' ? 'done' : 'cell';
  return (
    <div className={`ostand-prow ostand-prow--${tone}`}>
      <QrCodeView value={p.qrPayload} size={72} title={`QR паспорта ${p.number}`} className="ostand-prow__qr" />
      <div className="ostand-prow__id">
        <div className="ostand-prow__no">{p.number}</div>
        <div className="ostand-prow__size">
          <b>{p.sizeCode}</b>
          {p.qtyCut} шт · рулон {p.rollNumber}
          {p.qtyDefect > 0 && <span className="ostand-prow__defect"> · брак {p.qtyDefect}</span>}
        </div>
      </div>
      <div className="ostand-prow__where">
        <b>{whereTitle(p)}</b>
        <span>{whereDetail(p)}</span>
        <div className="ostand-trail" aria-label="Путь паспорта по маршруту">
          <i className="on">Крой</i>
          {steps.map((s) => (
            <i key={s.index} className={trailClass(p, s)}>
              {s.operationName}
            </i>
          ))}
        </div>
      </div>
      <div className="ostand-prow__next">
        <b>Следующий скан</b>
        {p.nextHint || '—'}
      </div>
    </div>
  );
}

function trailClass(p: OrderStandPassportDto, s: OrderStandStepDto): string {
  if (p.place === 'PACKED') return 'on';
  if (p.stepIndex === null) return '';
  if (p.stepIndex > s.index) return 'on';
  if (p.stepIndex === s.index) return p.place === 'STEP_DONE' ? 'on' : 'now';
  return '';
}

function whereTitle(p: OrderStandPassportDto): string {
  switch (p.place) {
    case 'IN_CELL':
      return `Стеллаж · ячейка ${p.cell?.code ?? ''}`;
    case 'IN_WORK':
      return `${p.operationName ?? 'Операция'} — в работе`;
    case 'STEP_DONE':
      return `${p.operationName ?? 'Шаг'} ✔ — ждёт следующего`;
    case 'PACKED':
      return `Коробка ${p.box?.number ?? ''}${p.box?.closedAt ? ' · закрыта' : ''}`;
    case 'UNPLACED':
      return 'Выпущен, не на стеллаже';
    case 'WAITING':
      return `${p.operationName ?? 'Шаг'} — ${ORDER_STAND_PLACE_LABELS.WAITING}`;
    default:
      return ORDER_STAND_PLACE_LABELS[p.place];
  }
}

function whereDetail(p: OrderStandPassportDto): string {
  const at = fmtTime(p.updatedAt);
  switch (p.place) {
    case 'IN_WORK':
      return `${p.employee?.fullName ?? 'исполнитель'} · с ${at}`;
    case 'STEP_DONE':
      return `закрыто в ${at}`;
    case 'IN_CELL':
      return `положен ${at}`;
    case 'PACKED':
      return `упакован ${at}`;
    default:
      return `обновлён ${at}`;
  }
}

function StepNow({ step }: { step: OrderStandStepDto }) {
  if (step.inWork.length > 0) {
    return (
      <>
        Сейчас здесь: <b>{step.inWork.map((w) => w.employeeName).join(', ')}</b> (
        {step.inWork.map((w) => w.passportNumber.replace(/^P-\d+-/, '…')).join(', ')}).
        {step.qtyWaiting > 0 && <> Ждут: {step.qtyWaiting} шт.</>}
      </>
    );
  }
  if (step.qtyWaiting > 0) {
    return (
      <>
        Сейчас здесь: <b>никого</b>. Ждут исполнителя: {step.qtyWaiting} шт.
      </>
    );
  }
  if (step.qtyDone > 0) {
    return (
      <>
        Сейчас здесь: <b>никого</b>. Прошло {step.passportsDone} паспорт
        {plural(step.passportsDone, '', 'а', 'ов')}.
      </>
    );
  }
  return <>Пока ничего не пришло.</>;
}

function Workplace({ wp, others }: { wp: OrderStandWorkplaceDto | null; others: string[] }) {
  if (!wp) {
    return (
      <figure className="ostand-qr ostand-qr--none">
        <figcaption>
          нет рабочего места
          <small>под эту операцию</small>
        </figcaption>
      </figure>
    );
  }
  return (
    <figure className="ostand-qr">
      <QrCodeView value={wp.qrPayload} size={84} title={`QR рабочего места ${wp.name}`} />
      <figcaption>
        {wp.name}
        <small>{others.length > 0 ? `ещё: ${others.join(', ')}` : 'скан → смена'}</small>
      </figcaption>
    </figure>
  );
}

function Count({ value, label, zero }: { value: number; label: string; zero?: boolean }) {
  const [l1, l2] = label.split('\n');
  return (
    <div className={`ostand-count${zero ? ' ostand-count--zero' : ''}`}>
      <b>{value}</b>
      <span>
        {l1}
        {l2 && (
          <>
            <br />
            {l2}
          </>
        )}
      </span>
    </div>
  );
}

function BlkEyebrow({ zone, note }: { zone: string; note?: string }) {
  return (
    <div className="ostand-blk__eyebrow">
      <span>{zone}</span>
      {note && <span className="ostand-blk__note">{note}</span>}
    </div>
  );
}

function BlkHead({ no, title }: { no: number; title: string }) {
  return (
    <div className="ostand-blk__head">
      <span className="ostand-blk__no">{no}</span>
      <h3 className="ostand-blk__title">{title}</h3>
    </div>
  );
}

function Arrow({ dir }: { dir: 'r' | 'u' | 'd' }) {
  if (dir === 'r') {
    return (
      <svg className="ostand-arr ostand-arr--r" viewBox="0 0 40 16" aria-hidden>
        <line x1="2" y1="8" x2="26" y2="8" />
        <polygon points="26,1 38,8 26,15" />
      </svg>
    );
  }
  if (dir === 'u') {
    return (
      <svg className="ostand-arr ostand-arr--u" viewBox="0 0 16 40" aria-hidden>
        <line x1="8" y1="38" x2="8" y2="14" />
        <polygon points="1,14 8,2 15,14" />
      </svg>
    );
  }
  return (
    <svg className="ostand-arr ostand-arr--d" viewBox="0 0 16 40" aria-hidden>
      <line x1="8" y1="2" x2="8" y2="26" />
      <polygon points="1,26 8,38 15,26" />
    </svg>
  );
}

function Port({ side, label }: { side: 'in' | 'out'; label: string }) {
  return (
    <span className={`ostand-port ostand-port--${side}`} aria-hidden>
      <svg viewBox="0 0 40 16">
        <line x1="2" y1="8" x2="26" y2="8" />
        <polygon points="26,1 38,8 26,15" />
      </svg>
      {label}
    </span>
  );
}

// ---------------------------------------------------------------------------

function zoneOf(s: OrderStandStepDto): string {
  switch (s.category) {
    case 'SEWING':
      return 'пошив';
    case 'QC':
      return 'контроль';
    case 'IRONING':
      return 'ВТО';
    case 'CUTTING':
      return 'раскрой';
    case 'PACKING':
      return 'упаковка';
    default:
      return '';
  }
}

function doneVerb(s: OrderStandStepDto): string {
  switch (s.category) {
    case 'SEWING':
      return 'сшито';
    case 'QC':
      return 'проверено';
    case 'IRONING':
      return 'обработано';
    case 'PACKING':
      return 'упаковано';
    default:
      return 'готово';
  }
}

function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
  return many;
}

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('ru-RU', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    timeZone: MSK,
  });
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    timeZone: MSK,
  });
}

function fmtDateTime(iso: string): string {
  return new Date(iso).toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: MSK,
  });
}

function fmtMoney(v: string): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return v;
  return `${n.toLocaleString('ru-RU', { maximumFractionDigits: 0 })} ₽`;
}
