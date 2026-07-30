'use client';

/**
 * `RouteAmendmentTab` — холст правки маршрута заказа. Одна поверхность на
 * два сценария (фича `FEATURE_ORDER_AMENDMENTS`):
 *   - до запуска (`Расчёт` и раньше) — кнопка «Изменить маршрут» в
 *     карточке «Маршрут операций» на вкладке «Производство»;
 *   - в производстве — вкладка «Маршрут» drawer-а «Изменить заказ в
 *     производстве».
 *
 * Разделяет их не статус, а `state.started`: у запущенного заказа есть
 * фронт производства (замороженный префикс) и обязательная причина
 * правки, до запуска — ни того, ни другого (`frontierIndex = −1`, весь
 * маршрут размораживается тем же кодом, без отдельной ветки).
 *
 * Маршрут показан той же цепочкой чипов, что и в справочнике маршрутов
 * (`AdminRouteSteps`, классы `.admin-route-step*`), но цепочка стала
 * холстом:
 *   - операция перетаскивается из палитры справа в нужное место цепочки;
 *   - шаг перетаскивается внутри цепочки (перестановка) и выбрасывается
 *     обратно в палитру (удаление);
 *   - кнопка ⇄ связывает шаг с предыдущим в параллельную группу.
 *
 * Фронт производства нарисован прямо в цепочке: шаги, которые паспорта
 * прошли или проходят сейчас (`movable === false`), — серые с замком, а
 * слоты вставки левее фронта не принимают drop. Гейт виден ДО действия,
 * а не приходит 409-й ошибкой после сохранения (бэкенд всё равно
 * проверяет: `AMENDMENT_ROUTE_FRONTIER_CHANGED`).
 *
 * На сервер уходит ВЕСЬ целевой маршрут (`PUT /orders/:id/amendments/route`),
 * дельту считает бэкенд — холст остаётся источником истины «как должно
 * быть». Δ плана в подвале считается локально и приблизительно (только
 * операции со сделкой FIXED и нормой FIXED); точный план пересчитает
 * бэкенд по снимку.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useFormState, useFormStatus } from 'react-dom';
import {
  ArrowLeftRight,
  GripVertical,
  Info,
  Lock,
  Plus,
  Save,
  X,
  XCircle,
} from 'lucide-react';
import type {
  OperationAmendmentOptionDto,
  OperationAmendmentStateDto,
  OperationAmendmentStepDto,
} from '@sewing/shared';
import {
  OPERATION_CATEGORY_LABELS,
  OPERATION_CATEGORY_ORDER,
} from '@sewing/shared/operations';
import { routeStepIcon, routeStepTone } from '@/components/admin/admin-route-steps';
import { applyRouteAmendmentAction } from '@/app/admin/orders/[id]/amendment-actions';
import { initialRouteAmendmentFormState } from '@/app/admin/orders/[id]/amendment-form-state';

interface Props {
  orderId: string;
  state: OperationAmendmentStateDto;
  onClose: () => void;
}

/** Шаг холста. `key` стабилен на всё время правки (React + фокус). */
interface DraftStep {
  key: string;
  operationId: string;
  name: string;
  code: string;
  category: string | null;
  /**
   * «Этот шаг в одной параллельной группе с предыдущим». Храним именно
   * флаг связи, а не номер группы: номер — производная, его пересчёт
   * после каждой перестановки собирается один раз в `toPayloadSteps`.
   */
  linkedWithPrev: boolean;
  rateRub: number | null;
  timeNormSec: number | null;
  /** Шаг заморожен фронтом: не двигается, не удаляется. */
  frozen: boolean;
  /** По операции уже есть выработка — убрать нельзя даже впереди фронта. */
  hasWork: boolean;
  /** Добавлен в этой правке, ещё не сохранён. */
  isNew: boolean;
}

/** Что сейчас тащим: чип палитры или шаг цепочки. */
type DragSource =
  | { kind: 'pool'; operationId: string }
  | { kind: 'step'; index: number };

function toDraft(steps: readonly OperationAmendmentStepDto[]): DraftStep[] {
  return steps.map((s, i) => ({
    key: `step:${s.operationId}`,
    operationId: s.operationId,
    name: s.operationName,
    code: s.operationCode,
    category: s.operationCategory,
    linkedWithPrev:
      i > 0 &&
      s.parallelGroup != null &&
      s.parallelGroup === steps[i - 1].parallelGroup,
    rateRub: s.rateRub,
    timeNormSec: s.timeNormSec,
    frozen: !s.movable,
    hasWork: s.movable && !s.removable,
    isNew: false,
  }));
}

function fromOption(op: OperationAmendmentOptionDto): DraftStep {
  return {
    key: `new:${op.id}`,
    operationId: op.id,
    name: op.name || op.code,
    code: op.code,
    category: op.category,
    linkedWithPrev: false,
    rateRub: op.rateRub,
    timeNormSec: op.timeNormSec,
    frozen: false,
    hasWork: false,
    isNew: true,
  };
}

/**
 * Флаги связи → номера параллельных групп снимка: оба шага пары несут
 * ОДИН `parallelGroup`, цепочка из трёх связанных шагов — одна группа.
 * Это формат `OrderRouteStep.parallelGroup`, который читает enforcement
 * паспортов и доска.
 */
function toPayloadSteps(
  rows: readonly DraftStep[],
): { operationId: string; parallelGroup: number | null }[] {
  const out = rows.map((s) => ({
    operationId: s.operationId,
    parallelGroup: null as number | null,
  }));
  let group = 0;
  rows.forEach((s, i) => {
    if (i === 0 || !s.linkedWithPrev) return;
    if (!rows[i - 1].linkedWithPrev) {
      group += 1;
      out[i - 1].parallelGroup = group;
    }
    out[i].parallelGroup = out[i - 1].parallelGroup;
  });
  return out;
}

const RUB = new Intl.NumberFormat('ru-RU', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

function formatSec(total: number): string {
  if (total <= 0) return '0 с';
  const min = Math.floor(total / 60);
  const sec = total % 60;
  if (min === 0) return `${sec} с`;
  return sec === 0 ? `${min} мин` : `${min} мин ${sec} с`;
}

/** Один чип маршрута — те же классы, что у `AdminRouteSteps`. */
function StepChip({
  step,
  num,
  draggable,
  onDragStart,
  onDragEnd,
  onToggleParallel,
  onRemove,
  onKeyDown,
  parallelWithPrev,
  chipRef,
}: {
  step: DraftStep;
  num: number;
  draggable: boolean;
  onDragStart?: (e: React.DragEvent) => void;
  onDragEnd?: () => void;
  onToggleParallel?: () => void;
  onRemove?: () => void;
  onKeyDown?: (e: React.KeyboardEvent) => void;
  parallelWithPrev: boolean;
  chipRef?: (el: HTMLSpanElement | null) => void;
}) {
  const Icon = routeStepIcon(step.category);
  const tone = routeStepTone(step.category);
  const classes = [
    'admin-route-step',
    tone,
    step.frozen ? 'admin-route-step--frozen' : '',
    draggable ? 'admin-route-step--draggable' : '',
    step.isNew ? 'admin-route-step--new' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <span
      ref={chipRef}
      className={classes}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onKeyDown={onKeyDown}
      tabIndex={draggable ? 0 : -1}
      data-operation-code={step.code}
      data-frozen={step.frozen ? '1' : '0'}
      title={
        step.frozen
          ? 'Шаг прошли или проходят паспорта — изменение недоступно'
          : undefined
      }
    >
      {draggable && (
        <span className="admin-route-step__grip" aria-hidden>
          <GripVertical size={12} strokeWidth={1.7} />
        </span>
      )}
      <span className="admin-route-step__num" aria-hidden>
        {num}
      </span>
      {step.frozen ? (
        <span className="admin-route-step__icon" aria-hidden>
          <Lock size={13} strokeWidth={1.7} />
        </span>
      ) : (
        <span className="admin-route-step__icon" aria-hidden>
          <Icon size={14} strokeWidth={1.7} />
        </span>
      )}
      <span className="admin-route-step__name">{step.name}</span>
      {step.rateRub != null && (
        <span className="admin-route-step__meta">{step.rateRub} ₽</span>
      )}
      {step.isNew && <span className="admin-route-step__tag">новая</span>}
      {!step.frozen && (
        <>
          <button
            type="button"
            className={`admin-route-step__act${
              parallelWithPrev ? ' admin-route-step__act--on' : ''
            }`}
            onClick={onToggleParallel}
            aria-pressed={parallelWithPrev}
            aria-label={`Параллельно с предыдущим шагом: ${step.name}`}
            title="Параллельно с предыдущим шагом (порядок внутри группы любой)"
          >
            <ArrowLeftRight size={12} strokeWidth={1.9} aria-hidden />
          </button>
          <button
            type="button"
            className="admin-route-step__act"
            onClick={onRemove}
            aria-label={`Убрать из маршрута: ${step.name}`}
            title={
              step.hasWork
                ? 'По операции уже есть выработка — убрать нельзя'
                : 'Убрать из маршрута'
            }
            disabled={step.hasWork}
          >
            <X size={12} strokeWidth={1.9} aria-hidden />
          </button>
        </>
      )}
    </span>
  );
}

function SaveButton({ disabled }: { disabled: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className="admin-btn admin-btn--primary"
      disabled={pending || disabled}
      data-testid="route-amendment-save"
    >
      <Save size={16} strokeWidth={1.6} aria-hidden />
      {pending ? 'Сохраняем…' : 'Сохранить маршрут'}
    </button>
  );
}

export function RouteAmendmentTab({ orderId, state, onClose }: Props) {
  const initial = useMemo(() => toDraft(state.steps), [state.steps]);
  const [draft, setDraft] = useState<DraftStep[]>(initial);
  const [reason, setReason] = useState('');
  const [query, setQuery] = useState('');
  const [drag, setDrag] = useState<DragSource | null>(null);
  const [overSlot, setOverSlot] = useState<number | null>(null);
  const [overPool, setOverPool] = useState(false);
  const [blocked, setBlocked] = useState<string | null>(null);
  const [announce, setAnnounce] = useState('');
  const focusKeyRef = useRef<string | null>(null);
  const chipRefs = useRef(new Map<string, HTMLSpanElement>());

  const [formState, formAction] = useFormState(
    applyRouteAmendmentAction.bind(null, orderId),
    initialRouteAmendmentFormState,
  );

  useEffect(() => {
    if (formState.ok) onClose();
  }, [formState.ok, onClose]);

  // Возврат фокуса на переставленный клавиатурой шаг (после ре-рендера).
  useEffect(() => {
    const key = focusKeyRef.current;
    if (!key) return;
    focusKeyRef.current = null;
    chipRefs.current.get(key)?.focus();
  }, [draft]);

  /**
   * Левее этой позиции вставлять нельзя: там фронт производства. Замо-
   * роженные шаги всегда идут подряд с начала маршрута, поэтому их
   * количество и есть минимальный допустимый слот.
   */
  const minSlot = initial.filter((s) => s.frozen).length;

  const usedIds = useMemo(
    () => new Set(draft.map((s) => s.operationId)),
    [draft],
  );

  const pool = useMemo(() => {
    const q = query.trim().toLowerCase();
    const available = state.availableOperations.filter(
      (op) => !usedIds.has(op.id) && (!q || op.name.toLowerCase().includes(q)),
    );
    // Убранные из маршрута шаги возвращаются в палитру: иначе операцию,
    // которую только что выбросили, нельзя было бы вернуть назад.
    const removed = initial
      .filter((s) => !usedIds.has(s.operationId))
      .filter((s) => !q || s.name.toLowerCase().includes(q))
      .map<OperationAmendmentOptionDto>((s) => ({
        id: s.operationId,
        code: s.code,
        name: s.name,
        category: s.category,
        rateRub: s.rateRub,
        timeNormSec: s.timeNormSec,
      }));
    const all = [...removed, ...available];
    const groups = [...OPERATION_CATEGORY_ORDER, 'UNKNOWN'].map((cat) => ({
      category: cat,
      label:
        cat === 'UNKNOWN'
          ? 'Без категории'
          : OPERATION_CATEGORY_LABELS[
              cat as keyof typeof OPERATION_CATEGORY_LABELS
            ],
      items: all.filter((op) => (op.category ?? 'UNKNOWN') === cat),
    }));
    return groups.filter((g) => g.items.length > 0);
  }, [state.availableOperations, initial, usedIds, query]);

  const totals = useMemo(() => {
    const sum = (rows: DraftStep[]) => ({
      rate: rows.reduce((a, s) => a + (s.rateRub ?? 0), 0),
      sec: rows.reduce((a, s) => a + (s.timeNormSec ?? 0), 0),
    });
    const now = sum(draft);
    const was = sum(initial);
    return {
      rate: now.rate,
      sec: now.sec,
      rateDelta: now.rate - was.rate,
      secDelta: now.sec - was.sec,
    };
  }, [draft, initial]);

  /** Человекочитаемая сводка — то же, что бэкенд запишет в журнал. */
  const changes = useMemo(() => {
    const wasIds = initial.map((s) => s.operationId);
    const nowIds = draft.map((s) => s.operationId);
    const out: { tone: string; label: string; text: string }[] = [];
    draft.forEach((s, i) => {
      if (wasIds.includes(s.operationId)) return;
      const prev = draft[i - 1];
      out.push({
        tone: 'ok',
        label: 'Добавлено',
        text: `«${s.name}» ${prev ? `после «${prev.name}»` : 'в начало'}`,
      });
    });
    initial.forEach((s) => {
      if (nowIds.includes(s.operationId)) return;
      out.push({ tone: 'danger', label: 'Убрано', text: `«${s.name}»` });
    });
    // Перестановка считается по относительному порядку выживших шагов:
    // вставка в начало сдвигает хвост, но это не перестановка.
    const survivedBefore = wasIds.filter((id) => nowIds.includes(id));
    const survivedAfter = nowIds.filter((id) => wasIds.includes(id));
    draft.forEach((s, i) => {
      if (!wasIds.includes(s.operationId)) return;
      if (
        survivedBefore.indexOf(s.operationId) ===
        survivedAfter.indexOf(s.operationId)
      ) {
        return;
      }
      out.push({
        tone: 'info',
        label: 'Переставлено',
        text: `«${s.name}» → шаг ${i + 1}`,
      });
    });
    draft.forEach((s, i) => {
      const before = initial.find((x) => x.operationId === s.operationId);
      const parallelWas = before ? before.linkedWithPrev : false;
      if (s.linkedWithPrev !== parallelWas && i > 0) {
        out.push({
          tone: 'info',
          label: s.linkedWithPrev ? 'Параллельно' : 'Последовательно',
          text: `«${s.name}» ${s.linkedWithPrev ? 'с' : 'после'} «${
            draft[i - 1].name
          }»`,
        });
      }
    });
    return out;
  }, [draft, initial]);

  const dirty = changes.length > 0;
  const reasonTrimmed = reason.trim();
  // Причина обязательна только у запущенного заказа — там правка задевает
  // идущую работу. До запуска маршрут правится как остальной план заказа
  // (тот же гейт держит backend, см. `AMENDMENT_REASON_REQUIRED`).
  const canSubmit = dirty && (!state.started || reasonTrimmed.length > 0);

  const payload = JSON.stringify({
    steps: toPayloadSteps(draft),
    reason: reasonTrimmed,
  });

  // ---------------------------------------------------------------- actions

  const say = (text: string) => setAnnounce(text);

  const reject = (text: string) => {
    setBlocked(text);
    window.setTimeout(() => setBlocked(null), 2600);
  };

  /**
   * После перестановки связь «параллельно с предыдущим» может оказаться
   * невозможной: у первого шага нет предыдущего, а шаг сразу за фронтом
   * связался бы с замороженным (это изменило бы его `parallelGroup`).
   */
  const applyRows = (rows: DraftStep[]) =>
    setDraft(
      rows.map((s, i) =>
        i <= minSlot && s.linkedWithPrev
          ? { ...s, linkedWithPrev: false }
          : s,
      ),
    );

  /**
   * Вставка из палитры. Если операция была в маршруте и её только что
   * убрали — возвращаем ИСХОДНЫЙ шаг, а не новый: для бэкенда это тот же
   * `operationId`, и метка «новая» на нём была бы враньём.
   */
  const insertAt = (op: OperationAmendmentOptionDto, at: number) => {
    const restored = initial.find((s) => s.operationId === op.id);
    const next = draft.slice();
    next.splice(at, 0, restored ? { ...restored, linkedWithPrev: false } : fromOption(op));
    applyRows(next);
    say(`${op.name} — шаг ${at + 1} из ${next.length}`);
  };

  const moveTo = (from: number, at: number) => {
    const next = draft.slice();
    const [item] = next.splice(from, 1);
    const to = at > from ? at - 1 : at;
    next.splice(to, 0, item);
    applyRows(next);
    say(`${item.name} — шаг ${to + 1} из ${next.length}`);
  };

  const removeAt = (i: number) => {
    const step = draft[i];
    if (step.frozen) {
      reject('Шаг уже проходят паспорта — убрать нельзя');
      return;
    }
    if (step.hasWork) {
      reject(`По операции «${step.name}» уже есть выработка — убрать нельзя`);
      return;
    }
    const next = draft.slice();
    next.splice(i, 1);
    applyRows(next);
    say(`${step.name} убрана из маршрута`);
  };

  const toggleParallel = (i: number) => {
    if (i <= minSlot) {
      reject('Связать можно только два шага впереди фронта производства');
      return;
    }
    const next = draft.slice();
    next[i] = { ...next[i], linkedWithPrev: !next[i].linkedWithPrev };
    applyRows(next);
  };

  const dropAt = (at: number) => {
    if (!drag) return;
    if (at < minSlot) {
      reject('Сюда нельзя: шаг уже проходят паспорта');
      return;
    }
    if (drag.kind === 'pool') {
      const op =
        state.availableOperations.find((o) => o.id === drag.operationId) ??
        initial
          .filter((s) => s.operationId === drag.operationId)
          .map<OperationAmendmentOptionDto>((s) => ({
            id: s.operationId,
            code: s.code,
            name: s.name,
            category: s.category,
            rateRub: s.rateRub,
            timeNormSec: s.timeNormSec,
          }))[0];
      if (op) insertAt(op, at);
    } else {
      moveTo(drag.index, at);
    }
    setDrag(null);
    setOverSlot(null);
  };

  const onStepKeyDown = (e: React.KeyboardEvent, i: number) => {
    if (e.key === 'Delete') {
      e.preventDefault();
      removeAt(i);
      return;
    }
    if (e.altKey && (e.key === 'p' || e.key === 'P' || e.key === 'з')) {
      e.preventDefault();
      toggleParallel(i);
      return;
    }
    if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      e.preventDefault();
      const to = i + (e.key === 'ArrowLeft' ? -1 : 1);
      if (to < minSlot || to >= draft.length) {
        if (to < minSlot) reject('Сюда нельзя: шаг уже проходят паспорта');
        return;
      }
      focusKeyRef.current = draft[i].key;
      const next = draft.slice();
      const [item] = next.splice(i, 1);
      next.splice(to, 0, item);
      applyRows(next);
      say(`${item.name} — шаг ${to + 1} из ${next.length}`);
    }
  };

  // ----------------------------------------------------------------- render

  if (!state.editable) {
    return (
      <div className="amend-note amend-note--warn">
        <Info size={16} strokeWidth={1.7} aria-hidden />
        Заказ закрыт — маршрут в нём уже не меняется.
      </div>
    );
  }

  const slot = (at: number) => {
    const locked = at < minSlot;
    const isOver = overSlot === at;
    return (
      <span
        key={`slot:${at}`}
        className={`rb-slot${locked ? ' rb-slot--locked' : ''}${
          isOver ? ' rb-slot--over' : ''
        }`}
        data-at={at}
        onDragOver={(e) => {
          if (!drag) return;
          setOverSlot(at);
          if (locked) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = drag.kind === 'pool' ? 'copy' : 'move';
        }}
        onDragLeave={() => setOverSlot((cur) => (cur === at ? null : cur))}
        onDrop={(e) => {
          e.preventDefault();
          setOverSlot(null);
          dropAt(at);
        }}
        aria-hidden
      >
        <span className="rb-slot__arrow">
          {locked ? '✕' : at === draft.length ? '＋' : '→'}
        </span>
        <span className="rb-slot__label">
          {locked ? 'нельзя' : 'вставить сюда'}
        </span>
      </span>
    );
  };

  return (
    <form
      action={formAction}
      className="rb-form"
      data-testid="route-amendment-tab"
    >
      <input type="hidden" name="payload" value={payload} />

      {state.started ? (
        <div className="amend-note amend-note--warn">
          <Info size={16} strokeWidth={1.7} aria-hidden />
          <span>
            Маршрут меняется только <b>впереди фронта производства</b>: шаги,
            которые уже прошёл или проходит хотя бы один паспорт, заморожены.
            Уже сделанную работу правка не трогает.
          </span>
        </div>
      ) : (
        <div className="amend-note amend-note--info">
          <Info size={16} strokeWidth={1.7} aria-hidden />
          <span>
            Заказ ещё не запущен — маршрут правится целиком. Сохранённая
            цепочка <b>заменяет шаблон</b> для этого заказа: дальнейшие
            правки шаблона в справочнике сюда больше не доедут.
          </span>
        </div>
      )}

      <div className={`rb${drag ? ' rb--dragging' : ''}`}>
        <section className="rb-panel">
          <header className="rb-panel__head">
            <span className="rb-panel__title">Маршрут заказа</span>
            <span className="rb-panel__hint">
              перетащите операцию в нужное место цепочки
            </span>
          </header>
          <div className="rb-panel__body">
            <div className="rb-canvas">
              <div className="rb-lane">
                {slot(0)}
                {draft.map((s, i) => {
                  const parallelWithPrev = i > 0 && s.linkedWithPrev;
                  return (
                    <span key={s.key} className="rb-lane__item">
                      <StepChip
                        step={s}
                        num={i + 1}
                        draggable={!s.frozen}
                        parallelWithPrev={parallelWithPrev}
                        chipRef={(el) => {
                          if (el) chipRefs.current.set(s.key, el);
                          else chipRefs.current.delete(s.key);
                        }}
                        onDragStart={(e) => {
                          setDrag({ kind: 'step', index: i });
                          e.dataTransfer.effectAllowed = 'move';
                          e.dataTransfer.setData('text/plain', s.operationId);
                        }}
                        onDragEnd={() => {
                          setDrag(null);
                          setOverSlot(null);
                          setOverPool(false);
                        }}
                        onToggleParallel={() => toggleParallel(i)}
                        onRemove={() => removeAt(i)}
                        onKeyDown={(e) => onStepKeyDown(e, i)}
                      />
                      {i === minSlot - 1 && (
                        <span
                          className="rb-front"
                          title="Фронт производства: сюда уже дошли паспорта"
                        >
                          фронт
                        </span>
                      )}
                      {draft[i + 1]?.linkedWithPrev ? (
                        <span
                          className="admin-route-steps__sep admin-route-steps__sep--parallel"
                          title="Параллельные операции: порядок любой"
                        >
                          <ArrowLeftRight
                            size={13}
                            strokeWidth={1.8}
                            aria-hidden
                          />
                        </span>
                      ) : (
                        slot(i + 1)
                      )}
                    </span>
                  );
                })}
              </div>
            </div>

            <div className="rb-changes">
              {changes.length === 0 ? (
                <p className="rb-changes__empty">
                  Изменений пока нет — перетащите операцию из списка справа.
                </p>
              ) : (
                <>
                  <h4>Что будет сохранено</h4>
                  <ul>
                    {changes.map((c, i) => (
                      <li key={`${c.label}:${c.text}:${i}`}>
                        <span className={`rb-tag rb-tag--${c.tone}`}>
                          {c.label}
                        </span>{' '}
                        {c.text}
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>

            {state.started && (
              <div className="admin-field" style={{ marginTop: 10 }}>
                <label htmlFor="routeAmendReason">Причина правки *</label>
                <input
                  id="routeAmendReason"
                  type="text"
                  maxLength={500}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="Например: клиент попросил добавить ОТК перед упаковкой"
                />
              </div>
            )}

            <div className="rb-foot">
              <div className="rb-totals">
                <span>
                  Операций: <b>{draft.length}</b>
                </span>
                <span>
                  Сделка: <b>{RUB.format(totals.rate)} ₽/шт</b>
                  {totals.rateDelta !== 0 && (
                    <span
                      className={`rb-delta${
                        totals.rateDelta > 0 ? ' rb-delta--up' : ''
                      }`}
                    >
                      {totals.rateDelta > 0 ? '+' : '−'}
                      {RUB.format(Math.abs(totals.rateDelta))} ₽
                    </span>
                  )}
                </span>
                <span>
                  Норма: <b>{formatSec(totals.sec)}</b>
                  {totals.secDelta !== 0 && (
                    <span
                      className={`rb-delta${
                        totals.secDelta > 0 ? ' rb-delta--up' : ''
                      }`}
                    >
                      {totals.secDelta > 0 ? '+' : '−'}
                      {formatSec(Math.abs(totals.secDelta))}
                    </span>
                  )}
                </span>
              </div>
            </div>
          </div>
        </section>

        <section
          className={`rb-panel rb-pool${overPool ? ' rb-pool--over' : ''}`}
          onDragOver={(e) => {
            if (!drag || drag.kind !== 'step') return;
            e.preventDefault();
            setOverPool(true);
          }}
          onDragLeave={() => setOverPool(false)}
          onDrop={(e) => {
            setOverPool(false);
            if (!drag || drag.kind !== 'step') return;
            e.preventDefault();
            removeAt(drag.index);
            setDrag(null);
          }}
        >
          <header className="rb-panel__head">
            <span className="rb-panel__title">Операции справочника</span>
            <span className="rb-panel__hint">
              {pool.reduce((a, g) => a + g.items.length, 0)}
            </span>
          </header>
          <div className="rb-panel__body">
            <input
              type="search"
              className="rb-pool__search"
              placeholder="Поиск операции…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="Поиск операции в справочнике"
            />
            {pool.length === 0 ? (
              <p className="rb-panel__hint">
                Все операции справочника уже в маршруте.
              </p>
            ) : (
              pool.map((group) => (
                <div key={group.category} className="rb-pool__group">
                  <h4>
                    <span>{group.label}</span>
                    <span>{group.items.length}</span>
                  </h4>
                  <div className="rb-pool__items">
                    {group.items.map((op) => {
                      const Icon = routeStepIcon(op.category);
                      return (
                        <span
                          key={op.id}
                          className={`admin-route-step ${routeStepTone(
                            op.category,
                          )} admin-route-step--draggable`}
                          draggable
                          tabIndex={0}
                          data-operation-code={op.code}
                          onDragStart={(e) => {
                            setDrag({ kind: 'pool', operationId: op.id });
                            e.dataTransfer.effectAllowed = 'copyMove';
                            e.dataTransfer.setData('text/plain', op.id);
                          }}
                          onDragEnd={() => {
                            setDrag(null);
                            setOverSlot(null);
                          }}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault();
                              insertAt(op, draft.length);
                            }
                          }}
                          title={`${op.name} — перетащите в маршрут или нажмите Enter, чтобы добавить в конец`}
                        >
                          <span className="admin-route-step__num" aria-hidden>
                            <Plus size={11} strokeWidth={2} />
                          </span>
                          <span className="admin-route-step__icon" aria-hidden>
                            <Icon size={14} strokeWidth={1.7} />
                          </span>
                          <span className="admin-route-step__name">
                            {op.name}
                          </span>
                          {op.rateRub != null && (
                            <span className="admin-route-step__meta">
                              {op.rateRub} ₽
                            </span>
                          )}
                        </span>
                      );
                    })}
                  </div>
                </div>
              ))
            )}
            {drag?.kind === 'step' && (
              <p className="rb-pool__drophint">
                Бросьте сюда, чтобы убрать операцию из маршрута
              </p>
            )}
          </div>
        </section>
      </div>

      <p className="rb-live" role="status" aria-live="polite">
        {announce}
      </p>

      {blocked && (
        <div role="alert" className="amend-note amend-note--bad">
          <XCircle size={14} strokeWidth={1.6} aria-hidden />
          {blocked}
        </div>
      )}
      {formState.error && (
        <div role="alert" className="amend-note amend-note--bad">
          <XCircle size={14} strokeWidth={1.6} aria-hidden />
          {formState.error}
        </div>
      )}

      <div className="admin-actions-row">
        <SaveButton disabled={!canSubmit} />
        <button
          type="button"
          className="admin-btn admin-btn--ghost"
          onClick={() => {
            setDraft(initial);
            setReason('');
          }}
          disabled={!dirty}
        >
          Вернуть как было
        </button>
        <button
          type="button"
          className="admin-btn admin-btn--ghost"
          onClick={onClose}
        >
          Отмена
        </button>
        <span className="admin-muted amend-foot">
          Пересчитает плановую стоимость и время. Расценку новой операции
          можно уточнить во вкладке «Операции».
        </span>
      </div>
    </form>
  );
}
