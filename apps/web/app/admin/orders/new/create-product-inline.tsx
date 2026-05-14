'use client';

/**
 * Inline-форма «Создать изделие» внутри блока «Изделие» на
 * `/admin/orders/new`.
 *
 * Семантика: это **локальная** форма — кнопка «Сохранить изделие»
 * НЕ отправляет на backend. Она собирает данные нового изделия в
 * структурированный объект `SavedInlineProductPayload` и передаёт его
 * родителю через колбэк `onSave`. Родитель хранит объект в state,
 * сериализует в hidden input `newProductCalculationJson` и шлёт в
 * составе обычного `createOrderAction` (FormData) при клике херо-кнопки
 * «Создать заказ».
 *
 * Поля inline-формы (две вкладки):
 *   - «Сделать расчет» (default): селект группы номенклатуры (опц.),
 *     селект техкарты (опц.), таблица «Размерная матрица и расход»,
 *     поле «Стоимость разработки лекала». Все поля опциональны —
 *     можно сохранить изделие минимальным.
 *   - «Отправить изделие конструктору» — заглушка.
 *
 * Inline-create category / tech-card открываются в `DraggableWindow`-ах
 * (`create-category-window.tsx`, `create-tech-card-window.tsx`).
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type FormEvent,
} from 'react';
import { Paperclip, Plus, Upload, X } from 'lucide-react';
import type {
  CompatibleTechCardDto,
  CompatibleTechCardsResponseDto,
  PatternCategoryDto,
  PatternCategoryListItemDto,
  PatternCategoryParameterDto,
} from '@sewing/shared/pattern-categories';
import type { SizeDto } from '@sewing/shared/orders';
import type { PatternListItemDto } from '@sewing/shared/patterns';
import type { TechCardTemplateSummaryDto } from '@sewing/shared/tech-cards';
import {
  CONSTRUCTOR_TASK_FILE_MAX_COUNT,
  CONSTRUCTOR_TASK_FILE_MAX_SIZE_BYTES,
  type SaveConstructorDraftResultDto,
} from '@sewing/shared/constructor-tasks';
import {
  loadCompatibleTechCardsAction,
  loadPatternCategoryDetailAction,
} from './inline-product-actions';
import { saveConstructorDraftAction } from './constructor-task-action';
import { CreateCategoryWindow } from './create-category-window';
import {
  CreateTechCardWindow,
  type PrefilledMaterialLineSeed,
} from './create-tech-card-window';

/**
 * Локальный «снимок» сохранённого inline-изделия. Хранится в state
 * родительской формы и сериализуется в hidden input при сабмите заказа.
 * Поля `categoryName` / `techCardName` / `sizeCodes` нужны только для
 * UI-резюме «Изделие №1» — backend их игнорирует и читает только
 * `categoryId / techCardId / patternDevelopmentCostRub / sizes`.
 */
export interface SavedInlineProductPayload {
  categoryId: string | null;
  categoryName: string | null;
  techCardId: string | null;
  techCardName: string | null;
  patternDevelopmentCostRub: string | null;
  sizes: Array<{
    sizeId: string;
    sizeCode: string;
    qtyPlan: number;
    areas: Array<{ roleKey: string; label: string; areaM2: string }>;
  }>;
}

/**
 * Результат сохранения вкладки `constructor` («Отправить изделие
 * конструктору»). В отличие от `SavedInlineProductPayload`, это уже
 * запись в БД (`PatternItem (DRAFT)` + `ConstructorTask (NEW)`) —
 * backend вернул нам id-шники, и родительская форма заказа
 * подставляет `patternItemId` в hidden input для последующего
 * создания заказа.
 */
export interface SavedConstructorDraftPayload {
  taskId: string;
  patternItemId: string;
  patternName: string;
  patternArticle: string;
  sizeRowsCount: number;
  filesCount: number;
}

/**
 * Discriminated union — что именно сохранено в inline-форме изделия.
 * Родитель (`admin-create-order-form.tsx`) разводит две ветки:
 *   - `kind: 'calculate'`  → CREATE_FOR_CALCULATION (как раньше);
 *   - `kind: 'constructor'` → SEND_TO_CONSTRUCTOR (новая ветка).
 */
export type InlineProductSaveResult =
  | { kind: 'calculate'; payload: SavedInlineProductPayload }
  | { kind: 'constructor'; result: SavedConstructorDraftPayload };

interface SizeRowState {
  key: string;
  sizeId: string;
  qtyPlan: string;
  areas: Record<string, string>;
}

type TabId = 'calculate' | 'constructor';

interface Props {
  /** Активные группы номенклатуры. */
  initialCategories: PatternCategoryListItemDto[];
  /** Активные техкарты. */
  initialTechCards: TechCardTemplateSummaryDto[];
  /** Справочник размеров. */
  sizes: SizeDto[];
  /**
   * Активные номенклатуры — нужны селектy «Подтянуть номенклатуры»
   * внутри `CreateTechCardWindow`. Если в проекте нет ни одной,
   * массив пуст — модалка просто покажет disabled-сообщение.
   */
  initialPatterns?: PatternListItemDto[];
  /**
   * Колбэк сохранения. Discriminated union: либо локальный payload
   * для расчёта (`kind: 'calculate'`), либо результат уже созданной
   * в БД заявки конструктору (`kind: 'constructor'`).
   */
  onSave: (result: InlineProductSaveResult) => void;
  /** Колбэк выхода из inline-режима (например, «Назад»). */
  onCancel: () => void;
  /**
   * Предзаполнение формы (режим «Редактировать» или сценарий
   * «Отправить конструктору» из карточки сохранённого изделия).
   *
   * - На вкладке `calculate` — повторно заполняет все поля calc-формы.
   * - На вкладке `constructor` — служит «источником истины»: показывает
   *   read-only сводку и берёт из неё размеры для таблицы погонных
   *   метров. БЕЗ `initialValue` constructor-tab блокируется и
   *   подсказывает менеджеру сначала сохранить изделие в calc.
   */
  initialValue?: SavedInlineProductPayload | null;
  /**
   * Какая вкладка открыта при монтировании. Дефолт — `'calculate'`.
   * Родитель передаёт `'constructor'`, когда пользователь нажал
   * «Отправить конструктору» в карточке уже сохранённого изделия
   * (см. `SavedInlineProductCard` в `admin-create-order-form.tsx`).
   */
  initialTab?: TabId;
}

let __rowSeq = 0;
function nextRowKey(): string {
  __rowSeq += 1;
  return `row_${Date.now().toString(36)}_${__rowSeq}`;
}

function rowsFromInitial(
  initial: SavedInlineProductPayload | null | undefined,
): SizeRowState[] {
  if (!initial) return [];
  return initial.sizes.map((s) => {
    const areas: Record<string, string> = {};
    for (const a of s.areas) areas[a.roleKey] = a.areaM2;
    return {
      key: nextRowKey(),
      sizeId: s.sizeId,
      qtyPlan: String(s.qtyPlan),
      areas,
    };
  });
}

export function CreateProductInline({
  initialCategories,
  initialTechCards,
  sizes,
  onSave,
  onCancel,
  initialValue = null,
  initialPatterns = [],
  initialTab = 'calculate',
}: Props) {
  const [tab, setTab] = useState<TabId>(initialTab);

  const [categories, setCategories] =
    useState<PatternCategoryListItemDto[]>(initialCategories);
  const [techCards, setTechCards] =
    useState<TechCardTemplateSummaryDto[]>(initialTechCards);

  const [categoryId, setCategoryId] = useState<string>(
    initialValue?.categoryId ?? '',
  );
  const [techCardId, setTechCardId] = useState<string>(
    initialValue?.techCardId ?? '',
  );
  const [categoryDetail, setCategoryDetail] =
    useState<PatternCategoryDto | null>(null);
  const [categoryLoading, setCategoryLoading] = useState(false);
  const [compatibility, setCompatibility] =
    useState<CompatibleTechCardsResponseDto | null>(null);

  const [rows, setRows] = useState<SizeRowState[]>(() =>
    rowsFromInitial(initialValue),
  );
  const [devCost, setDevCost] = useState<string>(
    initialValue?.patternDevelopmentCostRub ?? '',
  );
  const [submitError, setSubmitError] = useState<string | null>(null);

  const [showCategoryWindow, setShowCategoryWindow] = useState(false);
  const [showTechCardWindow, setShowTechCardWindow] = useState(false);

  // ── Вкладка `constructor` («Отправить изделие конструктору») ────────
  // Локальный state, который при «Сохранить изделие» отправляется на
  // backend через `saveConstructorDraftAction`. После успешного ответа
  // родительская форма получает `kind: 'constructor'` payload и
  // подставляет `patternItemId` в hidden input заказа.
  const [constructorRows, setConstructorRows] = useState<
    Array<{
      key: string;
      sizeId: string;
      sizeCode: string;
      kulirkaMeters: string;
      kashkorseMeters: string;
    }>
  >([]);
  // Pre-populate constructor rows from order sizes ONE TIME при первом
  // переключении на вкладку — пользователь сразу видит все размеры
  // заказа и заполняет только числа. Если переключаться туда-обратно,
  // правки сохраняются.
  const [constructorRowsInitialized, setConstructorRowsInitialized] =
    useState(false);
  const [constructorComment, setConstructorComment] = useState('');
  const [constructorFiles, setConstructorFiles] = useState<File[]>([]);
  const [constructorSubmitting, setConstructorSubmitting] = useState(false);
  const [constructorError, setConstructorError] = useState<string | null>(null);
  const [isDraggingFiles, setIsDraggingFiles] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const sortedSizes = useMemo(
    () => [...sizes].sort((a, b) => a.sortOrder - b.sortOrder),
    [sizes],
  );

  const areaParameters = useMemo<PatternCategoryParameterDto[]>(() => {
    if (!categoryDetail) return [];
    return categoryDetail.parameters
      .filter(
        (p) => p.inputType === 'AREA_M2_BY_SIZE' && p.status === 'ACTIVE',
      )
      .sort((a, b) => a.sortOrder - b.sortOrder);
  }, [categoryDetail]);

  useEffect(() => {
    // При смене категории сбрасываем выбранную техкарту, грузим
    // карточку категории + список совместимых техкарт.
    if (initialValue && initialValue.categoryId === categoryId) {
      // На первом монтировании при редактировании НЕ сбрасываем
      // techCardId — он пришёл из initialValue.
    } else {
      setTechCardId('');
    }
    setCompatibility(null);
    if (!categoryId) {
      setCategoryDetail(null);
      return;
    }
    let cancelled = false;
    setCategoryLoading(true);
    Promise.all([
      loadPatternCategoryDetailAction(categoryId),
      loadCompatibleTechCardsAction(categoryId),
    ])
      .then(([cat, compat]) => {
        if (cancelled) return;
        if ('error' in cat) setCategoryDetail(null);
        else setCategoryDetail(cat);
        if ('error' in compat) setCompatibility(null);
        else setCompatibility(compat);
      })
      .finally(() => {
        if (!cancelled) setCategoryLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [categoryId]);

  useEffect(() => {
    setRows((prev) =>
      prev.map((row) => {
        const next: Record<string, string> = {};
        for (const p of areaParameters) {
          next[p.roleKey] = row.areas[p.roleKey] ?? '';
        }
        return { ...row, areas: next };
      }),
    );
  }, [areaParameters]);

  const addRow = useCallback(() => {
    setRows((prev) => {
      const used = new Set(prev.map((r) => r.sizeId));
      const next = sortedSizes.find((s) => !used.has(s.id));
      const areas: Record<string, string> = {};
      for (const p of areaParameters) areas[p.roleKey] = '';
      return [
        ...prev,
        {
          key: nextRowKey(),
          sizeId: next?.id ?? '',
          qtyPlan: '',
          areas,
        },
      ];
    });
  }, [sortedSizes, areaParameters]);

  const removeRow = useCallback((key: string) => {
    setRows((prev) => prev.filter((r) => r.key !== key));
  }, []);

  const updateRowSize = useCallback((key: string, sizeId: string) => {
    setRows((prev) =>
      prev.map((r) => (r.key === key ? { ...r, sizeId } : r)),
    );
  }, []);

  const updateRowQty = useCallback((key: string, qty: string) => {
    setRows((prev) =>
      prev.map((r) => (r.key === key ? { ...r, qtyPlan: qty } : r)),
    );
  }, []);

  const updateRowArea = useCallback(
    (key: string, roleKey: string, value: string) => {
      setRows((prev) =>
        prev.map((r) =>
          r.key === key
            ? { ...r, areas: { ...r.areas, [roleKey]: value } }
            : r,
        ),
      );
    },
    [],
  );

  const activeCompatibility = useMemo<
    Map<string, CompatibleTechCardDto>
  >(() => {
    const m = new Map<string, CompatibleTechCardDto>();
    if (!compatibility) return m;
    for (const t of compatibility.techCards) m.set(t.id, t);
    return m;
  }, [compatibility]);

  const techCardSeedLines = useMemo<PrefilledMaterialLineSeed[]>(() => {
    return areaParameters.map((p) => ({
      name: p.label,
      materialRole: p.roleKey,
      fabricType: p.label,
      unit: 'кг',
      qtyPerUnit: '1.0000',
    }));
  }, [areaParameters]);

  // При первом переключении на вкладку конструктора инициализируем
  // строки погонных метров. Источник — `initialValue.sizes` (то, что
  // менеджер уже сохранил в calc-вкладке). Если изделие не сохранено
  // — рендерим заглушку «Сначала сохраните изделие», и эта инициализация
  // не сработает.
  useEffect(() => {
    if (tab !== 'constructor' || constructorRowsInitialized) return;
    if (!initialValue || initialValue.sizes.length === 0) return;
    setConstructorRows(
      initialValue.sizes.map((s, idx) => ({
        key: `cr_${Date.now().toString(36)}_${idx}`,
        sizeId: s.sizeId,
        sizeCode: s.sizeCode,
        kulirkaMeters: '',
        kashkorseMeters: '',
      })),
    );
    setConstructorRowsInitialized(true);
  }, [tab, constructorRowsInitialized, initialValue]);

  // Updater для строки (Кулирка/Кашкорсе). Сам размер read-only —
  // его задаёт сохранённое изделие, менеджер на этой вкладке его
  // не меняет (см. ТЗ: «тянет данные из сохранённого изделия»).
  const updateConstructorRow = useCallback(
    (
      key: string,
      patch: Partial<{ kulirkaMeters: string; kashkorseMeters: string }>,
    ) => {
      setConstructorRows((prev) =>
        prev.map((r) => (r.key === key ? { ...r, ...patch } : r)),
      );
    },
    [],
  );

  // Принять List<File> от drag-drop ИЛИ от <input type="file">.
  // Фильтруем по размеру + лимиту количества; ошибки складываем
  // в `constructorError`, чтобы менеджер сразу видел причину отказа.
  const acceptDroppedFiles = useCallback(
    (incoming: FileList | File[]) => {
      setConstructorError(null);
      const arr = Array.from(incoming);
      if (arr.length === 0) return;
      const next = [...constructorFiles];
      const errors: string[] = [];
      for (const f of arr) {
        if (f.size <= 0) {
          errors.push(`«${f.name}»: пустой файл`);
          continue;
        }
        if (f.size > CONSTRUCTOR_TASK_FILE_MAX_SIZE_BYTES) {
          const mb = Math.round(CONSTRUCTOR_TASK_FILE_MAX_SIZE_BYTES / 1024 / 1024);
          errors.push(`«${f.name}»: больше ${mb} МБ`);
          continue;
        }
        if (next.length >= CONSTRUCTOR_TASK_FILE_MAX_COUNT) {
          errors.push(
            `Лимит вложений: ${CONSTRUCTOR_TASK_FILE_MAX_COUNT}. Удалите лишнее перед добавлением новых.`,
          );
          break;
        }
        next.push(f);
      }
      setConstructorFiles(next);
      if (errors.length > 0) setConstructorError(errors.join(' · '));
    },
    [constructorFiles],
  );

  const removeConstructorFile = useCallback((idx: number) => {
    setConstructorFiles((prev) => prev.filter((_, i) => i !== idx));
  }, []);

  function onDropFiles(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    e.stopPropagation();
    setIsDraggingFiles(false);
    if (e.dataTransfer?.files) acceptDroppedFiles(e.dataTransfer.files);
  }

  function onDragOverFiles(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    e.stopPropagation();
    if (!isDraggingFiles) setIsDraggingFiles(true);
  }

  function onDragLeaveFiles(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    e.stopPropagation();
    setIsDraggingFiles(false);
  }

  async function onSubmitConstructor(e: FormEvent) {
    e.preventDefault();
    setConstructorError(null);

    // Constructor-tab гейтится на сохранённое изделие (см.
    // рендер ниже — без `initialValue` показываем заглушку и кнопка
    // submit недоступна), но защитимся ещё раз — иначе мы не знаем,
    // какой calc-payload отправить backend-у.
    if (!initialValue) {
      setConstructorError(
        'Сначала сохраните изделие на вкладке «Сделать расчёт».',
      );
      return;
    }

    // Валидация перед отправкой — backend всё равно перепроверит,
    // но менеджер увидит ошибку быстрее.
    const cleanRows = constructorRows.filter((r) => r.sizeId.trim() !== '');
    if (cleanRows.length === 0) {
      setConstructorError('Добавьте хотя бы один размер.');
      return;
    }
    const hasAnyMeters = cleanRows.some(
      (r) => r.kulirkaMeters.trim() !== '' || r.kashkorseMeters.trim() !== '',
    );
    if (!hasAnyMeters) {
      setConstructorError(
        'Заполните хотя бы одно значение Кулирки или Кашкорсе — иначе конструктору нечего считать.',
      );
      return;
    }
    const sizeIdSeen = new Set<string>();
    for (const r of cleanRows) {
      if (sizeIdSeen.has(r.sizeId)) {
        setConstructorError(`Размер «${r.sizeCode || r.sizeId}» добавлен дважды.`);
        return;
      }
      sizeIdSeen.add(r.sizeId);
    }

    setConstructorSubmitting(true);
    try {
      // Собираем calc-payload из уже сохранённого изделия. ВАЖНО:
      // `patternDevelopmentCostRub` в этот payload НЕ кладём — стоимость
      // разработки касается только сценария «Сделать расчёт» (мы её
      // не платим конструктору, а считаем себестоимость собственного
      // лекала). См. ТЗ: «Отправить тянет все данные кроме стоимости
      // разработки лекала».
      const calcPayload = {
        categoryId: initialValue.categoryId,
        techCardId: initialValue.techCardId,
        sizes: initialValue.sizes.map((s) => ({
          sizeId: s.sizeId,
          qtyPlan: s.qtyPlan,
          areas: s.areas.map((a) => ({
            roleKey: a.roleKey,
            areaM2: a.areaM2,
          })),
        })),
      };
      // Собираем FormData локально, потому что server actions в Next 14
      // не принимают `File[]` как top-level аргумент. См. doc-комментарий
      // к `saveConstructorDraftAction` и memory `feedback-server-action-file-array`.
      const fd = new FormData();
      fd.append(
        'payload',
        JSON.stringify({
          calcPayload,
          comment: constructorComment.trim(),
          sizeRows: cleanRows.map((r) => ({
            sizeId: r.sizeId,
            sizeCodeSnapshot: r.sizeCode,
            kulirkaMeters:
              r.kulirkaMeters.trim() === ''
                ? null
                : r.kulirkaMeters.trim().replace(',', '.'),
            kashkorseMeters:
              r.kashkorseMeters.trim() === ''
                ? null
                : r.kashkorseMeters.trim().replace(',', '.'),
          })),
        }),
      );
      for (const file of constructorFiles) {
        fd.append('files', file, file.name);
      }
      const result = await saveConstructorDraftAction(fd);
      if (!result.ok || !result.result) {
        setConstructorError(result.error ?? 'Не удалось сохранить заявку');
        return;
      }
      onSave({ kind: 'constructor', result: result.result });
    } finally {
      setConstructorSubmitting(false);
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitError(null);

    // Локальная валидация — построчно. Пустые строки пропускаем.
    const sizesPayload: SavedInlineProductPayload['sizes'] = [];
    for (const row of rows) {
      if (!row.sizeId) continue;
      const qty = Number(row.qtyPlan);
      if (!Number.isFinite(qty) || qty <= 0 || !Number.isInteger(qty)) {
        setSubmitError(
          'Если размер выбран, укажите количество — целое число > 0',
        );
        return;
      }
      const areas: SavedInlineProductPayload['sizes'][number]['areas'] = [];
      for (const p of areaParameters) {
        const v = (row.areas[p.roleKey] ?? '').trim();
        if (v === '') continue;
        const n = Number(v.replace(',', '.'));
        if (!Number.isFinite(n) || n <= 0) {
          setSubmitError(`«${p.label}» должен быть числом > 0`);
          return;
        }
        areas.push({ roleKey: p.roleKey, label: p.label, areaM2: v });
      }
      const sizeCode =
        sortedSizes.find((s) => s.id === row.sizeId)?.code ?? row.sizeId;
      sizesPayload.push({
        sizeId: row.sizeId,
        sizeCode,
        qtyPlan: qty,
        areas,
      });
    }

    const categoryName = categoryId
      ? (categories.find((c) => c.id === categoryId)?.name ?? null)
      : null;
    const techCardName = techCardId
      ? (techCards.find((t) => t.id === techCardId)?.name ?? null)
      : null;

    onSave({
      kind: 'calculate',
      payload: {
        categoryId: categoryId === '' ? null : categoryId,
        categoryName,
        techCardId: techCardId === '' ? null : techCardId,
        techCardName,
        patternDevelopmentCostRub:
          devCost.trim() === '' ? null : devCost.trim().replace(',', '.'),
        sizes: sizesPayload,
      },
    });
  }

  return (
    <div className="cpi">
      <div className="cpi-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'calculate'}
          className={`cpi-tab ${tab === 'calculate' ? 'cpi-tab--active' : ''}`}
          onClick={() => setTab('calculate')}
        >
          Сделать расчет
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'constructor'}
          className={`cpi-tab ${tab === 'constructor' ? 'cpi-tab--active' : ''}`}
          onClick={() => setTab('constructor')}
        >
          Отправить изделие конструктору
        </button>
      </div>

      {tab === 'calculate' && (
        // type="button" на submit, чтобы родительский <form action=
        // createOrderAction> не перехватил submit формы заказа — у нас
        // тут локальное сохранение через onSave.
        <div className="cpi-form">
          {/* Группа номенклатуры — опциональна. */}
          <div className="cpi-field">
            <label htmlFor="cpi-category">Группа номенклатуры</label>
            <div className="cpi-inline-row">
              <select
                id="cpi-category"
                value={categoryId}
                onChange={(e) => setCategoryId(e.target.value)}
              >
                <option value="">— не указана —</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="cpi-btn cpi-btn--ghost"
                onClick={() => setShowCategoryWindow(true)}
              >
                <Plus size={14} strokeWidth={1.8} aria-hidden /> Добавить группу
                номенклатуры
              </button>
            </div>
            <span className="cpi-muted">
              Без выбора группы изделие всё равно можно сохранить —
              таблица расхода материалов появится после выбора группы
              с параметрами «Площадь по размерам».
            </span>
          </div>

          {/* Техкарта — опциональна. */}
          <div className="cpi-field">
            <label htmlFor="cpi-techcard">Техкарта</label>
            <div className="cpi-inline-row">
              <select
                id="cpi-techcard"
                value={techCardId}
                onChange={(e) => setTechCardId(e.target.value)}
                disabled={categoryLoading}
              >
                <option value="">— не выбрана —</option>
                {techCards
                  .filter((tc) => tc.isActive)
                  .map((tc) => {
                    const c = activeCompatibility.get(tc.id);
                    const lvl = c?.compatibility;
                    const suffix = lvl
                      ? lvl === 'FULL'
                        ? ' · ✓ совместима'
                        : lvl === 'PARTIAL'
                          ? ' · ⚠ покрывает не все материалы'
                          : ' · ✕ не совместима'
                      : '';
                    return (
                      <option key={tc.id} value={tc.id}>
                        {tc.name}
                        {suffix}
                      </option>
                    );
                  })}
              </select>
              <button
                type="button"
                className="cpi-btn cpi-btn--ghost"
                onClick={() => setShowTechCardWindow(true)}
              >
                <Plus size={14} strokeWidth={1.8} aria-hidden /> Добавить
                техкарту
              </button>
            </div>
            {compatibility && techCardId &&
              (() => {
                const c = activeCompatibility.get(techCardId);
                if (!c || c.missingRoleKeys.length === 0) return null;
                return (
                  <div className="cpi-warn">
                    Техкарта не покрывает:{' '}
                    {c.missingRoleKeys.join(', ')}. При сохранении заказа
                    backend вернёт ошибку
                    TECH_CARD_NOT_COMPATIBLE_WITH_CATEGORY.
                  </div>
                );
              })()}
          </div>

          {/* Таблица «Размерная матрица и расход». */}
          <div className="cpi-section">
            <header className="cpi-section__header">
              <h3>Размерная матрица и расход</h3>
              <button
                type="button"
                className="cpi-btn cpi-btn--ghost"
                onClick={addRow}
                disabled={
                  sortedSizes.length === 0 ||
                  rows.length >= Math.max(sortedSizes.length, 1)
                }
                title={
                  sortedSizes.length === 0
                    ? 'Справочник размеров пуст'
                    : undefined
                }
              >
                <Plus size={14} strokeWidth={1.8} aria-hidden /> Добавить
                размер
              </button>
            </header>
            {sortedSizes.length === 0 ? (
              <p className="cpi-muted">
                Справочник размеров пуст — добавьте размеры в
                `/admin/sizes`, прежде чем заводить заказ.
              </p>
            ) : rows.length === 0 ? (
              <p className="cpi-muted">
                Нажмите «Добавить размер», чтобы заполнить план тиража
                {areaParameters.length > 0
                  ? ' и расход материалов на 1 изделие.'
                  : '.'}
              </p>
            ) : (
              <div className="cpi-table-wrap">
                <table className="cpi-table">
                  <thead>
                    <tr>
                      <th>Размер</th>
                      <th>Количество, шт</th>
                      {areaParameters.map((p) => (
                        <th key={p.id}>{p.label}, м²/шт</th>
                      ))}
                      <th aria-label="actions" />
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => (
                      <tr key={row.key}>
                        <td>
                          <select
                            value={row.sizeId}
                            onChange={(e) =>
                              updateRowSize(row.key, e.target.value)
                            }
                          >
                            <option value="">—</option>
                            {sortedSizes.map((s) => {
                              const taken = rows.some(
                                (r) =>
                                  r.sizeId === s.id && r.key !== row.key,
                              );
                              return (
                                <option
                                  key={s.id}
                                  value={s.id}
                                  disabled={taken}
                                >
                                  {s.code}
                                </option>
                              );
                            })}
                          </select>
                        </td>
                        <td>
                          <input
                            type="number"
                            min={1}
                            step={1}
                            value={row.qtyPlan}
                            onChange={(e) =>
                              updateRowQty(row.key, e.target.value)
                            }
                          />
                        </td>
                        {areaParameters.map((p) => (
                          <td key={p.id}>
                            <input
                              type="text"
                              inputMode="decimal"
                              placeholder="0.0000"
                              value={row.areas[p.roleKey] ?? ''}
                              onChange={(e) =>
                                updateRowArea(
                                  row.key,
                                  p.roleKey,
                                  e.target.value,
                                )
                              }
                            />
                          </td>
                        ))}
                        <td>
                          <button
                            type="button"
                            className="cpi-icon-btn"
                            aria-label="Удалить строку"
                            onClick={() => removeRow(row.key)}
                          >
                            <X size={14} strokeWidth={1.7} aria-hidden />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {categoryId && areaParameters.length === 0 && (
              <p className="cpi-muted">
                У группы нет активных параметров «Площадь по размерам» —
                колонок расхода не будет. Можно заполнить только тираж
                по размерам; расход материалов на 1 изделие добавится
                позже в карточке лекала.
              </p>
            )}
          </div>

          {/* Стоимость разработки лекала. */}
          <div className="cpi-field">
            <label htmlFor="cpi-dev-cost">
              Стоимость разработки лекала, ₽
            </label>
            <input
              id="cpi-dev-cost"
              type="text"
              inputMode="decimal"
              placeholder="0.00"
              value={devCost}
              onChange={(e) => setDevCost(e.target.value)}
            />
            <span className="cpi-muted">
              Управленческая метрика — в текущий расчёт себестоимости и
              потребности цеха не входит.
            </span>
          </div>

          {submitError && (
            <div className="cpi-error" role="alert">
              {submitError}
            </div>
          )}

          <footer className="cpi-footer">
            <button
              type="button"
              className="cpi-btn cpi-btn--ghost"
              onClick={onCancel}
            >
              Отмена
            </button>
            {/* Локальное сохранение: тип "button" + ручной onClick,
                чтобы не сабмитить родительский <form action={createOrderAction}>. */}
            <button
              type="button"
              className="cpi-btn cpi-btn--primary"
              onClick={onSubmit}
            >
              Сохранить изделие
            </button>
          </footer>
        </div>
      )}

      {tab === 'constructor' && !initialValue && (
        <div className="cpi-stub">
          <p>
            Прежде чем отправить конструктору, заполните и сохраните
            изделие на вкладке «Сделать расчёт».
          </p>
          <p className="cpi-muted">
            Категория, размеры и расход материалов берутся из сохранённого
            изделия — здесь вы только добавите документы и комментарий
            конструктору.
          </p>
          <button
            type="button"
            className="cpi-btn cpi-btn--ghost"
            onClick={() => setTab('calculate')}
          >
            Перейти к «Сделать расчёт»
          </button>
        </div>
      )}

      {tab === 'constructor' && initialValue && (
        <div className="cpi-form cpi-form--constructor">
          {/* Read-only сводка по сохранённому изделию — менеджер видит,
              что именно уйдёт конструктору, и не вводит эти поля повторно
              (см. ТЗ: «Отправить тянет все данные из сохранённого
              изделия кроме стоимости разработки лекала»). */}
          <div
            style={{
              border: '1px solid #cbd5e1',
              borderRadius: 6,
              padding: '0.75rem',
              background: '#f8fafc',
              display: 'grid',
              gridTemplateColumns: 'auto 1fr',
              gap: '4px 12px',
              fontSize: '0.88rem',
            }}
          >
            <strong style={{ gridColumn: '1 / -1' }}>
              Изделие сохранено
            </strong>
            <span style={{ color: '#475569' }}>Группа</span>
            <span>
              {initialValue.categoryName ?? (
                <span className="cpi-muted">не указана</span>
              )}
            </span>
            <span style={{ color: '#475569' }}>Техкарта</span>
            <span>
              {initialValue.techCardName ?? (
                <span className="cpi-muted">не выбрана</span>
              )}
            </span>
            <span style={{ color: '#475569' }}>Размеров / тираж</span>
            <span>
              {initialValue.sizes.length === 0 ? (
                <span className="cpi-muted">не заданы</span>
              ) : (
                <>
                  {initialValue.sizes
                    .map((s) => `${s.sizeCode}: ${s.qtyPlan}`)
                    .join(', ')}{' '}
                  <span style={{ color: '#475569' }}>
                    (всего{' '}
                    {initialValue.sizes
                      .reduce((acc, s) => acc + (s.qtyPlan ?? 0), 0)
                      .toLocaleString('ru-RU')}{' '}
                    шт)
                  </span>
                </>
              )}
            </span>
          </div>

          {/* Таблица «Размер / Кулирка / Кашкорсе» — погонные метры.
              Сами размеры взяты из сохранённого изделия (read-only),
              менеджер только вводит Кулирку и Кашкорсе на одно изделие.
              Эта таблица потом превратится в `PatternItemSizeParameterValue`
              номенклатуры (см. форму «Погонные метры» на /admin/patterns/[id]). */}
          <div className="cpi-field">
            <label>Погонные метры для конструктора</label>
            <span className="cpi-muted">
              Введите расход на одно изделие в погонных метрах (м пог.).
              Любую ячейку можно оставить пустой — конструктор уточнит её
              при разработке лекала.
            </span>
            <div style={{ overflowX: 'auto', marginTop: '0.5rem' }}>
              <table className="admin-table">
                <thead>
                  <tr>
                    <th style={{ width: 120 }}>Размер</th>
                    <th>Кулирка, м пог.</th>
                    <th>Кашкорсе, м пог.</th>
                  </tr>
                </thead>
                <tbody>
                  {constructorRows.length === 0 ? (
                    <tr>
                      <td colSpan={3}>
                        <span className="cpi-muted">
                          У сохранённого изделия нет размеров. Вернитесь
                          на «Сделать расчёт» и добавьте размеры.
                        </span>
                      </td>
                    </tr>
                  ) : (
                    constructorRows.map((row) => (
                      <tr key={row.key}>
                        <td>
                          <strong>{row.sizeCode}</strong>
                        </td>
                        <td>
                          <input
                            type="text"
                            inputMode="decimal"
                            value={row.kulirkaMeters}
                            onChange={(e) =>
                              updateConstructorRow(row.key, {
                                kulirkaMeters: e.target.value,
                              })
                            }
                            placeholder="м пог."
                            disabled={constructorSubmitting}
                            style={{ width: 120, textAlign: 'right' }}
                          />
                        </td>
                        <td>
                          <input
                            type="text"
                            inputMode="decimal"
                            value={row.kashkorseMeters}
                            onChange={(e) =>
                              updateConstructorRow(row.key, {
                                kashkorseMeters: e.target.value,
                              })
                            }
                            placeholder="м пог."
                            disabled={constructorSubmitting}
                            style={{ width: 120, textAlign: 'right' }}
                          />
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* Прикреплённые документы */}
          <div className="cpi-field">
            <label>Документы для конструктора</label>
            <div
              onDrop={onDropFiles}
              onDragOver={onDragOverFiles}
              onDragLeave={onDragLeaveFiles}
              style={{
                border: isDraggingFiles
                  ? '2px dashed var(--admin-primary, #2563eb)'
                  : '1px dashed var(--admin-border, #cbd5e1)',
                borderRadius: 6,
                padding: '0.75rem',
                textAlign: 'center',
                background: isDraggingFiles
                  ? 'rgba(37, 99, 235, 0.05)'
                  : 'transparent',
                transition: 'background 120ms ease',
              }}
            >
              <Upload
                size={20}
                strokeWidth={1.6}
                aria-hidden
                style={{ marginBottom: 6, opacity: 0.7 }}
              />
              <p style={{ margin: 0, fontSize: '0.9rem' }}>
                Перетащите файлы сюда или{' '}
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={constructorSubmitting}
                  style={{
                    background: 'none',
                    border: 'none',
                    color: 'var(--admin-primary, #2563eb)',
                    textDecoration: 'underline',
                    cursor: 'pointer',
                    padding: 0,
                    font: 'inherit',
                  }}
                >
                  выберите вручную
                </button>
              </p>
              <p
                className="cpi-muted"
                style={{ margin: '4px 0 0 0', fontSize: '0.8rem' }}
              >
                Любой формат (PDF, JPG, PNG, DWG, ZIP), до{' '}
                {Math.round(
                  CONSTRUCTOR_TASK_FILE_MAX_SIZE_BYTES / 1024 / 1024,
                )}{' '}
                МБ на файл, максимум {CONSTRUCTOR_TASK_FILE_MAX_COUNT}{' '}
                файлов.
              </p>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                style={{ display: 'none' }}
                onChange={(e) => {
                  if (e.target.files) acceptDroppedFiles(e.target.files);
                  // Сбрасываем value, чтобы можно было повторно выбрать
                  // тот же файл (если пользователь его удалил и снова
                  // нажал «выберите вручную»).
                  e.target.value = '';
                }}
                disabled={constructorSubmitting}
              />
            </div>
            {constructorFiles.length > 0 && (
              <ul
                className="cpi-file-list"
                style={{
                  listStyle: 'none',
                  padding: 0,
                  margin: '0.5rem 0 0 0',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '0.25rem',
                }}
              >
                {constructorFiles.map((f, idx) => (
                  <li
                    key={`${f.name}-${idx}`}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.5rem',
                      padding: '0.25rem 0.5rem',
                      border: '1px solid var(--admin-border, #e5e7eb)',
                      borderRadius: 4,
                      fontSize: '0.85rem',
                    }}
                  >
                    <Paperclip size={14} strokeWidth={1.6} aria-hidden />
                    <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {f.name}
                    </span>
                    <span className="cpi-muted" style={{ fontSize: '0.8rem' }}>
                      {(f.size / 1024).toFixed(0)} КБ
                    </span>
                    <button
                      type="button"
                      className="cpi-btn cpi-btn--ghost"
                      onClick={() => removeConstructorFile(idx)}
                      disabled={constructorSubmitting}
                      aria-label="Удалить файл"
                    >
                      <X size={14} strokeWidth={1.6} aria-hidden />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Комментарий конструктору */}
          <div className="cpi-field">
            <label htmlFor="cpi-constructor-comment">
              Комментарий конструктору
            </label>
            <textarea
              id="cpi-constructor-comment"
              value={constructorComment}
              onChange={(e) => setConstructorComment(e.target.value)}
              rows={4}
              maxLength={4000}
              placeholder="Например: материал кулирка плотностью 180 г/м², рисунок А4 в приложении"
              disabled={constructorSubmitting}
              style={{ width: '100%', resize: 'vertical' }}
            />
            <span className="cpi-muted" style={{ fontSize: '0.8rem' }}>
              {constructorComment.length} / 4000
            </span>
          </div>

          {constructorError && (
            <div
              className="error-box"
              role="alert"
              style={{ marginTop: '0.5rem' }}
            >
              <div className="error-box__msg">{constructorError}</div>
            </div>
          )}

          <footer className="cpi-footer">
            <button
              type="button"
              className="cpi-btn cpi-btn--ghost"
              onClick={onCancel}
              disabled={constructorSubmitting}
            >
              Отмена
            </button>
            <button
              type="button"
              className="cpi-btn cpi-btn--primary"
              onClick={onSubmitConstructor}
              disabled={constructorSubmitting}
            >
              {constructorSubmitting ? 'Отправляем…' : 'Отправить'}
            </button>
          </footer>
        </div>
      )}

      {showCategoryWindow && (
        <CreateCategoryWindow
          onCancel={() => setShowCategoryWindow(false)}
          onCreated={(cat) => {
            setCategories((prev) => [
              ...prev.filter((c) => c.id !== cat.id),
              {
                id: cat.id,
                name: cat.name,
                slug: cat.slug,
                iconKey: cat.iconKey,
                iconImageUrl: cat.iconImageUrl,
                iconOriginalFileName: cat.iconOriginalFileName,
                sortOrder: cat.sortOrder,
                status: cat.status,
                description: cat.description,
                parametersCount: cat.parameters.length,
                patternsCount: 0,
                createdAt: cat.createdAt,
                updatedAt: cat.updatedAt,
              },
            ]);
            setCategoryId(cat.id);
            setShowCategoryWindow(false);
          }}
        />
      )}

      {showTechCardWindow && (
        <CreateTechCardWindow
          patternCategoryId={categoryId || null}
          prefilledMaterialLines={techCardSeedLines}
          patternItems={initialPatterns.map((p) => ({
            id: p.id,
            name: p.name,
            article: p.article,
          }))}
          patternCategories={categories.map((c) => ({
            id: c.id,
            name: c.name,
          }))}
          suggestedCode={
            categoryDetail
              ? `${categoryDetail.slug.toUpperCase()}-${Date.now()
                  .toString(36)
                  .toUpperCase()
                  .slice(-4)}`
              : ''
          }
          suggestedName={
            categoryDetail ? `Техкарта · ${categoryDetail.name}` : ''
          }
          onCancel={() => setShowTechCardWindow(false)}
          onCreated={(tc) => {
            setTechCards((prev) => [
              ...prev.filter((t) => t.id !== tc.id),
              {
                id: tc.id,
                code: tc.code,
                name: tc.name,
                isActive: tc.isActive,
                patternCategoryId: tc.patternCategoryId ?? null,
                materialLinesCount: tc.materialLines.length,
                outsourceLinesCount: tc.outsourceLines.length,
                createdAt: tc.createdAt,
                updatedAt: tc.updatedAt,
              },
            ]);
            setTechCardId(tc.id);
            if (categoryId) {
              loadCompatibleTechCardsAction(categoryId).then((compat) => {
                if (!('error' in compat)) setCompatibility(compat);
              });
            }
            setShowTechCardWindow(false);
          }}
        />
      )}

      <style>{`
        .cpi { display: flex; flex-direction: column; gap: 12px; }
        .cpi-tabs {
          display: flex; gap: 4px;
          border-bottom: 1px solid #e2e8f0;
          margin-bottom: 8px;
        }
        .cpi-tab {
          background: transparent; border: none;
          padding: 8px 12px; font-size: 0.9rem;
          color: #475569; cursor: pointer;
          border-bottom: 2px solid transparent;
        }
        .cpi-tab--active { color: #0f172a; border-bottom-color: #2563eb; }
        .cpi-form { display: flex; flex-direction: column; gap: 14px; }
        .cpi-field { display: flex; flex-direction: column; gap: 4px; }
        .cpi-field > label { font-size: 0.85rem; font-weight: 600; color: #1f2937; }
        .cpi-field > input, .cpi-field > select, .cpi-field > textarea {
          padding: 6px 8px; border: 1px solid #cbd5e1;
          border-radius: 6px; font-size: 0.92rem; background: #fff;
        }
        .cpi-inline-row { display: flex; gap: 8px; }
        .cpi-inline-row > select { flex: 1; min-width: 0; }
        .cpi-btn {
          display: inline-flex; align-items: center; gap: 4px;
          padding: 6px 10px; border-radius: 6px; font-size: 0.85rem;
          cursor: pointer; border: 1px solid transparent;
        }
        .cpi-btn--primary { background: #2563eb; color: #fff; border-color: #2563eb; }
        .cpi-btn--primary:hover { background: #1d4ed8; }
        .cpi-btn--ghost { background: #f8fafc; color: #1f2937; border-color: #cbd5e1; }
        .cpi-btn--ghost:hover { background: #e2e8f0; }
        .cpi-btn:disabled { opacity: 0.6; cursor: not-allowed; }
        .cpi-icon-btn {
          background: transparent; border: none; cursor: pointer;
          padding: 4px; border-radius: 4px; color: #475569;
        }
        .cpi-icon-btn:hover { background: #f1f5f9; }
        .cpi-muted { color: #64748b; font-size: 0.82rem; margin: 0; }
        .cpi-section { display: flex; flex-direction: column; gap: 8px; }
        .cpi-section__header {
          display: flex; justify-content: space-between; align-items: center;
        }
        .cpi-section__header h3 { margin: 0; font-size: 0.95rem; color: #0f172a; }
        .cpi-table-wrap { overflow-x: auto; }
        .cpi-table { width: 100%; border-collapse: collapse; font-size: 0.88rem; }
        .cpi-table th, .cpi-table td {
          border: 1px solid #e2e8f0; padding: 4px 6px;
          text-align: left; vertical-align: middle;
        }
        .cpi-table input, .cpi-table select {
          width: 100%; padding: 4px 6px;
          border: 1px solid #cbd5e1; border-radius: 4px;
          background: #fff; font-size: 0.88rem;
        }
        .cpi-warn {
          background: #fef3c7; color: #92400e;
          border: 1px solid #fde68a;
          padding: 6px 8px; border-radius: 6px; font-size: 0.85rem;
        }
        .cpi-error {
          background: #fee2e2; color: #991b1b;
          border: 1px solid #fecaca;
          padding: 6px 8px; border-radius: 6px; font-size: 0.88rem;
        }
        .cpi-footer {
          display: flex; justify-content: flex-end; gap: 8px;
          border-top: 1px solid #e2e8f0; padding-top: 12px;
        }
        .cpi-stub { padding: 8px; color: #475569; display: flex; flex-direction: column; gap: 8px; }
      `}</style>
    </div>
  );
}
