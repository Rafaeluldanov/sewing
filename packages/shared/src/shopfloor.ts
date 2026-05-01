/**
 * Контракты экрана «Цех» (Шаг 10 MVP).
 *
 * Источник истины — `docs/screens.md §9`, `docs/flows.md §F11`,
 * `docs/api.md §11`, `docs/adr/0013-shopfloor-stage-mapping.md`.
 *
 * На MVP реализована единственная серверная проекция
 * `Σ(Passport, Box) → (size × stage)`. Никакой материализованной
 * витрины не вводится — всё считается запросом по живым данным.
 *
 * Stage buckets (см. ADR-0013):
 *   - `CUT`      — `Passport.status = CREATED` (qty = `qtyCut`).
 *   - `SEWING`   — `IN_PROGRESS` + `currentOperation.category ∈ {CUTTING,SEWING}`
 *                  (qty = `qtyCut`). CUTTING сюда попадает после выдачи
 *                  кроя до первого `OPERATION_SCAN` — паспорт уже на руках
 *                  у швеи и фактически едет в шитьё.
 *   - `QC`       — `IN_PROGRESS` + `currentOperation.category = QC`
 *                  (qty = `qtyCut`).
 *   - `QC_DONE`  — `IN_PROGRESS` + `category = QC` + есть свежий
 *                  `PassportEvent(QC_PASSED)` (новее последнего
 *                  `OPERATION_SCAN`). MVP-«виртуальный» этап —
 *                  визуально двигает крой после нажатия «Проверка
 *                  выполнена», не меняя `Passport.status`. См.
 *                  ADR-0013 §«QC_DONE bucket». Перекрывает `QC`:
 *                  один паспорт лежит ровно в одной ячейке.
 *   - `WTO`      — `IN_PROGRESS` + `currentOperation.category = IRONING`
 *                  (qty = `qtyCut`).
 *   - `WTO_DONE` — `IN_PROGRESS` + `category = IRONING` + есть свежий
 *                  `PassportEvent(WTO_PASSED)` (новее последнего
 *                  `OPERATION_SCAN`). MVP-«виртуальный» этап —
 *                  визуально двигает крой после нажатия «Завершить
 *                  ВТО», не меняя `Passport.status`. См. ADR-0013
 *                  §«WTO_DONE bucket». Перекрывает `WTO`: один паспорт
 *                  лежит ровно в одной ячейке.
 *   - `PACKING`  — приближение по открытым коробкам:
 *                  `Passport.status = PACKED` AND box.closedAt IS NULL
 *                  (qty = `qtyGood`). MVP-аппроксимация: на текущей
 *                  доменной модели промежуточного «в упаковке» статуса
 *                  у паспорта нет (ADR-0011), поэтому используем
 *                  открытые коробки как живой индикатор.
 *   - `FINISHED` — `Passport.status = PACKED` AND либо нет `BoxItem`,
 *                  либо все коробки паспорта закрыты (qty = `qtyGood`).
 *
 * `DEFECT` — это не stage, а отдельный итоговый показатель
 * (`Σ Passport.qtyDefect` среди не-CANCELLED).
 *
 * Активные заказы (scope `ALL_ACTIVE`) — все, чей `status` не в
 * `{DONE, CANCELLED}` (и `DRAFT`, и `IN_PRODUCTION`). Паспорт без
 * запущенного заказа в природе не существует, но фильтр оставлен
 * единым правилом, чтобы не зависеть от эфемерных черновиков с
 * паспортами в будущем.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

export const ShopfloorStateQuerySchema = z.object({
  /** Если задан — отдаём срез по одному заказу, иначе по всем активным. */
  orderId: z.string().trim().min(1).optional(),
});
export type ShopfloorStateQuery = z.infer<typeof ShopfloorStateQuerySchema>;

// ---------------------------------------------------------------------------
// View-models
// ---------------------------------------------------------------------------

/**
 * Скоуп выдачи: `ALL_ACTIVE` — по всем активным заказам, `ORDER` — по
 * одному выбранному. Используется UI для подписи и для понимания
 * состояния поля «orderId».
 */
export const SHOPFLOOR_SCOPES = ['ALL_ACTIVE', 'ORDER'] as const;
export type ShopfloorScope = (typeof SHOPFLOOR_SCOPES)[number];

/**
 * Список stage-ключей, которые UI должен отрисовать как столбцы.
 * Порядок зафиксирован контрактом (UI не должен сортировать по своему).
 */
export const SHOPFLOOR_STAGES = [
  'CUT',
  'SEWING',
  'QC',
  'QC_DONE',
  'WTO',
  'WTO_DONE',
  'PACKING',
  'FINISHED',
] as const;
export type ShopfloorStage = (typeof SHOPFLOOR_STAGES)[number];

export interface ShopfloorSummaryDto {
  qtyCut: number;
  qtySewing: number;
  qtyQc: number;
  /**
   * «Проверено ОТК» — паспорт ещё `IN_PROGRESS` и `currentOperation.category = QC`,
   * но у него уже есть `PassportEvent(QC_PASSED)`, более свежее, чем
   * последний `OPERATION_SCAN`. Иначе говоря — ОТК нажал «Проверка
   * выполнена», а pipeline (швея/упаковщик) ещё не перехватил паспорт.
   *
   * Введено, чтобы экран цеха визуально двигал крой после ОТК, не
   * меняя `Passport.status`. См. ADR-0013 §«QC_DONE bucket».
   */
  qtyQcDone: number;
  qtyWto: number;
  /**
   * «ВТО завершено» — `IN_PROGRESS` + `category = IRONING`, но уже есть
   * свежий `PassportEvent(WTO_PASSED)` (новее последнего `OPERATION_SCAN`).
   * Полный аналог `qtyQcDone` для роли ВТО: backend двигает крой по
   * ячейкам сразу после нажатия «Завершить ВТО», не меняя
   * `Passport.status`. См. ADR-0013 §«WTO_DONE bucket».
   */
  qtyWtoDone: number;
  qtyPacking: number;
  qtyFinished: number;
  qtyDefect: number;
}

export interface ShopfloorRowDto extends ShopfloorSummaryDto {
  sizeId: string;
  sizeCode: string;
  sizeSortOrder: number;
}

export interface ShopfloorOrderRefDto {
  id: string;
  number: string;
  status: 'DRAFT' | 'IN_PRODUCTION';
  productName: string | null;
  color: string | null;
}

export interface ShopfloorStateDto {
  /** Метка времени, когда сервер сформировал ответ (ISO). */
  updatedAt: string;
  scope: ShopfloorScope;
  /** `null`, если scope = ALL_ACTIVE. */
  orderId: string | null;
  /** Подпись для UI: «Все активные заказы (3)» или «Заказ №…». */
  scopeLabel: string;
  summary: ShopfloorSummaryDto;
  rows: ShopfloorRowDto[];
}

/**
 * Лёгкий список заказов для селекта на UI (`/api/shopfloor/orders`).
 * Сюда попадают только активные (`DRAFT` или `IN_PRODUCTION`), чтобы
 * экран «Цех» не предлагал выбирать давно завершённые партии.
 */
export interface ShopfloorOrderOptionDto extends ShopfloorOrderRefDto {
  qtyPlanTotal: number;
  /** Удобно UI отсортировать по «более свежий — выше». */
  createdAt: string;
}

// ---------------------------------------------------------------------------
// UI helpers (метки на русском)
// ---------------------------------------------------------------------------

export const SHOPFLOOR_STAGE_LABELS: Record<ShopfloorStage, string> = {
  CUT: 'Крой',
  SEWING: 'Пошив',
  QC: 'ОТК',
  QC_DONE: 'Проверено ОТК',
  WTO: 'ВТО',
  WTO_DONE: 'ВТО завершено',
  PACKING: 'Упаковка',
  FINISHED: 'Выпущено',
};

export const SHOPFLOOR_STAGE_QTY_KEYS: Record<
  ShopfloorStage,
  keyof ShopfloorSummaryDto
> = {
  CUT: 'qtyCut',
  SEWING: 'qtySewing',
  QC: 'qtyQc',
  QC_DONE: 'qtyQcDone',
  WTO: 'qtyWto',
  WTO_DONE: 'qtyWtoDone',
  PACKING: 'qtyPacking',
  FINISHED: 'qtyFinished',
};

// ---------------------------------------------------------------------------
// Equipment status (для Production Board / `/shopfloor/display`).
// ---------------------------------------------------------------------------

/**
 * Статус единицы оборудования на «большом мониторе цеха».
 *
 *   - `ONLINE`   — есть открытая `ShiftSession` (`endedAt = null`)
 *                  и в недавнем прошлом был хотя бы один
 *                  `OPERATION_SCAN` от того же сотрудника на той
 *                  же операции (см. `WARNING_AFTER_MS`);
 *   - `WARNING`  — смена открыта, но активности нет дольше порога;
 *   - `OFFLINE`  — открытой смены сейчас нет.
 *
 * Источник истины — backend (см. `ShopfloorService.listEquipmentStatus`).
 * UI только раскрашивает чип. Разделение `ONLINE/WARNING` намеренно
 * грубое: на read-only мониторе важна крупная цветовая индикация,
 * а не точная метрика «сколько минут стоит».
 */
export const SHOPFLOOR_EQUIPMENT_STATUSES = [
  'ONLINE',
  'WARNING',
  'OFFLINE',
] as const;
export type ShopfloorEquipmentStatus =
  (typeof SHOPFLOOR_EQUIPMENT_STATUSES)[number];

export interface ShopfloorEquipmentStatusDto {
  id: string;
  /** Технический код (`overlock-03`) — для отладки и стабильного key. */
  code: string;
  name: string;
  /** Ручной номер станка для крупной отрисовки (`№3`). */
  displayNumber: string | null;
  /** `false` — оборудование выведено из эксплуатации, статус всегда OFFLINE. */
  active: boolean;
  status: ShopfloorEquipmentStatus;
  /**
   * Категория оборудования для иконки на `/shopfloor/display`.
   *
   * Выводится backend'ом из `OperationCategory` разрешённых на станке
   * операций (`EquipmentOperation`):
   *   - если все разрешённые операции одной категории — берём её;
   *   - если несколько — выбираем «преобладающую» по приоритету
   *     `SEWING > CUTTING > IRONING > QC > PACKING`;
   *   - если разрешённых операций нет — `OTHER`.
   * UI использует это поле только для выбора иконки в плитке.
   */
  kind: ShopfloorEquipmentKind;
  /** ФИО сотрудника на смене, если она открыта. */
  employeeName: string | null;
  /** Текущая операция смены (для подписи под названием станка). */
  operationName: string | null;
  /** ISO-метка старта открытой смены (для UI-подсказок). */
  shiftStartedAt: string | null;
  /**
   * Последний `OPERATION_SCAN` сотрудника по этой смене (ISO).
   * `null` — смена есть, но швея ещё ни разу не сканировала операцию.
   */
  lastActivityAt: string | null;
}

/**
 * Категория единицы оборудования для иконок на `/shopfloor/display`.
 * Совпадает с `OperationCategory` Prisma-схемы плюс `OTHER` —
 * fallback, когда у оборудования нет разрешённых операций.
 */
export const SHOPFLOOR_EQUIPMENT_KINDS = [
  'CUTTING',
  'SEWING',
  'QC',
  'IRONING',
  'PACKING',
  'OTHER',
] as const;
export type ShopfloorEquipmentKind =
  (typeof SHOPFLOOR_EQUIPMENT_KINDS)[number];

// ---------------------------------------------------------------------------
// Display summary (`/shopfloor/display`) — Шаг 10b.
// ---------------------------------------------------------------------------

/**
 * Один срез матрицы «цвет × размер» для большого экрана цеха.
 *
 * `colorKey` — нормализованная строка (lower-case, trimmed), используется
 * как ключ группы. `colorLabel` — отображаемая подпись (для нормированных
 * known-цветов «black/white» — «Чёрный»/«Белый»; для остального — оригинал
 * в верхнем регистре).
 *
 * Структура зеркалит `ShopfloorRowDto`, но добавляет цветовое измерение,
 * которое отсутствует в проекции «менеджерского» `/shopfloor`. Считается
 * на каждый polling-запрос (read-only, материализованной витрины нет).
 */
/**
 * Динамическая колонка стадии «Пошив» в матрице display board'а.
 *
 * На `/shopfloor/display` стадия `SEWING` больше не схлопывается в один
 * столбец «Пошив», а раскладывается на отдельные операции (Оверлок 1,
 * Киперка, Распошивальная и т. п.). Источник колонок — фактическая
 * `Operation`, на которой сейчас стоит `Passport.currentOperation` живых
 * паспортов; backend кладёт сюда ТОЛЬКО те операции, по которым в
 * текущем срезе есть ненулевая продукция (см. `projectShopfloorDisplay`
 * и `docs/screens.md §9a.4`). Если по сей операции 0 — колонка не
 * показывается (UI не рисует пустые столбцы).
 *
 * `key` — стабильный идентификатор колонки:
 *   - `Operation.id`, если для паспорта известна конкретная sewing-
 *     операция (`currentOperation.category = SEWING`);
 *   - `__pending__` — служебная fallback-колонка для паспортов,
 *     попавших в SEWING-бакет без явной sewing-операции (CUTTING-
 *     категория после выдачи кроя до первого OPERATION_SCAN, либо
 *     `currentOperation = NULL`). Она тоже отдаётся ТОЛЬКО при наличии
 *     ненулевого объёма и стабильно ставится последней в списке.
 *
 * `label` — короткая подпись для шапки матрицы (`Operation.name`
 * или «Ожидает» для pending). UI не пере-нормализует и не сокращает —
 * на TV сейчас хватает CSS-нормализации (white-space: nowrap, padding).
 *
 * `sortOrder` — порядок колонок: реальный `Operation.sortOrder` для
 * именованных операций, либо `Number.MAX_SAFE_INTEGER` для pending,
 * чтобы pending всегда оказывался последним sewing-столбцом независимо
 * от данных.
 */
export interface ShopfloorDisplaySewingColumnDto {
  key: string;
  label: string;
  sortOrder: number;
}

/** Служебный ключ fallback-колонки sewing для passports без явной sewing-операции. */
export const SHOPFLOOR_DISPLAY_SEWING_PENDING_KEY = '__pending__';

/**
 * `ShopfloorSummaryDto` плюс разбивка `qtySewing` по конкретным
 * sewing-операциям. Используется только display-проекцией: `qtySewing`
 * по-прежнему хранит общий итог пошива (для KPI и совместимости со
 * старыми потребителями), а `sewingByOp[opKey]` — детализацию.
 *
 * Инвариант: `Σ values(sewingByOp) === qtySewing` (на любом уровне —
 * row, color total, grand total). Ключи `sewingByOp` всегда являются
 * подмножеством `ShopfloorDisplayDto.sewingColumns[].key`.
 */
export interface ShopfloorDisplayMatrixSummary extends ShopfloorSummaryDto {
  sewingByOp: Record<string, number>;
}

export interface ShopfloorDisplayRow extends ShopfloorDisplayMatrixSummary {
  sizeId: string;
  sizeCode: string;
  sizeSortOrder: number;
}

export interface ShopfloorDisplayColorBlock {
  colorKey: string;
  colorLabel: string;
  rows: ShopfloorDisplayRow[];
  totals: ShopfloorDisplayMatrixSummary;
}

/**
 * Известные «канонические» цвета: `black`/`white` всегда показываем
 * сверху и в фиксированном порядке. Остальные цвета попадают в общий
 * блок «Прочие» (или каждый своим блоком — на UI это уже косметика).
 */
export const SHOPFLOOR_DISPLAY_KNOWN_COLORS: Record<string, string> = {
  black: 'Чёрный',
  white: 'Белый',
};

/**
 * Полный ответ `GET /api/shopfloor/display` — единый агрегированный
 * срез под read-only большой монитор.
 *
 * Введён, чтобы фронт `/shopfloor/display` не разносил агрегацию по
 * 4 эндпоинтам и не считал пере-цвет/пере-размер на клиенте: backend
 * возвращает уже готовый KPI-блок, матрицу и оборудование. Это:
 *   - уменьшает сетевой трафик (1 запрос вместо 4);
 *   - даёт честный «единый снимок» — KPI и матрица всегда из одного
 *     момента (нет «гонки», когда KPI пришли свежие, а матрица старая);
 *   - удобно тестировать (один контракт = один integration-тест).
 *
 * Менеджерский `/shopfloor` остаётся на старом `/shopfloor/state` —
 * его проекция не получает цветового измерения, чтобы не ломать
 * существующий UI.
 */
export interface ShopfloorDisplayKpiDto {
  /** Σ qtyGood по PACKED-событиям за UTC-сегодня. */
  producedToday: number;
  /** Сумма по всем «живым» бакетам кроме FINISHED — «в работе». */
  inWork: number;
  /** Объединённый алиас для UI: «Ждёт» = qtyCut (готовый крой ждёт швею). */
  waiting: number;
  qc: number;
  wto: number;
  packing: number;
  finished: number;
  defect: number;
}

export interface ShopfloorDisplayDto {
  /** ISO timestamp формирования ответа. */
  updatedAt: string;
  kpi: ShopfloorDisplayKpiDto;
  /**
   * Группы матрицы. Порядок: сначала канонические цвета
   * (`black`, `white`) в порядке `SHOPFLOOR_DISPLAY_KNOWN_COLORS`,
   * затем остальные по алфавиту.
   */
  colors: ShopfloorDisplayColorBlock[];
  /** Глобальные итоги (Σ по всем colors[].totals). */
  totals: ShopfloorDisplayMatrixSummary;
  /**
   * Динамические столбцы для стадии «Пошив». Backend кладёт сюда
   * только те sewing-операции, по которым в текущем срезе есть
   * ненулевая продукция; пустые колонки на экран не уходят. Порядок
   * стабильный: по `Operation.sortOrder`, затем по `label`; служебная
   * pending-колонка (см. `SHOPFLOOR_DISPLAY_SEWING_PENDING_KEY`) —
   * всегда последней.
   *
   * UI отрисовывает эти колонки между `CUT` и остальной частью
   * `SHOPFLOOR_DISPLAY_MATRIX_STAGES` (откуда `'SEWING'` намеренно
   * убран — единая колонка «Пошив» больше не существует на дисплее).
   */
  sewingColumns: ShopfloorDisplaySewingColumnDto[];
  equipment: ShopfloorEquipmentStatusDto[];
}

/**
 * Стадии, которые UI отрисовывает в матрице как колонки.
 *
 * `SEWING` намеренно НЕ входит в этот список: на display board стадия
 * пошива раскладывается на отдельные операции (Оверлок 1, Киперка,
 * Распошивальная и т. п.), список которых backend отдаёт через
 * `ShopfloorDisplayDto.sewingColumns`. UI рендерит их между `CUT`
 * и `QC` отдельным циклом и берёт значения из `sewingByOp[colKey]`.
 *
 * `WTO_DONE` тоже намеренно отсутствует — он визуально дублирует
 * `WTO` и на большом экране только захламляет колонки. Если паспорт
 * «зависает» в ВТО done, он остаётся в колонке «ВТО» до перехода
 * дальше.
 */
export const SHOPFLOOR_DISPLAY_MATRIX_STAGES: readonly ShopfloorStage[] = [
  'CUT',
  'QC',
  'QC_DONE',
  'WTO',
  'PACKING',
  'FINISHED',
];
