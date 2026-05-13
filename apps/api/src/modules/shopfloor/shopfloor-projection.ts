import {
  OperationCategory,
  PassportStatus,
} from '@prisma/client';
import {
  SHOPFLOOR_DISPLAY_KNOWN_COLORS,
  SHOPFLOOR_DISPLAY_SEWING_PENDING_KEY,
  type ShopfloorDisplayColorBlock,
  type ShopfloorDisplayMatrixSummary,
  type ShopfloorDisplayRow,
  type ShopfloorDisplaySewingColumnDto,
  type ShopfloorRowDto,
  type ShopfloorStage,
  type ShopfloorSummaryDto,
} from '@sewing/shared/shopfloor';

/**
 * Чистая агрегация состояния цеха.
 *
 * Не лезет в Prisma; принимает уже подготовленные «лёгкие» структуры.
 * Это позволяет тестировать правила буккетов в отрыве от БД и
 * переиспользовать ту же логику для подсчёта summary по одному
 * заказу и по всем активным.
 *
 * Правила маппинга (см. ADR-0013 и `@sewing/shared/shopfloor`):
 *   - CUT      — `status = CREATED`                                (qty = qtyCut)
 *   - SEWING   — `status = IN_PROGRESS` AND
 *                `currentOperation.category ∈ {CUTTING, SEWING}`   (qty = qtyCut)
 *   - QC       — `status = IN_PROGRESS` AND `category = QC`        (qty = qtyCut)
 *   - QC_DONE  — `status = IN_PROGRESS` AND `category = QC` AND
 *                есть свежий `PassportEvent(QC_PASSED)`             (qty = qtyCut)
 *                (см. ADR-0013 §«QC_DONE bucket»)
 *   - WTO      — `status = IN_PROGRESS` AND `category = IRONING`   (qty = qtyCut)
 *   - WTO_DONE — `status = IN_PROGRESS` AND `category = IRONING` AND
 *                есть свежий `PassportEvent(WTO_PASSED)`            (qty = qtyCut)
 *                (см. ADR-0013 §«WTO_DONE bucket»)
 *   - PACKING  — `status = PACKED` AND есть `BoxItem` в OPEN-коробке (qty = qtyGood)
 *   - FINISHED — `status = PACKED` И НЕ попал в PACKING            (qty = qtyGood)
 *   - DEFECT   — `Σ qtyDefect` среди не-CANCELLED паспортов
 *
 * `CANCELLED` исключаем во всех бакетах, кроме нулевых.
 */

export interface ProjectionPassport {
  sizeId: string;
  qtyCut: number;
  qtyGood: number;
  qtyDefect: number;
  status: PassportStatus;
  currentOperationCategory: OperationCategory | null;
  /**
   * `Passport.currentEmployeeId` — нужен `bucketOf` для разделения
   * двух почти одинаковых состояний:
   *   - **issued, ещё не scanned** (CUTTING + employee != null) —
   *     паспорт уже у швеи, но первый OPERATION_SCAN не прошёл; такой
   *     должен попадать в SEWING-бакет (route-WIP fallback);
   *   - **rolled-back to CUT мастером** (CUTTING + employee == null) —
   *     мастер откатил паспорт назад на CUT_DIVISION и положил в
   *     ячейку (`MasterActionsService.setRouteStep` backward с
   *     placement); такой должен попадать в CUT-бакет, иначе крой
   *     «исчезает» с дисплея.
   * По умолчанию `null`.
   */
  currentEmployeeId: string | null;
  /** `true`, если у паспорта есть `BoxItem` хотя бы в одной OPEN-коробке. */
  hasOpenBox: boolean;
  /**
   * `true`, если у паспорта есть `PassportEvent(QC_PASSED)`, более
   * свежее, чем последний `PassportEvent(OPERATION_SCAN)`. Иначе
   * говоря — ОТК нажал «Проверка выполнена», а pipeline (швея/
   * упаковщик) ещё не перехватил паспорт следующим скан-сценарием
   * (см. F4/F5). Используется для расчёта стадии `QC_DONE` —
   * визуального «движения» крой после ОТК без изменения
   * `Passport.status`. На экране `/shopfloor/display` это выводится
   * как `✔` подколонка ОТК (буфер «проверено, ждёт ВТО»), который
   * автоматически обнуляется, как только следующий step делает
   * `OPERATION_SCAN` (см. `display-board.tsx` → `buildProcessSplits`).
   * По умолчанию `false`.
   */
  hasFreshQcPassed: boolean;
  /**
   * Полный аналог `hasFreshQcPassed` для ВТО: `true`, если у паспорта
   * есть `PassportEvent(WTO_PASSED)`, более свежее, чем последний
   * `PassportEvent(OPERATION_SCAN)`. Используется для расчёта
   * derived-стадии `WTO_DONE` (визуальное движение крой после нажатия
   * «Завершить ВТО» на `/wto`, без изменения `Passport.status`).
   * На экране `/shopfloor/display` это выводится как `✔` подколонка
   * ВТО (буфер «отглажено, ждёт упаковку»), который очищается, как
   * только упаковщик скрипит `OPERATION_SCAN`.
   * По умолчанию `false`.
   */
  hasFreshWtoPassed: boolean;
}

export interface ProjectionSize {
  id: string;
  code: string;
  sortOrder: number;
}

export interface ShopfloorProjectionInput {
  passports: ProjectionPassport[];
  /** Размеры, которые UI должен показать строкой даже если по ним 0. */
  sizes: ProjectionSize[];
}

export interface ShopfloorProjectionResult {
  rows: ShopfloorRowDto[];
  summary: ShopfloorSummaryDto;
}

function emptySummary(): ShopfloorSummaryDto {
  return {
    qtyCut: 0,
    qtySewing: 0,
    qtyQc: 0,
    qtyQcDone: 0,
    qtyWto: 0,
    qtyWtoDone: 0,
    qtyPacking: 0,
    qtyFinished: 0,
    qtyDefect: 0,
  };
}

/**
 * Возвращает stage-ключ для одного паспорта (или `null`, если он не
 * попадает ни в одну живую стадию — например, отменён).
 */
export function bucketOf(p: ProjectionPassport): ShopfloorStage | null {
  if (p.status === PassportStatus.CANCELLED) return null;
  if (p.status === PassportStatus.CREATED) return 'CUT';
  if (p.status === PassportStatus.IN_PROGRESS) {
    const cat = p.currentOperationCategory;
    // QC и QC_DONE взаимоисключающие: пока ОТК ещё не нажал
    // «Проверка выполнена» (нет свежего QC_PASSED) — паспорт лежит
    // в QC; после нажатия — переезжает в QC_DONE и остаётся там,
    // пока следующая операция не сделает OPERATION_SCAN (после
    // которого `hasFreshQcPassed` снова станет false и категория
    // currentOperation сменится → паспорт уйдёт в SEWING/WTO/…).
    // См. ADR-0013 §«QC_DONE bucket».
    if (cat === OperationCategory.QC) {
      return p.hasFreshQcPassed ? 'QC_DONE' : 'QC';
    }
    // WTO и WTO_DONE взаимоисключающие (полный аналог QC/QC_DONE):
    // пока сотрудник ВТО не нажал «Завершить ВТО» — паспорт лежит в
    // WTO; после нажатия — переезжает в WTO_DONE и остаётся там до
    // следующего OPERATION_SCAN, который сменит currentOperation
    // (а заодно сбросит `hasFreshWtoPassed`). См. ADR-0013
    // §«WTO_DONE bucket».
    if (cat === OperationCategory.IRONING) {
      return p.hasFreshWtoPassed ? 'WTO_DONE' : 'WTO';
    }
    if (cat === OperationCategory.PACKING) return 'PACKING';
    // CUT-rollback edge case: паспорт IN_PROGRESS остался на
    // CUTTING-операции (CUT_DIVISION) И НЕ закреплён ни за каким
    // сотрудником — такое возможно только после master-action
    // `setRouteStep(target=CUT_DIVISION)` с одновременным placement
    // в ячейку (см. `MasterActionsService.setRouteStep` §«backward»).
    // Доменно это снова крой в ячейке: следующий issue/place поднимет
    // его обратно по маршруту. Возвращаем CUT, чтобы он не «застрял»
    // в SEWING-фолбеке и был виден в правильной колонке.
    if (cat === OperationCategory.CUTTING && p.currentEmployeeId === null) {
      return 'CUT';
    }
    // SEWING-бакет ловит все «живые» паспорта в работе, у которых
    // currentOperation либо в категории SEWING, либо в категории
    // CUTTING с активным сотрудником (паспорт уже выдан швее, но
    // первый OPERATION_SCAN ещё не случился — см. F3a/F4). Если
    // currentOperationId вообще `null` — тоже считаем «в шитье»,
    // т. к. иначе живой паспорт исчезнет с экрана.
    return 'SEWING';
  }
  if (p.status === PassportStatus.PACKED) {
    return p.hasOpenBox ? 'PACKING' : 'FINISHED';
  }
  return null;
}

function pickQty(p: ProjectionPassport, bucket: ShopfloorStage): number {
  // Для PACKING/FINISHED считаем годное (qtyGood); для всех живых —
  // размер партии (qtyCut). См. ADR-0013 §3.
  if (bucket === 'PACKING' || bucket === 'FINISHED') return p.qtyGood;
  return p.qtyCut;
}

export function projectShopfloor(
  input: ShopfloorProjectionInput,
): ShopfloorProjectionResult {
  const sizeById = new Map<string, ProjectionSize>();
  for (const s of input.sizes) sizeById.set(s.id, s);

  // Все размеры, для которых нужно вернуть строку: видимые на справочнике
  // (входной `sizes`) ∪ размеры, реально встретившиеся в паспортах.
  const sizeIds = new Set<string>();
  for (const s of input.sizes) sizeIds.add(s.id);
  for (const p of input.passports) sizeIds.add(p.sizeId);

  const buckets = new Map<string, ShopfloorSummaryDto>();
  const ensure = (sizeId: string): ShopfloorSummaryDto => {
    let row = buckets.get(sizeId);
    if (!row) {
      row = emptySummary();
      buckets.set(sizeId, row);
    }
    return row;
  };

  for (const p of input.passports) {
    if (p.status === PassportStatus.CANCELLED) continue;
    const row = ensure(p.sizeId);
    row.qtyDefect += p.qtyDefect;
    const bucket = bucketOf(p);
    if (!bucket) continue;
    const qty = pickQty(p, bucket);
    switch (bucket) {
      case 'CUT':
        row.qtyCut += qty;
        break;
      case 'SEWING':
        row.qtySewing += qty;
        break;
      case 'QC':
        row.qtyQc += qty;
        break;
      case 'QC_DONE':
        row.qtyQcDone += qty;
        break;
      case 'WTO':
        row.qtyWto += qty;
        break;
      case 'WTO_DONE':
        row.qtyWtoDone += qty;
        break;
      case 'PACKING':
        row.qtyPacking += qty;
        break;
      case 'FINISHED':
        row.qtyFinished += qty;
        break;
    }
  }

  const rows: ShopfloorRowDto[] = [];
  for (const sizeId of sizeIds) {
    const meta = sizeById.get(sizeId);
    const r = buckets.get(sizeId) ?? emptySummary();
    // На MVP не показываем «пустые» размеры, по которым нет ни одного
    // живого паспорта и которых нет в OrderItem-фильтре. Это держит
    // экран лаконичным даже на большом seed-справочнике размеров.
    const hasAny =
      r.qtyCut +
        r.qtySewing +
        r.qtyQc +
        r.qtyQcDone +
        r.qtyWto +
        r.qtyWtoDone +
        r.qtyPacking +
        r.qtyFinished +
        r.qtyDefect >
      0;
    if (!hasAny) continue;
    rows.push({
      sizeId,
      sizeCode: meta?.code ?? '—',
      sizeSortOrder: meta?.sortOrder ?? Number.MAX_SAFE_INTEGER,
      ...r,
    });
  }
  rows.sort((a, b) => a.sizeSortOrder - b.sizeSortOrder);

  const summary = rows.reduce<ShopfloorSummaryDto>((acc, r) => {
    acc.qtyCut += r.qtyCut;
    acc.qtySewing += r.qtySewing;
    acc.qtyQc += r.qtyQc;
    acc.qtyQcDone += r.qtyQcDone;
    acc.qtyWto += r.qtyWto;
    acc.qtyWtoDone += r.qtyWtoDone;
    acc.qtyPacking += r.qtyPacking;
    acc.qtyFinished += r.qtyFinished;
    acc.qtyDefect += r.qtyDefect;
    return acc;
  }, emptySummary());

  return { rows, summary };
}

// ---------------------------------------------------------------------------
// Display projection: matrix «color × size × stage» (для /shopfloor/display).
// ---------------------------------------------------------------------------

/**
 * Расширение `ProjectionPassport` для display-матрицы: знает о цвете
 * партии (из `Passport.color`) и о текущей операции паспорта, нужной
 * для детализации стадии «Пошив» по конкретным sewing-операциям
 * (Оверлок 1, Киперка, Распошивальная и т. п.). Цвет — свободная
 * строка, нормализуем в `colorKey` ниже.
 *
 * `currentOperation*` поля используются ТОЛЬКО когда паспорт попал
 * в SEWING-бакет (см. `bucketOf`):
 *   - категория `SEWING` + непустой `currentOperationId` →
 *     попадает в именную колонку этой операции;
 *   - всё остальное (категория `CUTTING` после выдачи кроя до первого
 *     OPERATION_SCAN, либо `currentOperation = NULL`) → fallback-
 *     колонка с ключом `SHOPFLOOR_DISPLAY_SEWING_PENDING_KEY`.
 *
 * `sortOrder` берём из `Operation.sortOrder` — это даёт устойчивый
 * порядок колонок между polling-tick'ами и согласован с тем, что
 * админ видит в `/admin/operations`.
 */
export interface DisplayProjectionPassport extends ProjectionPassport {
  /** Сырой цвет с паспорта (`Passport.color`), может быть пустым. */
  color: string | null;
  /** `Operation.id` текущей операции паспорта, либо null. */
  currentOperationId: string | null;
  /** `Operation.name` (короткое имя для шапки матрицы), либо null. */
  currentOperationName: string | null;
  /** `Operation.sortOrder` — для стабильной сортировки sewing-колонок. */
  currentOperationSortOrder: number | null;
  /**
   * Операция активной `ShiftSession` сотрудника, за которым сейчас
   * закреплён паспорт (`Passport.currentEmployeeId`).
   *
   * Зачем нужна. После `issueToEmployee` (швея нажала «Принять крой»)
   * `Passport.currentEmployeeId` уже указывает на швею, но
   * `currentOperationId` ещё хранит CUTTING-операцию (`CUT_DIVISION`),
   * пока швея не сделала первый `OPERATION_SCAN` (см.
   * `PassportsService.issueToEmployee` и `scanOnOperation`). На дисплее
   * такой паспорт уже фактически на конкретной sewing-операции —
   * она читается из активной смены швеи (а станок этой смены
   * физически и есть «Оверлок 1» / «Распошив» / …).
   *
   * Используется ТОЛЬКО как fallback в `sewingColumnKeyOf`, когда
   * `currentOperation` ещё не догнал реальное состояние:
   *   - `currentOperationCategory !== SEWING` (например, CUTTING после
   *     issue, либо `null`),
   *   - но у `currentEmployee` есть открытая смена с операцией
   *     категории `SEWING`.
   * В этом случае колонка определяется по операции активной смены —
   * паспорт мгновенно появляется в «Оверлок 1» / «Распошив», не
   * дожидаясь, пока швея отдельно отсканирует на свою операцию.
   *
   * Все три поля заполняются только если выполнены оба условия:
   * у паспорта есть `currentEmployeeId`, и у этого сотрудника есть
   * открытая `ShiftSession` с операцией `SEWING`-категории.
   * Иначе — `null` (паспорт уйдёт в pending как раньше).
   */
  assignedShiftSewingOperationId: string | null;
  assignedShiftSewingOperationName: string | null;
  assignedShiftSewingOperationSortOrder: number | null;
}

export interface DisplayProjectionInput {
  passports: DisplayProjectionPassport[];
}

export interface DisplayProjectionResult {
  colors: ShopfloorDisplayColorBlock[];
  totals: ShopfloorDisplayMatrixSummary;
  /**
   * Список sewing-операций, реально попавших в текущий срез матрицы.
   * Только колонки с ненулевой Σ; стабильно отсортированы (см.
   * `ShopfloorDisplayDto.sewingColumns`). Может быть пустым, если ни
   * один паспорт сейчас не находится в SEWING-бакете — тогда матрица
   * рендерится вообще без колонок «Пошив».
   */
  sewingColumns: ShopfloorDisplaySewingColumnDto[];
}

/** Подпись fallback-колонки для passports без явной sewing-операции. */
const SEWING_PENDING_LABEL = 'Ожидает';

/**
 * Нормализует «сырой» цвет (`Passport.color` / `Order.color`) в пару
 * `{ key, label }`, где `key` — стабильная lower-case строка для
 * группировок (с дополнительной сводкой синонимов «чёрный/black»),
 * а `label` — человекочитаемая подпись. Экспортируется для
 * `buildSewingRoute` (см. `shopfloor.service.ts`) — там она нужна,
 * чтобы цветовая колонка sewing-route совпадала с колонкой матрицы
 * по нормализованному ключу.
 */
export function normalizeColor(raw: string | null | undefined): {
  key: string;
  label: string;
} {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return { key: '__unknown__', label: 'Без цвета' };
  const lower = trimmed.toLowerCase();
  const known = SHOPFLOOR_DISPLAY_KNOWN_COLORS[lower];
  if (known) return { key: lower, label: known };
  // Нормализуем синонимы «чёрный/белый» → канонический ключ. На MVP
  // важно, чтобы кириллический «Чёрный» не разрывался с латинским
  // `black` в одном цеху, где встречаются обе подписи (паспорта vs
  // карточка заказа).
  if (/^(чёрн|черн|чёр|black)/.test(lower)) {
    return { key: 'black', label: SHOPFLOOR_DISPLAY_KNOWN_COLORS.black! };
  }
  if (/^(бел|white)/.test(lower)) {
    return { key: 'white', label: SHOPFLOOR_DISPLAY_KNOWN_COLORS.white! };
  }
  return { key: lower, label: trimmed };
}

function addToSummary(acc: ShopfloorSummaryDto, src: ShopfloorSummaryDto): void {
  acc.qtyCut += src.qtyCut;
  acc.qtySewing += src.qtySewing;
  acc.qtyQc += src.qtyQc;
  acc.qtyQcDone += src.qtyQcDone;
  acc.qtyWto += src.qtyWto;
  acc.qtyWtoDone += src.qtyWtoDone;
  acc.qtyPacking += src.qtyPacking;
  acc.qtyFinished += src.qtyFinished;
  acc.qtyDefect += src.qtyDefect;
}

function emptyMatrixSummary(): ShopfloorDisplayMatrixSummary {
  return { ...emptySummary(), sewingByOp: {} };
}

function addSewingByOp(
  acc: Record<string, number>,
  src: Record<string, number>,
): void {
  for (const [k, v] of Object.entries(src)) {
    acc[k] = (acc[k] ?? 0) + v;
  }
}

/**
 * Определяет ключ sewing-колонки для одного паспорта в SEWING-бакете.
 *
 * Источники, в порядке приоритета:
 *   1. `currentOperation` категории `SEWING` — паспорт уже отсканирован
 *      на конкретную операцию (`OPERATION_SCAN` прошёл), это самый
 *      точный сигнал.
 *   2. Операция активной смены закреплённой швеи
 *      (`assignedShiftSewingOperation*`) — fallback для паспортов,
 *      которые швея уже «приняла в работу» (`issueToEmployee`), но
 *      ещё не успела отдельно отсканировать на свою операцию: на
 *      этом шаге `currentOperation` всё ещё CUTTING (`CUT_DIVISION`,
 *      см. `PassportsService.issueToEmployee`), но швея физически
 *      уже работает на своём станке (Оверлок 1 / Распошив / …),
 *      и доменно правильнее показать паспорт в колонке этой операции,
 *      а не в fallback-«Ожидает». Так UI не «теряет» только что
 *      выданный крой.
 *   3. Pending — действительно неопределённый случай: ни явной
 *      sewing-операции, ни активной смены швеи sewing-категории
 *      (например, паспорт ещё лежит в ячейке без исполнителя, или
 *      смена закрылась раньше, чем паспорт двинулся дальше).
 *
 * `__pending__` появляется только в случае 3. «Раскрой» среди
 * sewing-колонок по-прежнему не появится: фильтр работает по
 * категории операции, а не по самому факту наличия `currentOperationId`.
 */
function sewingColumnKeyOf(p: DisplayProjectionPassport): string {
  if (
    p.currentOperationCategory === OperationCategory.SEWING &&
    p.currentOperationId
  ) {
    return p.currentOperationId;
  }
  if (p.assignedShiftSewingOperationId) {
    return p.assignedShiftSewingOperationId;
  }
  return SHOPFLOOR_DISPLAY_SEWING_PENDING_KEY;
}

/**
 * Считает матрицу «цвет × размер × stage» одним проходом по паспортам.
 *
 * Не лезет в Prisma — переиспользуется в smoke-тестах. Логика бакетов
 * та же, что и в `projectShopfloor` (через `bucketOf`/`pickQty`),
 * чтобы цифры между «менеджерским» `/shopfloor` и «дисплейным»
 * `/shopfloor/display` сходились ровно. Размеры для каждой строки
 * подтягиваются из переданного `sizeMeta`-словаря.
 */
export function projectShopfloorDisplay(
  input: DisplayProjectionInput,
  sizeMeta: Map<string, ProjectionSize>,
): DisplayProjectionResult {
  const byColor = new Map<
    string,
    {
      label: string;
      bySize: Map<string, ShopfloorDisplayMatrixSummary>;
    }
  >();
  const totals: ShopfloorDisplayMatrixSummary = emptyMatrixSummary();

  // Метаданные sewing-колонок (label + sortOrder) — собираем по мере
  // прохода паспортов; если одна и та же операция встречается у
  // нескольких паспортов, перезаписываем тем же значением (Operation
  // у всех экземпляров одна, расхождений быть не должно).
  const sewingColumnMeta = new Map<
    string,
    { label: string; sortOrder: number }
  >();
  // Глобальные итоги по sewing-колонкам — нужны на финальном этапе,
  // чтобы выкинуть колонки с Σ = 0 и стабильно отсортировать остальные.
  const sewingTotalsByKey = new Map<string, number>();

  for (const p of input.passports) {
    if (p.status === PassportStatus.CANCELLED) continue;
    const color = normalizeColor(p.color);
    let bucket = byColor.get(color.key);
    if (!bucket) {
      bucket = { label: color.label, bySize: new Map() };
      byColor.set(color.key, bucket);
    }
    let row = bucket.bySize.get(p.sizeId);
    if (!row) {
      row = emptyMatrixSummary();
      bucket.bySize.set(p.sizeId, row);
    }
    row.qtyDefect += p.qtyDefect;
    totals.qtyDefect += p.qtyDefect;
    const stage = bucketOf(p);
    if (!stage) continue;
    const qty = pickQty(p, stage);
    switch (stage) {
      case 'CUT':
        row.qtyCut += qty;
        totals.qtyCut += qty;
        break;
      case 'SEWING': {
        // Общий итог `qtySewing` сохраняем — на нём держится KPI «В работе»
        // и совместимость старых консьюмеров (включая интеграционные тесты).
        // Параллельно копим разбивку `sewingByOp[colKey]`, из которой
        // UI рисует динамические столбцы.
        row.qtySewing += qty;
        totals.qtySewing += qty;
        const colKey = sewingColumnKeyOf(p);
        row.sewingByOp[colKey] = (row.sewingByOp[colKey] ?? 0) + qty;
        totals.sewingByOp[colKey] =
          (totals.sewingByOp[colKey] ?? 0) + qty;
        sewingTotalsByKey.set(
          colKey,
          (sewingTotalsByKey.get(colKey) ?? 0) + qty,
        );
        if (!sewingColumnMeta.has(colKey)) {
          if (colKey === SHOPFLOOR_DISPLAY_SEWING_PENDING_KEY) {
            sewingColumnMeta.set(colKey, {
              label: SEWING_PENDING_LABEL,
              // Pending всегда сортируется в конец sewing-колонок —
              // даже если потом появятся именные операции с большим
              // sortOrder. Это держит «Ожидает» предсказуемо справа.
              sortOrder: Number.MAX_SAFE_INTEGER,
            });
          } else {
            // Метаданные колонки берём из того же источника, что и
            // ключ: если colKey пришёл из assigned-shift fallback'а
            // (currentOperation ещё CUTTING после issueToEmployee),
            // то и label/sortOrder надо тянуть из shift-операции —
            // иначе на дисплее у такого паспорта будет «—» вместо
            // «Оверлок 1». См. `sewingColumnKeyOf`.
            const fromShift = colKey === p.assignedShiftSewingOperationId;
            sewingColumnMeta.set(colKey, {
              label: fromShift
                ? (p.assignedShiftSewingOperationName ?? '—')
                : (p.currentOperationName ?? '—'),
              sortOrder: fromShift
                ? (p.assignedShiftSewingOperationSortOrder ??
                  Number.MAX_SAFE_INTEGER)
                : (p.currentOperationSortOrder ?? Number.MAX_SAFE_INTEGER),
            });
          }
        }
        break;
      }
      case 'QC':
        row.qtyQc += qty;
        totals.qtyQc += qty;
        break;
      case 'QC_DONE':
        row.qtyQcDone += qty;
        totals.qtyQcDone += qty;
        break;
      case 'WTO':
        row.qtyWto += qty;
        totals.qtyWto += qty;
        break;
      case 'WTO_DONE':
        row.qtyWtoDone += qty;
        totals.qtyWtoDone += qty;
        break;
      case 'PACKING':
        row.qtyPacking += qty;
        totals.qtyPacking += qty;
        break;
      case 'FINISHED':
        row.qtyFinished += qty;
        totals.qtyFinished += qty;
        break;
    }
  }

  // Финальный список sewing-колонок: только те, у которых Σ > 0
  // (по всем цветам/размерам), отсортированные по sortOrder, затем
  // по подписи. Pending за счёт `Number.MAX_SAFE_INTEGER` стабильно
  // оказывается последним. Это и есть «не показываем колонку, если
  // по операции везде 0» — обещание из docs/screens.md §9a.4.
  const sewingColumns: ShopfloorDisplaySewingColumnDto[] = Array.from(
    sewingTotalsByKey.entries(),
  )
    .filter(([, v]) => v > 0)
    .map(([key]) => {
      const meta = sewingColumnMeta.get(key)!;
      return { key, label: meta.label, sortOrder: meta.sortOrder };
    })
    .sort((a, b) => {
      if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
      return a.label.localeCompare(b.label, 'ru');
    });
  const visibleSewingKeys = new Set(sewingColumns.map((c) => c.key));

  // Стабильная сортировка: канонические цвета (black, white) сверху
  // в порядке `SHOPFLOOR_DISPLAY_KNOWN_COLORS`, затем остальные по
  // алфавиту. Это даёт «привычный» порядок на экране, чтобы взгляд
  // оператора не «прыгал» между пуллингами.
  const knownOrder = Object.keys(SHOPFLOOR_DISPLAY_KNOWN_COLORS);
  const sortedKeys = Array.from(byColor.keys()).sort((a, b) => {
    const ai = knownOrder.indexOf(a);
    const bi = knownOrder.indexOf(b);
    if (ai !== -1 || bi !== -1) {
      return (ai === -1 ? 1e9 : ai) - (bi === -1 ? 1e9 : bi);
    }
    return a.localeCompare(b, 'ru');
  });

  const colors: ShopfloorDisplayColorBlock[] = sortedKeys.map((key) => {
    const block = byColor.get(key)!;
    const rows: ShopfloorDisplayRow[] = Array.from(block.bySize.entries()).map(
      ([sizeId, summary]) => {
        const meta = sizeMeta.get(sizeId);
        return {
          sizeId,
          sizeCode: meta?.code ?? '—',
          sizeSortOrder: meta?.sortOrder ?? Number.MAX_SAFE_INTEGER,
          ...summary,
          // Подрезаем sewingByOp до фактически видимых колонок, чтобы
          // в DTO не уезжали ключи операций с глобальной Σ = 0
          // (теоретически их там и не должно быть, но защита дешёвая).
          sewingByOp: filterSewingByOp(summary.sewingByOp, visibleSewingKeys),
        };
      },
    );
    rows.sort((a, b) => a.sizeSortOrder - b.sizeSortOrder);
    const blockTotals: ShopfloorDisplayMatrixSummary = emptyMatrixSummary();
    for (const r of rows) {
      addToSummary(blockTotals, r);
      addSewingByOp(blockTotals.sewingByOp, r.sewingByOp);
    }
    return {
      colorKey: key,
      colorLabel: block.label,
      rows,
      totals: blockTotals,
    };
  });

  // Та же фильтрация для глобальных totals: оставляем только видимые
  // sewing-колонки. Σ значений строго равна `totals.qtySewing`.
  totals.sewingByOp = filterSewingByOp(totals.sewingByOp, visibleSewingKeys);

  return { colors, totals, sewingColumns };
}

function filterSewingByOp(
  src: Record<string, number>,
  keep: Set<string>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(src)) {
    if (keep.has(k)) out[k] = v;
  }
  return out;
}
