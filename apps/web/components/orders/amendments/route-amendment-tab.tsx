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
  ArrowLeft,
  ArrowLeftRight,
  ArrowRight,
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
import {
  fromOption,
  normalizeLinks,
  toDraft,
  toPayloadSteps,
  type DraftStep,
} from './route-draft';
import { applyRouteAmendmentAction } from '@/app/admin/orders/[id]/amendment-actions';
import { initialRouteAmendmentFormState } from '@/app/admin/orders/[id]/amendment-form-state';

interface Props {
  orderId: string;
  state: OperationAmendmentStateDto;
  onClose: () => void;
  /**
   * Тач-режим (кабинет мастера, `/master` → «Заказы»). HTML5
   * drag&drop на телефоне не работает вообще: событий `dragstart` у
   * touch-устройств нет, и холст без этого режима был бы там просто
   * картинкой. Поэтому в compact-режиме:
   *   - шаг ВЫБИРАЕТСЯ тапом, а действия (влево/вправо/связать/убрать)
   *     переезжают в панель под холстом — вместо 18-пиксельных кнопок
   *     внутри чипа, в которые пальцем не попасть;
   *   - палитра операций выезжает нижним листом по тапу на слот «+»,
   *     а не стоит колонкой справа: 300 px под неё на телефоне нет.
   * Мышиный drag&drop при этом остаётся рабочим — режим ничего не
   * отключает, только добавляет второй способ ввода.
   */
  compact?: boolean;
}

/** Что сейчас тащим: чип палитры или шаг цепочки. */
type DragSource =
  | { kind: 'pool'; operationId: string }
  | { kind: 'step'; index: number };

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
  onPick,
  parallelWithPrev,
  chipRef,
  compact = false,
  picked = false,
}: {
  step: DraftStep;
  num: number;
  draggable: boolean;
  onDragStart?: (e: React.DragEvent) => void;
  onDragEnd?: () => void;
  onToggleParallel?: () => void;
  onRemove?: () => void;
  onKeyDown?: (e: React.KeyboardEvent) => void;
  /** Тач-режим: тап по чипу выбирает шаг (действия — в панели ниже). */
  onPick?: () => void;
  parallelWithPrev: boolean;
  chipRef?: (el: HTMLSpanElement | null) => void;
  compact?: boolean;
  picked?: boolean;
}) {
  const Icon = routeStepIcon(step.category);
  const tone = routeStepTone(step.category);
  const classes = [
    'admin-route-step',
    tone,
    step.frozen ? 'admin-route-step--frozen' : '',
    draggable ? 'admin-route-step--draggable' : '',
    step.isNew ? 'admin-route-step--new' : '',
    compact ? 'admin-route-step--tap' : '',
    picked ? 'admin-route-step--picked' : '',
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
      onClick={compact ? onPick : undefined}
      role={compact ? 'button' : undefined}
      aria-pressed={compact ? picked : undefined}
      tabIndex={compact || draggable ? 0 : -1}
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
      {/* В тач-режиме микро-кнопки внутри чипа не рисуем: 18 px — не
          палец. Те же действия живут в панели под холстом. */}
      {!step.frozen && !compact && (
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

export function RouteAmendmentTab({
  orderId,
  state,
  onClose,
  compact = false,
}: Props) {
  const initial = useMemo(() => toDraft(state.steps), [state.steps]);
  const [draft, setDraft] = useState<DraftStep[]>(initial);
  const [reason, setReason] = useState('');
  const [query, setQuery] = useState('');
  const [drag, setDrag] = useState<DragSource | null>(null);
  const [overSlot, setOverSlot] = useState<number | null>(null);
  const [overPool, setOverPool] = useState(false);
  const [blocked, setBlocked] = useState<string | null>(null);
  const [announce, setAnnounce] = useState('');
  /**
   * Тач-режим: выбранный шаг храним по `key`, а не по индексу — после
   * перестановки индекс уезжает, и панель действий показывала бы уже
   * соседний шаг.
   */
  const [pickedKey, setPickedKey] = useState<string | null>(null);
  /** Слот, в который откроется палитра нижним листом; `null` — лист закрыт. */
  const [poolAt, setPoolAt] = useState<number | null>(null);
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

  /** Выбранный тапом шаг (тач-режим); −1 — ничего не выбрано. */
  const pickedIndex =
    pickedKey === null ? -1 : draft.findIndex((s) => s.key === pickedKey);
  const picked = pickedIndex >= 0 ? draft[pickedIndex] : null;

  /**
   * Сколько раз операция стоит в текущем черновике маршрута. Операцию из
   * палитры НЕ убираем — одна и та же операция может стоять в маршруте
   * несколько раз (ОТК/ВТО, чередующиеся со швейными шагами), — но чип
   * показывает счётчик, чтобы повтор был осознанным, а не промахом мышью.
   */
  const countByOperationId = useMemo(() => {
    const map = new Map<string, number>();
    for (const s of draft) {
      map.set(s.operationId, (map.get(s.operationId) ?? 0) + 1);
    }
    return map;
  }, [draft]);

  const pool = useMemo(() => {
    const q = query.trim().toLowerCase();
    const byId = new Map<string, OperationAmendmentOptionDto>();
    for (const op of state.availableOperations) byId.set(op.id, op);
    // Операции, которых нет в палитре справочника (архивные), но которые
    // стоят в маршруте: иначе убранный шаг нельзя было бы вернуть назад.
    for (const s of initial) {
      if (byId.has(s.operationId)) continue;
      byId.set(s.operationId, {
        id: s.operationId,
        code: s.code,
        name: s.name,
        category: s.category,
        rateRub: s.rateRub,
        timeNormSec: s.timeNormSec,
      });
    }
    const all = [...byId.values()].filter(
      (op) => !q || op.name.toLowerCase().includes(q),
    );
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
  }, [state.availableOperations, initial, query]);

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

  /**
   * Человекочитаемая сводка — то же, что бэкенд запишет в журнал. Считается
   * по ПОЗИЦИЯМ снимка (`sourceIndex`), а не по операциям: при повторах
   * операции в маршруте «добавлено/убрано/переставлено» относится к
   * конкретному вхождению, и сравнение по `operationId` показывало бы
   * добавление второго ОТК как «ничего не изменилось».
   */
  const changes = useMemo(() => {
    const keptSources = new Set(
      draft.map((s) => s.sourceIndex).filter((v): v is number => v !== null),
    );
    const out: { tone: string; label: string; text: string }[] = [];
    draft.forEach((s, i) => {
      if (s.sourceIndex !== null) return;
      const prev = draft[i - 1];
      out.push({
        tone: 'ok',
        label: 'Добавлено',
        text: `«${s.name}» ${prev ? `после «${prev.name}»` : 'в начало'}`,
      });
    });
    initial.forEach((s) => {
      if (s.sourceIndex !== null && keptSources.has(s.sourceIndex)) return;
      out.push({ tone: 'danger', label: 'Убрано', text: `«${s.name}»` });
    });
    // Перестановка считается по относительному порядку выживших шагов:
    // вставка в начало сдвигает хвост, но это не перестановка.
    const survivedBefore = initial
      .map((s) => s.sourceIndex)
      .filter((v): v is number => v !== null && keptSources.has(v));
    const survivedAfter = draft
      .map((s) => s.sourceIndex)
      .filter((v): v is number => v !== null);
    draft.forEach((s, i) => {
      if (s.sourceIndex === null) return;
      if (
        survivedBefore.indexOf(s.sourceIndex) ===
        survivedAfter.indexOf(s.sourceIndex)
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
      const before =
        s.sourceIndex === null
          ? undefined
          : initial.find((x) => x.sourceIndex === s.sourceIndex);
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
   * Приведение связей после перестановки/вставки — вся логика в чистом
   * `normalizeLinks` (`./route-draft`), здесь только запись в состояние.
   */
  const applyRows = (rows: DraftStep[]) => setDraft(normalizeLinks(rows, minSlot));

  /**
   * Вставка из палитры. Если у операции есть вхождение в снимке, которое
   * сейчас выброшено из черновика, — возвращаем ИМЕННО ЕГО, а не новый шаг:
   * за строкой снимка висят per-order расценка и норма времени, а метка
   * «новая» на возвращённом шаге была бы враньём. Если все вхождения
   * операции уже стоят в маршруте — добавляем ЕЩЁ ОДНО: повторы разрешены.
   */
  const insertAt = (op: OperationAmendmentOptionDto, at: number) => {
    const usedSources = new Set(draft.map((s) => s.sourceIndex));
    const restored = initial.find(
      (s) => s.operationId === op.id && !usedSources.has(s.sourceIndex),
    );
    const next = draft.slice();
    next.splice(at, 0, restored ? { ...restored, linkedWithPrev: false } : fromOption(op));
    applyRows(next);
    // Лист палитры закрывается сам: тап по операции — это завершённое
    // действие «вставить сюда», а не выбор в списке.
    setPoolAt(null);
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

  /**
   * Перестановка шага на соседнюю позицию — общий код для Alt+←/→ и для
   * кнопок «влево/вправо» тач-панели.
   */
  const moveStep = (i: number, to: number) => {
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
  };

  const removeAt = (i: number) => {
    const step = draft[i];
    if (step.frozen) {
      reject('Шаг уже проходят паспорта — убрать нельзя');
      return;
    }
    // Выработка привязана к операции, а не к строке маршрута: пока в
    // маршруте остаётся другое вхождение той же операции, лишнее убирается
    // свободно. Блокируем только последнее (тот же гейт держит backend —
    // нарушение `STEP_HAS_WORK`).
    if (step.hasWork && (countByOperationId.get(step.operationId) ?? 0) <= 1) {
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
    // Тач-режим: чип — `role="button"`, но остаётся `<span>`, поэтому
    // Enter/Space на нём надо обработать руками, иначе с клавиатуры шаг
    // не выбрать вовсе.
    if (compact && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      pickStep(i);
      return;
    }
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
      moveStep(i, i + (e.key === 'ArrowLeft' ? -1 : 1));
    }
  };

  /**
   * Тап по шагу в тач-режиме. Замороженный шаг не выбираем: над ним нет
   * ни одного доступного действия, и пустая панель действий читалась бы
   * как «сломалось». Вместо неё — та же причина запрета, что в подсказке
   * чипа.
   */
  const pickStep = (i: number) => {
    const step = draft[i];
    if (step.frozen) {
      reject('Шаг уже проходят паспорта — изменение недоступно');
      setPickedKey(null);
      return;
    }
    setPickedKey((cur) => (cur === step.key ? null : step.key));
  };

  /** Тап по слоту «+» в тач-режиме: открыть палитру именно на эту позицию. */
  const openPoolAt = (at: number) => {
    if (at < minSlot) {
      reject('Сюда нельзя: шаг уже проходят паспорта');
      return;
    }
    setPickedKey(null);
    setQuery('');
    setPoolAt(at);
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
    const classes = `rb-slot${locked ? ' rb-slot--locked' : ''}${
      isOver ? ' rb-slot--over' : ''
    }${compact ? ' rb-slot--tap' : ''}`;
    const inner = (
      <>
        <span className="rb-slot__arrow">
          {compact ? '+' : locked ? '✕' : at === draft.length ? '＋' : '→'}
        </span>
        <span className="rb-slot__label">
          {locked ? 'нельзя' : 'вставить сюда'}
        </span>
      </>
    );
    const dnd = {
      onDragOver: (e: React.DragEvent) => {
        if (!drag) return;
        setOverSlot(at);
        if (locked) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = drag.kind === 'pool' ? 'copy' : 'move';
      },
      onDragLeave: () => setOverSlot((cur) => (cur === at ? null : cur)),
      onDrop: (e: React.DragEvent) => {
        e.preventDefault();
        setOverSlot(null);
        dropAt(at);
      },
    };
    // В тач-режиме слот — настоящая кнопка: он единственный способ
    // вставить операцию пальцем, значит должен быть в табуляции и иметь
    // имя для screen reader'а (в мышином режиме это чисто визуальная
    // стрелка цепочки, и она остаётся `aria-hidden`).
    return compact ? (
      <button
        key={`slot:${at}`}
        type="button"
        className={classes}
        data-at={at}
        onClick={() => openPoolAt(at)}
        aria-label={
          locked
            ? 'Вставка недоступна: шаг уже проходят паспорта'
            : at === draft.length
              ? 'Добавить операцию в конец маршрута'
              : `Добавить операцию перед шагом ${at + 1}`
        }
        {...dnd}
      >
        {inner}
      </button>
    ) : (
      <span key={`slot:${at}`} className={classes} data-at={at} aria-hidden {...dnd}>
        {inner}
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

      {/* `rb--compact` заставляет холст быть одноколоночным независимо от
          ширины ОКНА: медиазапрос `.rb` смотрит на viewport, а холст
          мастера живёт в 720-пиксельной колонке `.master-page` — на
          большом мониторе он иначе оставил бы пустую колонку под
          палитру, которой в тач-режиме там нет. */}
      <div
        className={`rb${drag ? ' rb--dragging' : ''}${
          compact ? ' rb--compact' : ''
        }`}
      >
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
                        compact={compact}
                        picked={compact && s.key === pickedKey}
                        onPick={() => pickStep(i)}
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

            {/* Тач-режим: действия над выбранным шагом. Недоступные кнопки
                не прячем, а гасим с объяснением — «почему нельзя» здесь
                важнее, чем короткий ряд кнопок. */}
            {compact && picked && (
              <div className="rb-touch" role="group" aria-label="Действия над шагом">
                <div className="rb-touch__head">
                  <span className="rb-touch__title">
                    Шаг {pickedIndex + 1} · {picked.name}
                  </span>
                  <button
                    type="button"
                    className="rb-touch__close"
                    onClick={() => setPickedKey(null)}
                    aria-label="Снять выделение шага"
                  >
                    <X size={16} strokeWidth={1.8} aria-hidden />
                  </button>
                </div>
                <div className="rb-touch__acts">
                  <button
                    type="button"
                    className="rb-touch__act"
                    onClick={() => moveStep(pickedIndex, pickedIndex - 1)}
                    disabled={pickedIndex <= minSlot}
                    title={
                      pickedIndex <= minSlot
                        ? 'Левее — шаги, которые уже проходят паспорта'
                        : 'Передвинуть на шаг влево'
                    }
                  >
                    <ArrowLeft size={18} strokeWidth={1.9} aria-hidden />
                    влево
                  </button>
                  <button
                    type="button"
                    className="rb-touch__act"
                    onClick={() => moveStep(pickedIndex, pickedIndex + 1)}
                    disabled={pickedIndex >= draft.length - 1}
                    title="Передвинуть на шаг вправо"
                  >
                    <ArrowRight size={18} strokeWidth={1.9} aria-hidden />
                    вправо
                  </button>
                  <button
                    type="button"
                    className={`rb-touch__act${
                      picked.linkedWithPrev ? ' rb-touch__act--on' : ''
                    }`}
                    onClick={() => toggleParallel(pickedIndex)}
                    disabled={pickedIndex <= minSlot}
                    aria-pressed={picked.linkedWithPrev}
                    title="Параллельно с предыдущим шагом (порядок внутри группы любой)"
                  >
                    <ArrowLeftRight size={18} strokeWidth={1.9} aria-hidden />
                    {picked.linkedWithPrev ? 'разделить' : 'связать'}
                  </button>
                  <button
                    type="button"
                    className="rb-touch__act rb-touch__act--danger"
                    onClick={() => {
                      removeAt(pickedIndex);
                      setPickedKey(null);
                    }}
                    disabled={
                      picked.hasWork &&
                      (countByOperationId.get(picked.operationId) ?? 0) <= 1
                    }
                    title={
                      picked.hasWork
                        ? 'По операции уже есть выработка — убрать нельзя'
                        : 'Убрать из маршрута'
                    }
                  >
                    <X size={18} strokeWidth={1.9} aria-hidden />
                    убрать
                  </button>
                </div>
                {picked.hasWork &&
                  (countByOperationId.get(picked.operationId) ?? 0) <= 1 && (
                    <p className="rb-touch__hint">
                      По операции «{picked.name}» уже есть выработка — из
                      маршрута её не убрать.
                    </p>
                  )}
              </div>
            )}

            <div className="rb-changes">
              {changes.length === 0 ? (
                <p className="rb-changes__empty">
                  {compact
                    ? 'Изменений пока нет — тапните шаг, чтобы передвинуть, или «+», чтобы добавить операцию.'
                    : 'Изменений пока нет — перетащите операцию из списка справа.'}
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

        {/* Палитра. На десктопе — вторая колонка холста; в тач-режиме тот
            же блок выезжает нижним листом по тапу на слот «+» (см.
            `openPoolAt`) и знает позицию вставки. */}
        {(!compact || poolAt !== null) && (
        <section
          className={`rb-panel rb-pool${overPool ? ' rb-pool--over' : ''}${
            compact ? ' rb-pool--sheet' : ''
          }`}
          role={compact ? 'dialog' : undefined}
          aria-modal={compact ? true : undefined}
          aria-label={compact ? 'Добавить операцию' : undefined}
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
            <span className="rb-panel__title">
              {compact ? 'Добавить операцию' : 'Операции справочника'}
            </span>
            {compact && poolAt !== null ? (
              <>
                <span className="rb-panel__hint">
                  {poolAt === 0
                    ? 'в начало маршрута'
                    : poolAt >= draft.length
                      ? 'в конец маршрута'
                      : `после «${draft[poolAt - 1]?.name ?? ''}»`}
                </span>
                <button
                  type="button"
                  className="rb-touch__close"
                  onClick={() => setPoolAt(null)}
                  aria-label="Закрыть список операций"
                >
                  <X size={18} strokeWidth={1.8} aria-hidden />
                </button>
              </>
            ) : (
              <span className="rb-panel__hint">
                {pool.reduce((a, g) => a + g.items.length, 0)}
              </span>
            )}
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
                {query.trim()
                  ? 'Ничего не найдено — уточните запрос.'
                  : 'В справочнике нет активных операций.'}
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
                      const inRoute = countByOperationId.get(op.id) ?? 0;
                      return (
                        <span
                          key={op.id}
                          className={`admin-route-step ${routeStepTone(
                            op.category,
                          )} admin-route-step--draggable`}
                          data-in-route={inRoute || undefined}
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
                              insertAt(op, poolAt ?? draft.length);
                            }
                          }}
                          // В тач-режиме тап по операции = вставка в тот
                          // слот, из которого открыт лист. В мышином —
                          // клика нет: там drag&drop и Enter.
                          onClick={
                            compact
                              ? () => insertAt(op, poolAt ?? draft.length)
                              : undefined
                          }
                          role={compact ? 'button' : undefined}
                          title={
                            compact
                              ? inRoute > 0
                                ? `${op.name} — уже в маршруте (${inRoute}). Тапните, чтобы поставить ещё раз`
                                : `${op.name} — тапните, чтобы вставить`
                              : inRoute > 0
                                ? `${op.name} — уже в маршруте (${inRoute}). Операцию можно поставить ещё раз: перетащите или нажмите Enter`
                                : `${op.name} — перетащите в маршрут или нажмите Enter, чтобы добавить в конец`
                          }
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
                          {inRoute > 0 && (
                            <span
                              className="admin-route-step__tag"
                              title="Столько раз операция уже стоит в маршруте"
                            >
                              ×{inRoute}
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
        )}
        {compact && poolAt !== null && (
          <button
            type="button"
            className="rb-pool__scrim"
            onClick={() => setPoolAt(null)}
            aria-label="Закрыть список операций"
          />
        )}
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
