'use client';

/**
 * Инлайн-спецификация расцветки: материалы техкарты заказа + параметры.
 * Раскрывается прямо В КАРТОЧКЕ блока «Расцветки» (замена модалки
 * `colorway-params-window.tsx`, решение 16.07: «техкарта живёт в заказе»).
 *
 * Правится ЛЮБАЯ строка — и шаблонная, и ручная: название, норма, ед.,
 * цвет, плотность. Любую можно убрать (последнюю шаблонную backend отбивает
 * — пересборка вернула бы её), свою — добавить. Обязательных полей нет.
 *
 * Ячейка под параметром (`boundFields`) напрямую не правится — два писателя
 * в одну ячейку запрещены. Для плотности редактор параметра рендерится
 * ПРЯМО в строке материала (это самый частый случай); прочие параметры —
 * компактным списком ниже.
 *
 * Окно правки шире, чем у расцветок: спецификация правится и после расчёта,
 * и в производстве (`params.editMode === 'AMENDMENT'` — с предупреждением и
 * записью в журнал правок), закрыта только на `DONE`/`CANCELLED`. Право
 * даёт бэкенд, компонент его не переизобретает.
 *
 * Состояние наверху: каждый write возвращает свежий полный DTO, компонент
 * поднимает его в блок через `onData` — все карточки видят одно состояние.
 */

import { Fragment, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  ORDER_TECH_CARD_LINES_BATCH_MAX,
  resolveVariantParamsGroup,
  type OrderTechCardLineDto,
  type OrderTechCardParametersDto,
  type OrderTechCardVariantParamsDto,
} from '@sewing/shared/order-tech-cards';
import type { OrderTechCardParameterDto } from '@sewing/shared/tech-card-parameters';
import {
  TECH_CARD_PARAMETER_INPUT_TYPES,
  TECH_CARD_PARAMETER_INPUT_TYPE_LABELS,
} from '@sewing/shared/tech-card-parameters';
import {
  getMaterialCharacteristic,
  getMaterialSubtype,
} from '@sewing/shared/material-characteristics';
import {
  needsPurchaseConversion,
  normalizeUnit,
} from '@sewing/shared/norm-purchase';
import {
  DEFAULT_NORM_UNIT,
  getNormUnitOptions,
  getPurchaseUnitOptions,
} from '@sewing/shared/purchase-units';
import {
  characteristicValueFromSubtypeKey,
  resolveSubtypeKeyByCharacteristic,
} from '@sewing/shared/material-characteristic-options';
import { CharacteristicCombobox } from '@/components/materials/characteristic-combobox';

import {
  applyTechCardParamToAllAction,
  createTechCardLinesAction,
  createTechCardParamAction,
  deleteTechCardLineAction,
  deleteTechCardParamAction,
  reloadTechCardFromTemplateAction,
  reloadTechCardNormsAction,
  saveTechCardAsTemplateAction,
  setTechCardParamValueAction,
  updateTechCardLineAction,
  type TechCardParamsActionResult,
} from '@/app/admin/orders/[id]/tech-card-params-actions';

interface Props {
  orderId: string;
  params: OrderTechCardParametersDto;
  /** Чья карточка (null = order-level группа при 0–1 расцветке). */
  variantId: string | null;
  /** Поднять свежий DTO в блок — единое состояние для всех карточек. */
  onData: (data: OrderTechCardParametersDto) => void;
}

/**
 * Черновая строка материала — та, что заполняется ПРЯМО В ТАБЛИЦЕ, ячейка под
 * ячейкой с сохранёнными строками. Отдельной формы под таблицей больше нет:
 * у таблицы `auto`-раскладка, ширины колонок задаёт содержимое, и повторить
 * их снаружи нельзя — форма разъезжалась на первом длинном названии.
 *
 * Черновиков может быть сколько угодно (до `ORDER_TECH_CARD_LINES_BATCH_MAX`):
 * фурнитура заводится списком, а не по одному материалу за заход.
 */
interface DraftLine {
  /** Локальный ключ строки — id появится только после сохранения. */
  key: string;
  name: string;
  qtyPerUnit: string;
  /**
   * Единица НОРМЫ — в ней вводится `qtyPerUnit`. Селект с дефолтом
   * «м пог.»: свободный ввод плодил варианты написания («мп», «пог м»).
   */
  normUnit: string;
  /**
   * Единица ЗАКУПКИ (`unit`) — в ней посчитается `totalQty`. Пока её не
   * трогали, зеркалит единицу нормы. Выбрали другую — строка уедет сразу
   * расщеплённой (`normUnit ≠ unit`); пересчёт «К закупке» заработает,
   * когда в параметрах заполнят ширину рулона и плотность.
   */
  unit: string;
  colorText: string;
}

function emptyDraft(seq: number): DraftLine {
  return {
    key: `d${seq}`,
    name: '',
    qtyPerUnit: '',
    normUnit: DEFAULT_NORM_UNIT,
    unit: DEFAULT_NORM_UNIT,
    colorText: '',
  };
}

/** Готова ли строка к отправке: обязательны название, норма и единица. */
function isDraftReady(d: DraftLine): boolean {
  const qty = Number(d.qtyPerUnit.trim().replace(',', '.'));
  return (
    d.name.trim() !== '' &&
    d.unit.trim() !== '' &&
    Number.isFinite(qty) &&
    qty > 0
  );
}

/** «1 материал» / «2 материала» / «5 материалов» — иначе кнопка косноязычит. */
function pluralMaterials(n: number): string {
  const d10 = n % 10;
  const d100 = n % 100;
  if (d10 === 1 && d100 !== 11) return `${n} материал`;
  if (d10 >= 2 && d10 <= 4 && (d100 < 12 || d100 > 14)) return `${n} материала`;
  return `${n} материалов`;
}

/**
 * Пустая строка — её не считаем ни готовой, ни ошибочной. Единицы не
 * смотрим: у селектов есть значения по умолчанию, и они не признак того,
 * что человек начал заполнять строку.
 */
function isDraftBlank(d: DraftLine): boolean {
  return (
    d.name.trim() === '' &&
    d.qtyPerUnit.trim() === '' &&
    d.colorText.trim() === ''
  );
}

/**
 * Что мешает строке уехать. Тексты — дословно из
 * `CreateOrderTechCardLineSchema`: один источник правды на клиента и сервер.
 */
function draftProblem(d: DraftLine): string | null {
  const problems: string[] = [];
  if (d.name.trim() === '') problems.push('Укажите название материала');
  const qty = Number(d.qtyPerUnit.trim().replace(',', '.'));
  if (!Number.isFinite(qty) || qty <= 0) {
    problems.push('Норма расхода — положительное число');
  }
  if (d.unit.trim() === '') problems.push('Укажите единицу измерения');
  return problems.length > 0 ? `${problems.join('. ')}.` : null;
}

/**
 * Строка без характеристик — «должник» по параметрам. Это не ошибка:
 * заведение специально не требует плотность и ширину, они дозаполняются
 * после. Долг видно чипом в колонке «Параметры» и проходом «Дальше →».
 *
 * Достаточно ХАРАКТЕРИСТИКИ (`fabricType`/`subtypeKey`): она задаёт набор
 * полей, а сами значения могут быть неизвестны (состав ленты никто не
 * спрашивает). Гейта на расчёт из этого не делаем — обязательность
 * параметров сняли 16.07.
 */
function needsParams(line: OrderTechCardLineDto): boolean {
  return (line.fabricType ?? '').trim() === '' && !line.subtypeKey;
}

/**
 * Источник нормы — КОМПАКТНЫЙ индикатор: буква + цвет, расшифровка по
 * наведению. Текстовые бейджи («из номенклатуры» / «из шаблона») занимали
 * половину колонки и перетягивали внимание с самого числа, хотя нужны лишь
 * тогда, когда норма вызывает вопрос.
 */
const QTY_SOURCE_BADGE: Record<string, { letter: string; title: string }> = {
  NOMENCLATURE: {
    letter: 'Н',
    title:
      'Норма из номенклатуры — пересчёт заказа освежает её по размерному плану',
  },
  TEMPLATE: {
    letter: 'Ш',
    title:
      'Норма из шаблона техкарты — в номенклатуре подходящего параметра не нашлось',
  },
  ORDER: {
    letter: 'З',
    title:
      'Норма правлена в заказе — она главнее номенклатуры и переживает пересчёт',
  },
};

/**
 * Характеристики, которые показываем в панели строки.
 *
 * Набор задаёт ПОДТИП (`getMaterialSubtype`) — тот же источник, что в
 * редакторе шаблона, чтобы «параметры» в заказе и в справочнике значили одно
 * и то же. Подтип не выбран (старые строки) — показываем то, что уже
 * заполнено, плюс базовую пару для роли, иначе панель была бы пустой и
 * править было бы нечего.
 */
function characteristicKeysForLine(line: OrderTechCardLineDto): string[] {
  const subtype = line.subtypeKey ? getMaterialSubtype(line.subtypeKey) : null;
  const keys = subtype ? subtype.characteristics.map((c) => c.key) : [];
  if (keys.length === 0) {
    keys.push(
      ...(line.materialRole === 'PACKAGING'
        ? ['size', 'material', 'type', 'length']
        : ['density', 'rollWidth']),
    );
  }
  for (const k of Object.keys(line.characteristics ?? {})) {
    if (!keys.includes(k)) keys.push(k);
  }
  return keys;
}

const emptyAdHoc = {
  label: '',
  inputType: 'TEXT' as string,
  options: '',
  unit: '',
  value: '',
  target: '',
};

export function ColorwaySpec({
  orderId,
  params,
  variantId,
  onData,
}: Props) {
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  /** Пачка черновых строк: заводим списком, сохраняем одним запросом. */
  const [drafts, setDrafts] = useState<DraftLine[]>([]);
  const draftSeq = useRef(0);
  /**
   * Строки, добавленные последней пачкой, — для баннера «параметры не
   * заданы». Именно id, а не счётчик: долг надо считать по СВОИМ строкам,
   * иначе баннер приплюсовал бы шаблонные строки без характеристик, которые
   * лежали в таблице и до пачки. Пусто = баннера нет.
   */
  const [addedIds, setAddedIds] = useState<string[]>([]);
  /**
   * Очередь дозаполнения параметров: список id строк-должников, снятый в
   * момент нажатия «Заполнить параметры». Список фиксируем, а не считаем на
   * лету, иначе строка, у которой параметры только что задали, исчезала бы
   * из очереди и сбивала нумерацию «материал 2 из 3».
   */
  const [queue, setQueue] = useState<string[] | null>(null);
  const [adHoc, setAdHoc] = useState<typeof emptyAdHoc | null>(null);
  const [saveAs, setSaveAs] = useState<{ code: string; name: string } | null>(
    null,
  );
  /** Строка, у которой раскрыта панель параметров (одна за раз). */
  const [openLine, setOpenLine] = useState<string | null>(null);
  const router = useRouter();

  const group: OrderTechCardVariantParamsDto | undefined =
    resolveVariantParamsGroup(params, variantId);
  // Право на правку — целиком с бэкенда (`editMode`), а не от родителя:
  // расцветка замораживается вместе с планом заказа, а спецификация живёт
  // дольше (см. `OrderTechCardEditMode`).
  const ro = !params.editable;
  // За окном планирования правка идёт amendment-путём: снимок материалов и
  // план операций пересобираются, маршрут и паспорта — нет, потребности
  // пересчитываются best-effort, событие уходит в журнал правок.
  const amendment = params.editMode === 'AMENDMENT';
  // Таблица всегда в «расщеплённом» виде: зона расхода + зона закупки.
  // Раньше закупочные колонки появлялись только при строке с normUnit ≠
  // unit, но селект единицы закупки живёт именно в них — прятать его
  // значило бы «расщепить строку нельзя, пока какая-нибудь уже не
  // расщеплена».
  const cols = 10;

  /**
   * Тираж расцветки — чтобы показать «Итого» черновика ДО сохранения.
   * В DTO группы плана нет, но он однозначно выводится из любой сохранённой
   * строки: `итого / норма`. Ошибка в норме так видна сразу, а не после
   * пересборки. Не вывелся (строк ещё нет) — показываем прочерк, врать числом
   * нельзя.
   */
  const unitsPlan = (() => {
    for (const l of group?.lines ?? []) {
      const per = Number(l.qtyPerUnit);
      const total = Number(l.normUnit ? (l.totalNorm ?? '') : l.totalQty);
      if (!Number.isFinite(per) || per <= 0) continue;
      if (!Number.isFinite(total) || total <= 0) continue;
      return Math.round(total / per);
    }
    return null;
  })();

  /**
   * Долг по параметрам — только у строк последней пачки: по чужим строкам
   * его показывать нечестно, их никто сейчас не заводил.
   */
  const paramDebtIds = (group?.lines ?? [])
    .filter((l) => needsParams(l) && addedIds.includes(l.id))
    .map((l) => l.id);

  function apply(r: TechCardParamsActionResult): void {
    if (!r.ok) {
      setError(r.error ?? 'Ошибка');
      return;
    }
    setError(null);
    if (r.data) onData(r.data);
    if (r.savedTemplate) {
      setNotice(
        `Шаблон «${r.savedTemplate.code} — ${r.savedTemplate.name}» создан. ` +
          'Значения остались в заказе.',
      );
      setSaveAs(null);
    }
    // Снимок материалов и потребность пересобраны на бэке — серверные части
    // карточки заказа надо перечитать.
    router.refresh();
  }

  if (!group) {
    return (
      <div className="cws">
        <SpecStyles />
        <p className="cws-muted">
          Спецификация появится после сохранения расцветки.
        </p>
      </div>
    );
  }

  // Ключ ЗАПИСИ — из группы, не из пропа: у единственной расцветки проп —
  // реальный id, а снимок живёт под order-level `null` (см. резолвер).
  const writeVariantId = group.orderVariantId;

  /** Параметр, владеющий плотностью строки, — рендерим прямо в строке. */
  function densityParamFor(lineId: string): OrderTechCardParameterDto | null {
    return (
      group!.parameters.find((p) =>
        p.targets.some(
          (t) => t.requirementId === lineId && t.field === 'char:density',
        ),
      ) ?? null
    );
  }
  // Параметры, у которых ВСЕ цели — плотность строк, показаны инлайн;
  // остальные (другие ячейки / «просто запись») — списком ниже.
  const otherParams = group.parameters.filter(
    (p) =>
      p.targets.length === 0 ||
      p.targets.some((t) => t.field !== 'char:density'),
  );

  // --- пачка черновых строк -------------------------------------------------

  function addDraft(): void {
    setDrafts((s) => {
      if (s.length >= ORDER_TECH_CARD_LINES_BATCH_MAX) return s;
      draftSeq.current += 1;
      return [...s, emptyDraft(draftSeq.current)];
    });
    setAddedIds([]);
  }

  function patchDraft(key: string, patch: Partial<DraftLine>): void {
    setDrafts((s) =>
      s.map((d) => (d.key === key ? { ...d, ...patch } : d)),
    );
  }

  function dropDraft(key: string): void {
    setDrafts((s) => s.filter((d) => d.key !== key));
  }

  const readyDrafts = drafts.filter((d) => isDraftReady(d));

  /**
   * Отправить ГОТОВЫЕ строки пачки. Неготовые остаются черновиками и не
   * теряются: держать из-за одной спорной строки остальные девять — дороже,
   * чем сохранить их сейчас и дозаполнить спорную потом.
   */
  function saveDrafts(): void {
    if (readyDrafts.length === 0 || pending) return;
    const payload = {
      orderVariantId: writeVariantId,
      // Единица закупки может отличаться от единицы нормы — тогда строка
      // создаётся сразу расщеплённой (уезжает `normUnit`). Пока ширина
      // рулона и плотность не заполнены, «К закупке» честно показывает
      // отказ пересчёта, а не длину, подписанную килограммами.
      lines: readyDrafts.map((d) => ({
        name: d.name.trim(),
        unit: d.unit.trim(),
        normUnit: needsPurchaseConversion(d.normUnit, d.unit)
          ? d.normUnit.trim()
          : null,
        qtyPerUnit: d.qtyPerUnit.trim().replace(',', '.'),
        colorText: d.colorText.trim() || null,
      })),
    };
    const keptKeys = new Set(
      drafts.filter((d) => !isDraftReady(d) && !isDraftBlank(d)).map((d) => d.key),
    );
    // Что лежало в группе ДО пачки — чтобы отличить свои новые строки от
    // чужих: id генерирует бэкенд, заранее их не знаем.
    const before = new Set(group!.lines.map((l) => l.id));
    startTransition(async () => {
      const r = await createTechCardLinesAction(orderId, payload);
      if (r.ok) {
        setDrafts((s) => s.filter((d) => keptKeys.has(d.key)));
        const fresh = r.data
          ? (resolveVariantParamsGroup(r.data, variantId)?.lines ?? [])
              .filter((l) => !before.has(l.id))
              .map((l) => l.id)
          : [];
        setAddedIds(fresh);
        setQueue(null);
      }
      apply(r);
    });
  }

  /**
   * Клавиатура пачки: заведение списка — это набор, а не редактирование.
   * `Enter` в последней ячейке строки продолжает список, `Ctrl+Enter`
   * сохраняет, `Esc` убирает пустой черновик.
   */
  function draftKeyDown(
    e: React.KeyboardEvent,
    draft: DraftLine,
    isLastCell: boolean,
  ): void {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      (e.target as HTMLInputElement).blur();
      saveDrafts();
      return;
    }
    if (e.key === 'Enter' && isLastCell) {
      e.preventDefault();
      addDraft();
      return;
    }
    if (e.key === 'Escape') {
      // Родитель закрывает окно спецификации по Escape из window-слушателя.
      // Из черновика это стоило бы всей несохранённой пачки, поэтому событие
      // дальше не пускаем — Esc здесь означает «убрать пустую строку».
      e.stopPropagation();
      e.preventDefault();
      if (isDraftBlank(draft)) dropDraft(draft.key);
    }
  }

  // --- очередь дозаполнения параметров ---------------------------------------

  // Очередь могла пережить удаление строки: держим её живой частью, иначе
  // «Дальше» открывало бы несуществующую строку, а счётчик «2 из 3» врал.
  const liveQueue =
    queue?.filter((id) => group.lines.some((l) => l.id === id)) ?? null;

  /** Начать проход по строкам без характеристик — с первой. */
  function startQueue(): void {
    if (paramDebtIds.length === 0) return;
    setQueue(paramDebtIds);
    setOpenLine(paramDebtIds[0] ?? null);
  }

  /** Следующая строка очереди; кончилась — проход закрывается. */
  function queueNext(): void {
    if (!liveQueue || liveQueue.length === 0) {
      setQueue(null);
      setOpenLine(null);
      return;
    }
    const i = liveQueue.indexOf(openLine ?? '');
    const next = i >= 0 ? liveQueue[i + 1] : liveQueue[0];
    if (!next) {
      setQueue(null);
      setOpenLine(null);
      return;
    }
    setOpenLine(next);
  }

  function saveLine(
    lineId: string,
    patch: Record<
      string,
      string | number | null | Record<string, string | number | null>
    >,
  ): void {
    startTransition(async () =>
      apply(await updateTechCardLineAction(orderId, lineId, patch)),
    );
  }
  function saveParam(parameterId: string, value: string | null): void {
    startTransition(async () =>
      apply(
        await setTechCardParamValueAction(orderId, parameterId, { value }),
      ),
    );
  }

  /** Редактор значения параметра (ENUM → select, иначе input). */
  function paramEditor(p: OrderTechCardParameterDto, compact = false) {
    if (p.options && p.options.length > 0) {
      return (
        <select
          className={compact ? 'cws-cell cws-cell--sm' : 'cws-cell'}
          disabled={ro || pending}
          value={p.value ?? ''}
          onChange={(e) => saveParam(p.id, e.target.value || null)}
        >
          <option value="">—</option>
          {p.options.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      );
    }
    return (
      <input
        key={`${p.id}:${p.value ?? ''}`}
        className={compact ? 'cws-cell cws-cell--sm' : 'cws-cell'}
        type={p.inputType === 'NUMBER' ? 'number' : 'text'}
        disabled={ro || pending}
        defaultValue={p.value ?? ''}
        placeholder="—"
        onBlur={(e) => {
          const next = e.target.value.trim();
          if (next === (p.value ?? '')) return;
          saveParam(p.id, next || null);
        }}
      />
    );
  }

  return (
    <div className="cws">
      <SpecStyles />
      {group.techCardName && (
        <p className="cws-muted cws-tpl">
          Из шаблона: <strong>{group.techCardName}</strong> — дальше список
          живёт в заказе, правки шаблона сюда не протекают.
        </p>
      )}
      {amendment && (
        <p className="cws-warn">
          Заказ уже прошёл расчёт. Правка пересчитает потребности цеха и
          плановую себестоимость, но <strong>не отменит</strong> уже
          выданные и закупленные материалы — разница останется видна в
          план-факте. Каждая правка попадёт в журнал правок заказа.
        </p>
      )}
      {ro && (
        <p className="cws-warn">
          Заказ закрыт (завершён или отменён) — спецификация только для
          просмотра.
        </p>
      )}
      {error && <p className="cws-error">{error}</p>}
      {notice && <p className="cws-notice">{notice}</p>}

      <div className="cws-tablewrap">
        <table className="cws-table">
          <thead>
            {/* Арифметика колонок: 2 + 4 + 1 + 2 + 1 = 10 — ровно столько
                ячеек в теле. Раньше зона расхода стояла на трёх колонках,
                строка выходила короче тела на одну, и заголовки съезжали
                влево: «Закупка» накрывала служебную стрелку вместо «К
                закупке», а тонировка зоны не совпадала со своей плашкой.
                «Цвет» попадает внутрь зоны расхода паразитом — это цена
                того, что колонки не переставляются местами. */}
            <tr>
              <th colSpan={2}></th>
              <th className="cws-grp cws-grp--norm" colSpan={4}>
                Расход — единица техкарты
              </th>
              <th></th>
              <th className="cws-grp cws-grp--buy" colSpan={2}>
                Закупка
              </th>
              <th></th>
            </tr>
            <tr>
              <th>Материал</th>
              <th>Параметры</th>
              <th className="num">Норма/шт</th>
              <th>Ед.</th>
              <th>Цвет</th>
              <th className="num">Расход</th>
              <th aria-label="Пересчёт"></th>
              <th className="cws-zone--buy">Ед.</th>
              <th className="num cws-zone--buy">К закупке</th>
              <th aria-label="Действия"></th>
            </tr>
          </thead>
          <tbody>
            {group.lines.length === 0 && drafts.length === 0 && (
              <tr>
                <td colSpan={cols} className="cws-muted">
                  Пока пусто: выберите техкарту расцветки — материалы придут из
                  шаблона, — или добавьте материалы вручную.
                </td>
              </tr>
            )}
            {group.lines.map((l) => {
              const dParam = l.boundFields.includes('char:density')
                ? densityParamFor(l.id)
                : null;
              const nameBound = l.boundFields.includes('core:name');
              const unitBound = l.boundFields.includes('core:unit');
              const qtyBound = l.boundFields.includes('core:qtyPerUnit');
              const boundTitle =
                'Ячейка привязана к параметру — правьте значение параметра';
              const normUnitCurrent = l.normUnit ?? l.unit;
              // Расщеплённость — НОРМАЛИЗОВАННО, как считает бэкенд: у
              // legacy-строки с normUnit='м' и unit='м пог.' totalNorm
              // придёт null, и ветвление по сырому normUnit рисовало бы
              // «— м» вместо числа.
              const lineSplit = needsPurchaseConversion(l.normUnit, l.unit);
              const purchaseOptions = getPurchaseUnitOptions({
                subtypeKey: l.subtypeKey,
                materialRole: l.materialRole,
                normUnit: normUnitCurrent,
                current: l.unit,
              });
              const open = openLine === l.id;
              const chips = characteristicKeysForLine(l)
                .map((key) => ({
                  key,
                  def: getMaterialCharacteristic(key),
                  value: (l.characteristics ?? {})[key],
                }))
                .filter((c) => c.value !== undefined && c.value !== '');
              // Чип-«шапка» строки — значение поля «Характеристика» (то, что
              // заменило подтип). У старых строк своего значения нет —
              // показываем лейбл подтипа, чтобы чип не пропал.
              const characteristicChip =
                (l.fabricType ?? '').trim() ||
                (l.subtypeKey
                  ? (getMaterialSubtype(l.subtypeKey)?.label ?? l.subtypeKey)
                  : null);
              return (
                <Fragment
                  key={`${l.id}:${l.name}:${l.qtyPerUnit}:${l.unit}:${l.normUnit ?? ''}:${l.colorText ?? ''}:${l.densityGsm ?? ''}:${l.subtypeKey ?? ''}:${JSON.stringify(l.characteristics ?? {})}`}
                >
                <tr>
                  <td>
                    <div className="cws-nameline">
                      <button
                        type="button"
                        className={`cws-caret${open ? ' is-open' : ''}`}
                        aria-expanded={open}
                        aria-label={`Параметры материала «${l.name}»`}
                        onClick={() => setOpenLine(open ? null : l.id)}
                      >
                        {open ? '⌄' : '›'}
                      </button>
                      <input
                        className="cws-cell cws-cell--name"
                        defaultValue={l.name}
                        disabled={ro || pending || nameBound}
                        title={nameBound ? boundTitle : undefined}
                        onBlur={(e) => {
                          const next = e.target.value.trim();
                          if (next && next !== l.name) saveLine(l.id, { name: next });
                        }}
                      />
                    </div>
                    <span className="cws-flags">
                      {l.isManual && (
                        <span className="cws-pill">добавлена в заказе</span>
                      )}
                      {dParam && (
                        <span className="cws-density">
                          {`${dParam.label}:`}
                          {paramEditor(dParam, true)}
                          {!ro && params.variants.length > 1 && (
                            <button
                              type="button"
                              className="cws-linkbtn"
                              disabled={pending}
                              title="Применить это значение ко всем расцветкам (разовое копирование)"
                              onClick={() =>
                                startTransition(async () =>
                                  apply(
                                    await applyTechCardParamToAllAction(
                                      orderId,
                                      dParam.id,
                                    ),
                                  ),
                                )
                              }
                            >
                              → все расцветки
                            </button>
                          )}
                          {dParam.unit && (
                            <span className="cws-muted">{dParam.unit}</span>
                          )}
                        </span>
                      )}
                    </span>
                  </td>
                  {/* Параметры материала: чипами — то, что заполнено. Вход в
                      правку БЕЗУСЛОВНЫЙ (пустая строка показывает «+ параметр»),
                      иначе у строки без характеристик их негде было бы завести. */}
                  <td>
                    <button
                      type="button"
                      className="cws-chips"
                      onClick={() => setOpenLine(open ? null : l.id)}
                      title="Открыть параметры материала"
                    >
                      {characteristicChip && (
                        <span className="cws-chip cws-chip--subtype">
                          {characteristicChip}
                        </span>
                      )}
                      {chips.map((c) => (
                        <span
                          key={c.key}
                          className={`cws-chip${
                            l.boundFields.includes(`char:${c.key}`)
                              ? ' cws-chip--slot'
                              : ''
                          }`}
                        >
                          {c.def?.label ?? c.key} <b>{String(c.value)}</b>
                          {c.def?.unit ? ` ${c.def.unit}` : ''}
                        </span>
                      ))}
                      {/* Долг по параметрам — приглашение, а не ошибка:
                          пунктир акцентом, не красный. Заведение специально
                          не требует характеристик, они дозаполняются после. */}
                      {chips.length === 0 && !characteristicChip && (
                        <span
                          className={`cws-chip ${
                            needsParams(l) ? 'cws-chip--todo' : 'cws-chip--empty'
                          }`}
                        >
                          {needsParams(l) ? 'задать параметры' : '+ параметр'}
                        </span>
                      )}
                    </button>
                  </td>
                  <td className="num">
                    <span className="cws-qty">
                    <input
                      className="cws-cell cws-cell--num"
                      inputMode="decimal"
                      defaultValue={l.qtyPerUnit}
                      disabled={ro || pending || qtyBound}
                      title={qtyBound ? boundTitle : undefined}
                      onBlur={(e) => {
                        const next = e.target.value.trim().replace(',', '.');
                        if (next === l.qtyPerUnit) return;
                        if (!Number.isFinite(Number(next)) || Number(next) <= 0) return;
                        saveLine(l.id, { qtyPerUnit: next });
                      }}
                    />
                    {/* Источник нормы: буква + цвет, расшифровка по наведению.
                        Без индикатора не отличить «подтянулось из
                        номенклатуры» от «стоит заглушка шаблона». */}
                    {l.qtySource && QTY_SOURCE_BADGE[l.qtySource] && (
                      <span
                        className={`cws-src cws-src--${l.qtySource.toLowerCase()}`}
                        title={
                          l.qtySourceLabel
                            ? `${QTY_SOURCE_BADGE[l.qtySource]!.title}. Источник: ${l.qtySourceLabel}`
                            : QTY_SOURCE_BADGE[l.qtySource]!.title
                        }
                        aria-label={QTY_SOURCE_BADGE[l.qtySource]!.title}
                      >
                        {QTY_SOURCE_BADGE[l.qtySource]!.letter}
                      </span>
                    )}
                    </span>
                  </td>
                  {/* Единица РАСХОДА. У расщеплённой строки это `normUnit` и
                      правится она отдельно от закупочной; у обычной — прежнее
                      поле `unit`, как и было. Селект вместо свободного ввода:
                      словарь по подтипу/роли, историческое значение вне
                      словаря остаётся первой опцией. */}
                  <td>
                    <select
                      className="cws-cell cws-cell--sm"
                      defaultValue={normUnitCurrent}
                      disabled={ro || pending || unitBound}
                      aria-label="Единица нормы"
                      title={
                        unitBound
                          ? boundTitle
                          : l.normUnit
                            ? 'Единица нормы расхода. Закупочная единица — в блоке «Закупка».'
                            : undefined
                      }
                      onChange={(e) => {
                        const next = e.target.value;
                        if (next === normUnitCurrent) return;
                        if (
                          needsPurchaseConversion(next, l.unit) &&
                          normalizeUnit(next) === 'м'
                        ) {
                          // Норма в метрах, закупка другая — расщепление
                          // (рождается у обычной строки, правится у
                          // расщеплённой). Закупочная единица и цена в
                          // потребности не трогаются.
                          saveLine(l.id, { normUnit: next });
                        } else {
                          // Единицы совпали либо пересчёт из «next»
                          // невозможен (не-метровая норма) — закупка следует
                          // за нормой, расщепление схлопывается: пара
                          // «шт → кг» была бы вечным отказом пересчёта.
                          saveLine(l.id, { unit: next, normUnit: null });
                        }
                      }}
                    >
                      {getNormUnitOptions({
                        subtypeKey: l.subtypeKey,
                        materialRole: l.materialRole,
                        current: normUnitCurrent,
                      }).map((u) => (
                        <option key={u} value={u}>
                          {u}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <input
                      className="cws-cell"
                      defaultValue={l.colorText ?? ''}
                      placeholder="—"
                      disabled={ro || pending}
                      onBlur={(e) => {
                        const next = e.target.value.trim();
                        if (next === (l.colorText ?? '')) return;
                        saveLine(l.id, { colorText: next || null });
                      }}
                    />
                  </td>
                  {/* Расход — в единице НОРМЫ; у нерасщеплённой строки это
                      прежнее «итого» в единице закупки, поле в поле. */}
                  <td className="num cws-total">
                    {lineSplit ? (l.totalNorm ?? '—') : l.totalQty}{' '}
                    {lineSplit ? l.normUnit : l.unit}
                  </td>
                  <td className="num cws-arrow">{lineSplit ? '→' : ''}</td>
                  {/* Единица ЗАКУПКИ — селект: выбор другой единицы у обычной
                      строки рождает расщепление (норма остаётся в прежней
                      единице), возврат в единицу нормы — схлопывает его.
                      Пересчитать «К закупке» и потребность бэкенд умеет
                      только из погонных метров — не-метровой норме словарь
                      отдаёт одну опцию, и селект гаснет с объяснением. */}
                  <td className="cws-zone--buy">
                    <select
                      className="cws-cell cws-cell--sm"
                      defaultValue={l.unit}
                      disabled={
                        ro || pending || unitBound || purchaseOptions.length <= 1
                      }
                      aria-label="Единица закупки"
                      title={
                        unitBound
                          ? boundTitle
                          : purchaseOptions.length <= 1
                            ? normalizeUnit(normUnitCurrent) === 'м'
                              ? 'Других закупочных единиц для этого материала не предусмотрено'
                              : `Пересчёт закупки умеет только из погонных метров, а норма задана в «${normUnitCurrent}»`
                            : 'Единица закупки: другая единица пересчитает «К закупке» и потребность цеха'
                      }
                      onChange={(e) => {
                        const next = e.target.value;
                        if (next === l.unit) return;
                        if (l.normUnit) {
                          // Закупку вернули в единицу нормы — расщепление
                          // схлопывается, строка живёт как обычная.
                          saveLine(
                            l.id,
                            needsPurchaseConversion(l.normUnit, next)
                              ? { unit: next }
                              : { unit: next, normUnit: null },
                          );
                        } else {
                          // Норма остаётся в прежней единице — расщепление
                          // рождается здесь, число нормы смысла не меняет.
                          saveLine(
                            l.id,
                            needsPurchaseConversion(l.unit, next)
                              ? { unit: next, normUnit: l.unit }
                              : { unit: next },
                          );
                        }
                      }}
                    >
                      {purchaseOptions.map((u) => (
                        <option key={u} value={u}>
                          {u}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="num cws-total cws-zone--buy">
                    {l.purchaseProblem ? (
                      /* Прочерк с объяснением, а не тихий ноль: ноль
                         читается как «материал не нужен». */
                      <span className="cws-nocalc" title={l.purchaseProblem}>
                        —
                      </span>
                    ) : (
                      <span title={l.purchaseFormula ?? undefined}>
                        {l.totalQty} {l.unit}
                      </span>
                    )}
                  </td>
                  <td className="num">
                    {!ro && (
                      <button
                        type="button"
                        className="cws-x"
                        aria-label={`Убрать материал «${l.name}»`}
                        disabled={pending}
                        onClick={() =>
                          startTransition(async () =>
                            apply(await deleteTechCardLineAction(orderId, l.id)),
                          )
                        }
                      >
                        ×
                      </button>
                    )}
                  </td>
                </tr>
                {open && (
                  <tr className="cws-exp">
                    <td colSpan={cols}>
                      <LineParams
                        line={l}
                        readOnly={ro}
                        pending={pending}
                        onSave={(patch) => saveLine(l.id, patch)}
                        queue={
                          liveQueue && liveQueue.includes(l.id)
                            ? {
                                index: liveQueue.indexOf(l.id) + 1,
                                total: liveQueue.length,
                                onNext: queueNext,
                                onStop: () => {
                                  setQueue(null);
                                  setOpenLine(null);
                                },
                              }
                            : null
                        }
                      />
                    </td>
                  </tr>
                )}
                </Fragment>
              );
            })}

            {/* Черновые строки пачки — В ТАБЛИЦЕ, ячейка под ячейкой с
                сохранёнными. Ширины колонок задаёт содержимое таблицы, снаружи
                их не повторить: форма под таблицей разъезжалась на первом же
                длинном названии. */}
            {drafts.map((d) => {
              const problem = isDraftBlank(d) ? null : draftProblem(d);
              const qty = Number(d.qtyPerUnit.trim().replace(',', '.'));
              // Живой предпросчёт: расход = норма × тираж в единице нормы.
              // «К закупке» до сохранения считается только при совпадающих
              // единицах — пересчёт требует ширины и плотности, которых у
              // черновика ещё нет.
              const draftTotal =
                unitsPlan !== null && Number.isFinite(qty) && qty > 0
                  ? Math.round(qty * unitsPlan * 1000) / 1000
                  : null;
              const draftSplit = needsPurchaseConversion(d.normUnit, d.unit);
              const draftBuyOptions = getPurchaseUnitOptions({
                normUnit: d.normUnit,
                current: d.unit,
              });
              const totalPreview =
                draftTotal !== null ? `${draftTotal} ${d.normUnit}` : '—';
              return (
                <tr className="cws-draft" key={d.key}>
                  <td>
                    <div className="cws-nameline">
                      {/* Распорка вместо каретки: у сохранённой строки поле
                          имени начинается на 30px правее края ячейки, и без
                          неё черновик встал бы уступом. */}
                      <span className="cws-caret cws-caret--ghost" aria-hidden />
                      <input
                        className="cws-cell cws-cell--name"
                        autoFocus={isDraftBlank(d)}
                        placeholder="Название материала"
                        value={d.name}
                        disabled={pending}
                        onChange={(e) => patchDraft(d.key, { name: e.target.value })}
                        onKeyDown={(e) => draftKeyDown(e, d, false)}
                      />
                    </div>
                    {problem ? (
                      <span className="cws-flags cws-flags--draft">
                        <span className="cws-draft-problem">{problem}</span>
                      </span>
                    ) : (
                      <span className="cws-flags cws-flags--draft">
                        <span className="cws-pill">новая строка</span>
                      </span>
                    )}
                  </td>
                  {/* Параметры у черновика не спрашиваем: характеристики
                      дозаполняются после сохранения — иначе десять материалов
                      упирались бы в десять панелей. */}
                  <td>
                    <span className="cws-chips">
                      <span className="cws-chip cws-chip--empty">потом</span>
                    </span>
                  </td>
                  <td className="num">
                    <span className="cws-qty">
                      <input
                        className={`cws-cell cws-cell--num${
                          problem && (!Number.isFinite(qty) || qty <= 0)
                            ? ' cws-cell--bad'
                            : ''
                        }`}
                        inputMode="decimal"
                        placeholder="0"
                        value={d.qtyPerUnit}
                        disabled={pending}
                        onChange={(e) =>
                          patchDraft(d.key, { qtyPerUnit: e.target.value })
                        }
                        onKeyDown={(e) => draftKeyDown(e, d, false)}
                      />
                      {/* Ручной строке сервис жёстко ставит `qtySource=ORDER`
                          — показываем это сразу, а не после сохранения. */}
                      <span
                        className="cws-src cws-src--order"
                        title={QTY_SOURCE_BADGE.ORDER!.title}
                        aria-label={QTY_SOURCE_BADGE.ORDER!.title}
                      >
                        {QTY_SOURCE_BADGE.ORDER!.letter}
                      </span>
                    </span>
                  </td>
                  <td>
                    <select
                      className="cws-cell cws-cell--sm"
                      value={d.normUnit}
                      disabled={pending}
                      aria-label="Единица нормы"
                      title="Единица, в которой задана норма расхода"
                      onChange={(e) => {
                        const next = e.target.value;
                        // Закупочная единица следует за нормой, пока её не
                        // трогали — как у нерасщеплённой строки. И ещё раз
                        // догоняет, если пара перестала быть пересчитываемой:
                        // «норма шт → закупка кг» была бы вечным отказом.
                        const follow =
                          d.unit === d.normUnit ||
                          !(
                            needsPurchaseConversion(next, d.unit) &&
                            normalizeUnit(next) === 'м'
                          );
                        patchDraft(
                          d.key,
                          follow
                            ? { normUnit: next, unit: next }
                            : { normUnit: next },
                        );
                      }}
                      onKeyDown={(e) => draftKeyDown(e, d, false)}
                    >
                      {getNormUnitOptions({ current: d.normUnit }).map((u) => (
                        <option key={u} value={u}>
                          {u}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <input
                      className="cws-cell"
                      placeholder="—"
                      value={d.colorText}
                      disabled={pending}
                      onChange={(e) =>
                        patchDraft(d.key, { colorText: e.target.value })
                      }
                      onKeyDown={(e) => draftKeyDown(e, d, false)}
                    />
                  </td>
                  <td className="num cws-draft-total">{totalPreview}</td>
                  <td className="num cws-arrow">{draftSplit ? '→' : ''}</td>
                  {/* Единица закупки выбирается прямо при заведении: другая
                      единица — строка сохранится сразу расщеплённой. */}
                  <td className="cws-zone--buy">
                    <select
                      className="cws-cell cws-cell--sm"
                      value={d.unit}
                      disabled={pending || draftBuyOptions.length <= 1}
                      aria-label="Единица закупки"
                      title={
                        draftBuyOptions.length <= 1
                          ? `Пересчёт закупки умеет только из погонных метров, а норма задана в «${d.normUnit}»`
                          : 'Единица закупки: выберите другую — строка сохранится расщеплённой, пересчёт заработает после заполнения ширины и плотности'
                      }
                      onChange={(e) =>
                        patchDraft(d.key, { unit: e.target.value })
                      }
                      onKeyDown={(e) => draftKeyDown(e, d, true)}
                    >
                      {draftBuyOptions.map((u) => (
                        <option key={u} value={u}>
                          {u}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="num cws-zone--buy cws-draft-total">
                    {draftSplit ? (
                      /* Пересчёт в закупочную единицу требует ширины рулона
                         и плотности — их зададут в параметрах после
                         сохранения. До того — честный прочерк, не ноль. */
                      <span
                        className="cws-nocalc"
                        title="Для пересчёта нужны ширина рулона и плотность — задайте параметры после сохранения"
                      >
                        —
                      </span>
                    ) : (
                      totalPreview
                    )}
                  </td>
                  <td className="num">
                    <button
                      type="button"
                      className="cws-x"
                      aria-label="Убрать черновую строку"
                      disabled={pending}
                      onClick={() => dropDraft(d.key)}
                    >
                      ×
                    </button>
                  </td>
                </tr>
              );
            })}

            {/* Подвал у пачки ОДИН: сколько готово, что мешает остальным и
                одна кнопка. Неготовая строка пачку не держит — она останется
                черновиком, а готовые уедут. */}
            {drafts.length > 0 && (
              <tr className="cws-batch">
                <td colSpan={cols}>
                  <div className="cws-batch__in">
                    <button
                      type="button"
                      className="cws-btn cws-btn--sm cws-btn--dash"
                      disabled={
                        pending || drafts.length >= ORDER_TECH_CARD_LINES_BATCH_MAX
                      }
                      onClick={addDraft}
                    >
                      + ещё строка
                    </button>
                    <span className="cws-batch__hint">
                      Готово <strong>{readyDrafts.length}</strong> из{' '}
                      {drafts.length}. Обязательны название и норма —
                      параметры зададите после.
                    </span>
                    <span className="cws-batch__sp">
                      <button
                        type="button"
                        className="cws-btn cws-btn--sm"
                        disabled={pending}
                        onClick={() => setDrafts([])}
                      >
                        Отмена
                      </button>
                      <button
                        type="button"
                        className="cws-btn cws-btn--sm cws-btn--primary"
                        disabled={pending || readyDrafts.length === 0}
                        onClick={saveDrafts}
                      >
                        Добавить {pluralMaterials(readyDrafts.length)}
                      </button>
                    </span>
                  </div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Долг по параметрам после пачки: не гейт, а напоминание с проходом —
          иначе строки без характеристик пришлось бы выискивать глазами. */}
      {!ro && paramDebtIds.length > 0 && (
        <div className="cws-banner">
          <span>
            Добавлено: <strong>{addedIds.length}</strong>. Не заданы параметры у{' '}
            <strong>{paramDebtIds.length}</strong> — плотность, ширина, состав.
          </span>
          <button
            type="button"
            className="cws-btn cws-btn--sm cws-btn--accent"
            disabled={pending}
            onClick={startQueue}
          >
            Заполнить параметры →
          </button>
          <button
            type="button"
            className="cws-x"
            aria-label="Скрыть напоминание"
            onClick={() => setAddedIds([])}
          >
            ×
          </button>
        </div>
      )}

      {!ro && drafts.length === 0 && (
        <button
          type="button"
          className="cws-btn cws-btn--dash"
          onClick={addDraft}
        >
          + Добавить материал
        </button>
      )}

      {otherParams.length > 0 && (
        <div className="cws-params">
          <div className="cws-grouplabel">Параметры</div>
          <ul>
            {otherParams.map((p) => (
              <li key={p.id}>
                <span className="cws-params__label">
                  {p.label}
                  {p.unit ? <span className="cws-muted">, {p.unit}</span> : null}
                  {p.isAdHoc && <span className="cws-pill">в заказе</span>}
                </span>
                {paramEditor(p, true)}
                <span className="cws-params__meta">
                  {p.targets.length > 0 ? (
                    <span className="cws-muted">
                      → {p.targets
                        .map((t) => `${t.lineName}: ${t.fieldLabel}`)
                        .join(', ')}
                    </span>
                  ) : (
                    <span className="cws-muted">запись в спецификации</span>
                  )}
                  {!ro && params.variants.length > 1 && (
                    <button
                      type="button"
                      className="cws-linkbtn"
                      disabled={pending}
                      onClick={() =>
                        startTransition(async () =>
                          apply(
                            await applyTechCardParamToAllAction(orderId, p.id),
                          ),
                        )
                      }
                    >
                      → все расцветки
                    </button>
                  )}
                  {!ro && p.isAdHoc && (
                    <button
                      type="button"
                      className="cws-linkbtn cws-linkbtn--danger"
                      disabled={pending}
                      onClick={() =>
                        startTransition(async () =>
                          apply(await deleteTechCardParamAction(orderId, p.id)),
                        )
                      }
                    >
                      удалить
                    </button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {!ro && (
        <div className="cws-foot">
          {adHoc === null ? (
            <button
              type="button"
              className="cws-btn"
              onClick={() => setAdHoc({ ...emptyAdHoc })}
            >
              + Добавить параметр
            </button>
          ) : (
            <AdHocForm
              value={adHoc}
              targets={group.targets}
              pending={pending}
              onCancel={() => setAdHoc(null)}
              onSubmit={(v) => {
                const [requirementId = '', field = ''] = v.target.split('|');
                startTransition(async () => {
                  const r = await createTechCardParamAction(orderId, {
                    orderVariantId: writeVariantId,
                    key: `adhoc_${Date.now().toString(36)}`,
                    label: v.label,
                    inputType: v.inputType,
                    options:
                      v.inputType === 'ENUM' && v.options.trim() !== ''
                        ? v.options
                            .split(',')
                            .map((o) => o.trim())
                            .filter(Boolean)
                        : undefined,
                    unit: v.unit || null,
                    // Обязательность снята 16.07: свои параметры — просто поля.
                    isRequired: false,
                    value: v.value || null,
                    target:
                      requirementId && field ? { requirementId, field } : null,
                  });
                  if (r.ok) setAdHoc(null);
                  apply(r);
                });
              }}
            />
          )}

          {/* «Обновить нормы из номенклатуры» — мягкое действие, доступно в
              любом окне правки: структуру строк не трогает, только числа. */}
          <button
            type="button"
            className="cws-btn"
            disabled={pending}
            title="Перечитать нормы расхода из карточки номенклатуры (правки норм в заказе сбросятся)"
            onClick={() => {
              const ok = window.confirm(
                'Обновить нормы из номенклатуры?\n\n' +
                  'Нормы шаблонных строк будут перечитаны из карточки ' +
                  'номенклатуры. Ваши правки норм в заказе сбросятся. ' +
                  'Структура строк, параметры и характеристики останутся.',
              );
              if (!ok) return;
              startTransition(async () =>
                apply(await reloadTechCardNormsAction(orderId)),
              );
            }}
          >
            Обновить нормы из номенклатуры
          </button>

          {/* «Обновить из шаблона» — только в окне планирования. Действие
              пересоздаёт строки снимка (новые id), а после расчёта на них
              уже ссылаются строки потребностей (`WorkshopNeed.sourceId`) —
              связь порвалась бы молча. Бэкенд это же окно и держит
              (`ORDER_TECH_CARD_LOCKED`), кнопку просто не показываем. */}
          {!amendment && (
            <button
              type="button"
              className="cws-btn"
              disabled={pending}
              title="Перечитать шаблон: структура строк заказа будет перезаписана"
              onClick={() => {
                const ok = window.confirm(
                  'Перечитать техкарту из шаблона?\n\n' +
                    'Строки из шаблона будут заменены на актуальные, ваши правки ' +
                    'шаблонных строк сбросятся. Материалы, добавленные в заказе, ' +
                    'и значения параметров сохранятся.',
                );
                if (!ok) return;
                startTransition(async () =>
                  apply(await reloadTechCardFromTemplateAction(orderId)),
                );
              }}
            >
              Обновить из шаблона
            </button>
          )}

          {saveAs === null ? (
            <button
              type="button"
              className="cws-btn"
              onClick={() => setSaveAs({ code: '', name: '' })}
            >
              Сохранить как новый шаблон
            </button>
          ) : (
            <div className="cws-form cws-form--saveas">
              <p className="cws-muted">
                В справочник уедет <strong>структура</strong> (строки и
                параметры). Значения останутся в заказе.
              </p>
              <input
                type="text"
                placeholder="Код (TK-KULIRKA-OS)"
                value={saveAs.code}
                onChange={(e) =>
                  setSaveAs((s) => (s ? { ...s, code: e.target.value } : s))
                }
              />
              <input
                type="text"
                placeholder="Название"
                value={saveAs.name}
                onChange={(e) =>
                  setSaveAs((s) => (s ? { ...s, name: e.target.value } : s))
                }
              />
              <button
                type="button"
                className="cws-btn cws-btn--primary"
                disabled={pending || !saveAs.code.trim() || !saveAs.name.trim()}
                onClick={() =>
                  startTransition(async () =>
                    apply(
                      await saveTechCardAsTemplateAction(orderId, {
                        orderVariantId: writeVariantId,
                        code: saveAs.code.trim(),
                        name: saveAs.name.trim(),
                      }),
                    ),
                  )
                }
              >
                Сохранить
              </button>
              <button
                type="button"
                className="cws-btn"
                onClick={() => setSaveAs(null)}
              >
                Отмена
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Панель параметров строки материала: подтип + характеристики + расшифровка
 * нормы, если она пришла из номенклатуры поразмерно.
 *
 * Раньше этих полей в заказе не было вовсе — характеристики правились только в
 * справочнике техкарт, а в заказе строка показывала одну норму. Набор полей
 * берём из подтипа (`MATERIAL_SUBTYPES`), чтобы «параметры» здесь и в шаблоне
 * означали одно и то же.
 *
 * Ячейка под слот-параметром (`boundFields`) — read-only с замком: два
 * писателя в одну ячейку запрещены, backend такую правку отбивает 409.
 */
function LineParams({
  line,
  readOnly,
  pending,
  onSave,
  queue,
}: {
  line: OrderTechCardLineDto;
  readOnly: boolean;
  pending: boolean;
  onSave: (
    patch: Record<
      string,
      string | number | null | Record<string, string | number | null>
    >,
  ) => void;
  /**
   * Проход по строкам без характеристик: «материал N из M» и переход к
   * следующей. `null` — панель открыта сама по себе, навигации нет.
   */
  queue?: {
    index: number;
    total: number;
    onNext: () => void;
    onStop: () => void;
  } | null;
}) {
  const keys = characteristicKeysForLine(line);
  const values = line.characteristics ?? {};
  const disabled = readOnly || pending;
  // Поле «Характеристика» вместо убранного «Подтипа» (решение пользователя
  // 29.07.2026): выбор из пополняемого списка либо свой текст. Подтип не
  // выбирается, а выводится из значения — и уходит тем же патчем, потому что
  // он задаёт набор характеристик ниже.
  const role = line.materialRole ?? '';
  // Строки, заполненные до этой правки, держат значение в `subtypeKey` —
  // показываем его лейбл, иначе поле выглядело бы пустым.
  const characteristicValue =
    (line.fabricType ?? '') || characteristicValueFromSubtypeKey(line.subtypeKey);
  const characteristicBound = line.boundFields.includes('core:fabricType');

  return (
    <div className="cws-params-panel">
      <div className="cws-params-panel__head">
        <span className="cws-grouplabel">Параметры материала</span>
        {line.materialRole && (
          <span className="cws-chip">роль: {line.materialRole}</span>
        )}
        {queue && (
          /* Навигация НЕ гаснет на `pending` и слушает mousedown, а не click:
             поля панели сохраняются по blur, и к моменту mouseup кнопка уже
             была бы disabled — браузер не доставил бы click. Ломался ровно
             тот случай, ради которого проход и сделан: ввёл значение и сразу
             жмёшь «Дальше». */
          <span className="cws-params-panel__nav">
            <span className="cws-muted">
              материал {queue.index} из {queue.total}
            </span>
            <button
              type="button"
              className="cws-btn cws-btn--sm"
              onMouseDown={queue.onStop}
            >
              Закончить
            </button>
            <button
              type="button"
              className="cws-btn cws-btn--sm cws-btn--primary"
              onMouseDown={queue.onNext}
            >
              {queue.index < queue.total ? 'Дальше →' : 'Готово'}
            </button>
          </span>
        )}
      </div>

      <div className="cws-fields">
        <label className="cws-field">
          <span>
            Характеристика
            {characteristicBound ? ' 🔒' : ''}
          </span>
          <CharacteristicCombobox
            roleKey={role}
            value={characteristicValue}
            disabled={disabled || characteristicBound}
            placeholder={characteristicBound ? '—' : 'выберите или введите'}
            onCommit={(next) => {
              const trimmed = next.trim();
              if (trimmed === characteristicValue.trim()) return;
              const nextSubtype = resolveSubtypeKeyByCharacteristic(
                role,
                trimmed,
              );
              // Подтип шлём вместе со значением: он задаёт набор
              // характеристик, и бэкенд по нему уносит значения, которых у
              // нового набора нет.
              onSave({
                fabricType: trimmed === '' ? null : trimmed,
                subtypeKey: nextSubtype,
              });
            }}
          />
        </label>

        {keys.map((key) => {
          const def = getMaterialCharacteristic(key);
          const bound = line.boundFields.includes(`char:${key}`);
          const raw = values[key];
          return (
            <label className="cws-field" key={key}>
              <span>
                {def?.label ?? key}
                {def?.unit ? `, ${def.unit}` : ''}
                {bound ? ' 🔒' : ''}
              </span>
              <input
                key={`${key}:${String(raw ?? '')}`}
                className="cws-cell"
                type={def?.valueType === 'number' ? 'number' : 'text'}
                defaultValue={raw != null ? String(raw) : ''}
                placeholder="—"
                disabled={disabled || bound}
                title={
                  bound
                    ? 'Ячейка привязана к параметру техкарты — правьте значение параметра'
                    : undefined
                }
                onBlur={(e) => {
                  const next = e.target.value.trim();
                  if (next === (raw != null ? String(raw) : '')) return;
                  onSave({ characteristics: { [key]: next === '' ? null : next } });
                }}
              />
            </label>
          );
        })}
      </div>

      {line.qtyBySize.length > 0 && (
        <div className="cws-bysize">
          <span className="cws-grouplabel">Норма по размерам · из номенклатуры</span>
          <div className="cws-bysize__row">
            {line.qtyBySize.map((b) => (
              <span className="cws-bysize__cell" key={b.sizeId}>
                <span>
                  {b.sizeCode} · {b.qtyPlan} шт
                </span>
                <b>{b.value}</b>
              </span>
            ))}
          </div>
          <p className="cws-muted">
            В заказе хранится одна норма на изделие — средневзвешенная по этому
            плану ({line.qtyPerUnit} {line.unit}/шт). Правка нормы в строке
            заменит её целиком: строка перейдёт в «правлено в заказе», и
            пересчёт больше не будет её трогать.
          </p>
        </div>
      )}

      {line.qtySource === 'ORDER' && !line.isManual && (
        <p className="cws-muted">
          Норма правлена в заказе — номенклатура её больше не перезаписывает.
          Вернуть число из номенклатуры: «Обновить нормы из номенклатуры».
        </p>
      )}
    </div>
  );
}

function AdHocForm({
  value,
  targets,
  pending,
  onCancel,
  onSubmit,
}: {
  value: typeof emptyAdHoc;
  targets: OrderTechCardVariantParamsDto['targets'];
  pending: boolean;
  onCancel: () => void;
  onSubmit: (v: typeof emptyAdHoc) => void;
}) {
  const [v, setV] = useState(value);
  // Ячейки, уже занятые другим параметром, показываем, но не даём выбрать:
  // два писателя в одну ячейку — молчаливый баг.
  const byLine = new Map<string, typeof targets>();
  for (const t of targets) {
    const list = byLine.get(t.lineName) ?? [];
    list.push(t);
    byLine.set(t.lineName, list);
  }

  return (
    <div className="cws-form">
      <input
        type="text"
        placeholder="Название параметра"
        value={v.label}
        onChange={(e) => setV({ ...v, label: e.target.value })}
      />
      <select
        value={v.inputType}
        onChange={(e) => setV({ ...v, inputType: e.target.value })}
      >
        {TECH_CARD_PARAMETER_INPUT_TYPES.map((t) => (
          <option key={t} value={t}>
            {TECH_CARD_PARAMETER_INPUT_TYPE_LABELS[t]}
          </option>
        ))}
      </select>
      {v.inputType === 'ENUM' && (
        <input
          type="text"
          placeholder="Значения списка: 160, 190, 220"
          value={v.options}
          onChange={(e) => setV({ ...v, options: e.target.value })}
        />
      )}
      <input
        type="text"
        placeholder="Ед. изм."
        value={v.unit}
        onChange={(e) => setV({ ...v, unit: e.target.value })}
      />
      <select
        value={v.target}
        onChange={(e) => setV({ ...v, target: e.target.value })}
      >
        <option value="">— просто зафиксировать в спецификации —</option>
        {Array.from(byLine.entries()).map(([lineName, list]) => (
          <optgroup key={lineName} label={lineName}>
            {list.map((t) => (
              <option
                key={`${t.requirementId}|${t.field}`}
                value={`${t.requirementId}|${t.field}`}
                disabled={Boolean(t.takenByKey)}
              >
                {t.fieldLabel}
                {t.unit ? `, ${t.unit}` : ''}
                {t.takenByKey ? ' — уже занята' : ''}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
      <input
        type="text"
        placeholder="Значение"
        value={v.value}
        onChange={(e) => setV({ ...v, value: e.target.value })}
      />
      <button
        type="button"
        className="cws-btn cws-btn--primary"
        disabled={pending || v.label.trim() === ''}
        onClick={() => onSubmit(v)}
      >
        Добавить
      </button>
      <button type="button" className="cws-btn" onClick={onCancel}>
        Отмена
      </button>
    </div>
  );
}

function SpecStyles() {
  return (
    <style>{`
.cws { display:flex; flex-direction:column; gap:12px; border-top:1px dashed var(--color-border); padding-top:11px;
  /* ОДНА высота на все контролы окна: поля таблицы, поля панели параметров,
     селекты, кнопки. Раньше каждый блок задавал свой padding, и строки
     «прыгали» по высоте — это читалось как разные элементы разных экранов. */
  --cws-h:32px; --cws-r:8px; }
.cws * { box-sizing:border-box; }
.cws-muted { font-size:12.5px; color:var(--color-fg-muted); }
.cws-tpl { margin:0; }
.cws-error { margin:0; padding:8px 11px; border-radius:8px; background:var(--color-danger-soft); color:var(--color-danger-fg); font-size:13px; }
.cws-notice { margin:0; padding:8px 11px; border-radius:8px; background:var(--color-bg-tint); color:var(--color-fg-strong); font-size:13px; }
.cws-warn { margin:0; padding:8px 11px; border-radius:8px; border:1px solid var(--color-border);
  background:var(--color-warning-soft,var(--color-bg-muted)); color:var(--color-fg-muted); font-size:12.5px; line-height:1.45; }
.cws-tablewrap { overflow-x:auto; border:1px solid var(--color-border); border-radius:10px; }
.cws-table { width:100%; border-collapse:collapse; font-size:13px; }
.cws-table th { text-align:left; font-size:10.5px; text-transform:uppercase; letter-spacing:.04em;
  color:var(--color-fg-muted); font-weight:700; padding:7px 10px; border-bottom:1px solid var(--color-border); background:var(--color-bg-muted); }
.cws-table th.num { text-align:right; }
.cws-table td { padding:6px 10px; border-bottom:1px solid var(--color-border); vertical-align:middle; }
.cws-table tr:last-child td { border-bottom:0; }
.cws-table td.num { text-align:right; white-space:nowrap; }
.cws-total { font-variant-numeric:tabular-nums; color:var(--color-fg-strong); font-weight:600; }
/* Сдвоенная шапка: расход слева, закупка справа. Появляется только у групп,
   где единица нормы отличается от закупочной. */
.cws-table th.cws-grp { text-align:center; font-size:10px; border-bottom:0; padding-bottom:3px; }
.cws-table th.cws-grp--norm { background:var(--color-ok-soft,var(--color-bg-tint)); color:var(--color-ok-fg,var(--color-fg-strong)); }
.cws-table th.cws-grp--buy { background:var(--color-accent-soft,var(--color-bg-muted)); color:var(--color-accent-fg,var(--color-fg-strong)); }
.cws-table td.cws-zone--buy, .cws-table th.cws-zone--buy { background:color-mix(in srgb, var(--color-accent-soft,var(--color-bg-muted)) 34%, transparent); }
.cws-arrow { color:var(--color-accent-fg,var(--color-fg-muted)); font-weight:700; }
.cws-nocalc { color:var(--color-fg-subtle); cursor:help; }
.cws-cell { width:100%; min-width:70px; height:var(--cws-h); padding:0 8px; border:1px solid var(--color-border-strong);
  /* background-COLOR, не шорткат: у select-ов globals.css рисует шеврон
     через background-image, и шорткат молча стирал бы стрелку. */
  border-radius:var(--cws-r); font:inherit; font-size:13px; background-color:var(--color-bg-card); color:var(--color-fg); }
select.cws-cell { padding-right:22px; }
.cws-cell:focus { outline:none; border-color:var(--color-accent); }
.cws-cell:disabled { opacity:.65; cursor:not-allowed; background:var(--color-bg-muted); }
.cws-cell--name { min-width:170px; font-weight:600; }
.cws-cell--num { min-width:76px; max-width:96px; text-align:right; }
.cws-cell--sm { min-width:64px; max-width:110px; width:auto; padding:0 6px; font-size:12.5px; }
.cws-flags { display:flex; align-items:center; flex-wrap:wrap; gap:8px; margin-top:5px; }
.cws-pill { font-size:10px; font-weight:700; text-transform:uppercase; letter-spacing:.03em;
  padding:2px 7px; border-radius:999px; background:var(--color-bg-tint); color:var(--color-fg-strong); }
.cws-density { display:inline-flex; align-items:center; gap:5px; font-size:12px; color:var(--color-fg-muted); }
.cws-x { border:none; background:none; color:var(--color-fg-subtle); cursor:pointer; font-size:17px; line-height:1; padding:4px 6px; border-radius:6px; }
.cws-x:hover:not(:disabled) { color:var(--color-danger); background:var(--color-danger-soft); }
.cws-x:disabled { opacity:.4; cursor:not-allowed; }
.cws-btn { display:inline-flex; align-items:center; justify-content:center; align-self:flex-start; height:var(--cws-h);
  padding:0 12px; border:1px solid var(--color-border-strong); border-radius:var(--cws-r); background:var(--color-bg-card);
  color:var(--color-fg-muted); font:inherit; font-size:13px; font-weight:600; cursor:pointer; white-space:nowrap; }
.cws-btn:hover:not(:disabled) { border-color:var(--color-accent); color:var(--color-fg); }
.cws-btn:disabled { opacity:.55; cursor:not-allowed; }
.cws-btn--dash { border-style:dashed; }
.cws-btn--primary { background:var(--btn-primary-bg,var(--color-accent)); border-color:var(--btn-primary-edge,var(--color-accent));
  color:var(--btn-primary-fg,#fff); }
.cws-btn--primary:hover:not(:disabled) { color:var(--btn-primary-fg,#fff); }
.cws-form { display:flex; flex-wrap:wrap; gap:8px; align-items:center; padding:10px; border:1px dashed var(--color-border-strong); border-radius:10px; }
.cws-form input, .cws-form select { height:var(--cws-h); padding:0 9px; border:1px solid var(--color-border-strong);
  border-radius:var(--cws-r); font:inherit; font-size:13px; background-color:var(--color-bg-card); color:var(--color-fg); }
.cws-form input:focus, .cws-form select:focus { outline:none; border-color:var(--color-accent); }
.cws-form--saveas p { width:100%; margin:0; }
.cws-params ul { list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:8px; }
.cws-params li { display:flex; align-items:center; flex-wrap:wrap; gap:9px; font-size:13px; }
.cws-params__label { font-weight:600; }
.cws-params__meta { display:inline-flex; align-items:center; gap:9px; }
.cws-grouplabel { font-size:10.5px; font-weight:800; text-transform:uppercase; letter-spacing:.05em; color:var(--color-fg-muted); margin-bottom:7px; }
.cws-linkbtn { border:none; background:none; padding:0; cursor:pointer; font-size:12px; font-weight:600; color:var(--color-accent-fg); }
.cws-linkbtn:hover { text-decoration:underline; }
.cws-linkbtn--danger { color:var(--color-danger); }
.cws-foot { display:flex; flex-wrap:wrap; gap:8px; align-items:flex-start; }
.cws-nameline { display:flex; align-items:flex-start; gap:6px; }
.cws-caret { flex:none; width:24px; height:var(--cws-h); display:inline-flex; align-items:center; justify-content:center;
  border:1px solid var(--color-border-strong); border-radius:7px; background:var(--color-bg-card);
  color:var(--color-fg-muted); font:inherit; font-size:12px; cursor:pointer; }
.cws-caret:hover { border-color:var(--color-accent); color:var(--color-fg); }
.cws-caret.is-open { background:var(--color-bg-tint); border-color:var(--color-accent); color:var(--color-fg-strong); }
.cws-chips { display:flex; flex-wrap:wrap; gap:4px; align-items:center; max-width:270px;
  border:none; background:none; padding:0; font:inherit; text-align:left; cursor:pointer; }
.cws-chip { display:inline-flex; align-items:center; gap:4px; padding:2px 8px; border-radius:999px;
  background:var(--color-bg-muted); color:var(--color-fg); font-size:11.5px; }
.cws-chip--subtype { font-weight:700; }
.cws-chip--slot { background:var(--color-accent-soft,var(--color-bg-tint)); color:var(--color-accent-fg); font-weight:700; }
.cws-chip--empty { background:var(--color-bg-card); border:1px dashed var(--color-border-strong); color:var(--color-fg-subtle); }
.cws-qty { display:inline-flex; align-items:center; gap:6px; justify-content:flex-end; }
.cws-src { flex:none; display:inline-flex; align-items:center; justify-content:center; width:19px; height:19px;
  border-radius:999px; font-size:11px; font-weight:800; cursor:help; user-select:none; }
.cws-src--nomenclature { background:var(--color-ok-soft,var(--color-bg-tint)); color:var(--color-ok-fg,var(--color-fg-strong)); }
.cws-src--template { background:var(--color-bg-muted); color:var(--color-fg-muted); }
.cws-src--order { background:var(--color-bg-tint); color:var(--color-warn-fg,var(--color-fg-strong)); }
.cws-exp > td { background:var(--color-bg-muted); }
.cws-params-panel { display:flex; flex-direction:column; gap:10px; padding:10px; border:1px solid var(--color-border-strong);
  border-radius:10px; background:var(--color-bg-card); }
.cws-params-panel__head { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.cws-params-panel__head .cws-grouplabel { margin-bottom:0; }
.cws-fields { display:grid; grid-template-columns:repeat(auto-fill,minmax(168px,1fr)); gap:8px; }
.cws-field { display:flex; flex-direction:column; gap:3px; }
.cws-field > span { font-size:10.5px; font-weight:700; color:var(--color-fg-muted); }
.cws-bysize { display:flex; flex-direction:column; gap:6px; }
.cws-bysize__row { display:flex; flex-wrap:wrap; gap:6px; }
.cws-bysize__cell { display:inline-flex; flex-direction:column; align-items:center; gap:2px; padding:4px 8px;
  border:1px solid var(--color-border); border-radius:8px; background:var(--color-bg-muted); font-size:12px; }
.cws-bysize__cell > span { font-size:10px; font-weight:700; color:var(--color-fg-muted); }
/* --- пачка черновых строк ---------------------------------------------------
   Черновик — строка ТОЙ ЖЕ таблицы: ячейки встают под своими заголовками, а
   не в отдельной коробке под таблицей, у которой своя раскладка. */
.cws-draft > td { background:var(--color-bg-tint); }
.cws-draft > td:first-child { box-shadow:inset 3px 0 0 var(--btn-primary-edge); }
/* Распорка вместо каретки: 24px кнопки + 6px gap — иначе имя черновика
   встало бы на 30px левее имён сохранённых строк. */
.cws-caret--ghost { border-color:transparent; background:none; pointer-events:none; }
.cws-flags--draft { margin-top:5px; padding-left:30px; }
.cws-draft-problem { font-size:11.5px; color:var(--color-danger-fg); }
.cws-cell--bad { border-color:var(--color-danger); }
.cws-cell--bad:focus { border-color:var(--color-danger); }
.cws-draft-total { font-variant-numeric:tabular-nums; color:var(--color-fg-muted); }
.cws-batch > td { background:var(--color-bg-tint); padding-top:2px;
  box-shadow:inset 3px 0 0 var(--btn-primary-edge); }
.cws-batch__in { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
.cws-batch__hint { font-size:12px; color:var(--color-fg-muted); }
.cws-batch__hint strong { color:var(--color-fg-strong); }
.cws-batch__sp { margin-left:auto; display:flex; gap:8px; }
.cws-btn--sm { height:26px; padding:0 9px; font-size:12px; }
.cws-btn--accent { border-color:var(--color-accent); color:var(--color-accent-fg); }
/* Долг по параметрам — приглашение, не ошибка: пунктир акцентом. */
.cws-chip--todo { background:var(--color-bg-card); border:1px dashed var(--color-accent);
  color:var(--color-accent-fg); font-weight:700; }
.cws-banner { display:flex; align-items:center; gap:9px; flex-wrap:wrap; padding:8px 11px;
  border:1px solid var(--color-border); border-left:3px solid var(--color-accent);
  border-radius:8px; background:var(--color-accent-soft,var(--color-bg-tint)); font-size:13px; }
.cws-banner > span:first-child { margin-right:auto; }
.cws-params-panel__nav { margin-left:auto; display:flex; align-items:center; gap:8px; }
`}</style>
  );
}
