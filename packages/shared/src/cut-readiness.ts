/**
 * Контракты модуля «Готовность к крою» (Этап 8А).
 *
 * См. `docs/recon-soft-integration.md §«Этап 8А»`,
 * `apps/api/src/modules/cut-readiness/*`.
 *
 * Дизайн MVP — read-only / computed:
 *   - НЕТ Prisma-моделей, НЕТ миграций, НЕТ нового статуса заказа;
 *   - НЕТ списания, НЕТ создания CutJob/Passport/CellContent;
 *   - проверка чисто аналитическая: API собирает срез по заказу
 *     (лекало, техкарта, потребность, поступления) и возвращает
 *     `CutReadinessDto` с массивами `blockers/warnings/sections`;
 *   - UI рендерит карточку «Готовность к крою» в `/admin/orders/[id]`
 *     и не блокирует никаких действий.
 *
 * Список критичных ролей (`CUT_BLOCKING_MATERIAL_ROLES`) сознательно
 * совпадает с тканевыми ролями `MATERIAL_ROLES`. Роли THREAD /
 * PACKAGING / APPLICATION на MVP не блокируют готовность — для них
 * проверка возвращает строки уровня `WARNING/INFO`.
 *
 * Этап «Ручная отметка поступления материала» (см.
 * `apps/api/src/modules/order-material-arrivals/*`,
 * `prisma/schema.prisma::OrderMaterialArrivalOverride`) добавляет в
 * расчёт `manualArrivedQty` — сумму ACTIVE-overrides по
 * `WorkshopNeed`. Сервис складывает её с `placedQty` и считает
 * `effectivePlacedQty >= targetQty` достаточным условием готовности.
 * Override НЕ создаёт фиктивную приёмку и НЕ меняет складские
 * остатки — это объяснено в JSDoc `manuallyUnblocked`.
 */

// ---------------------------------------------------------------------------
// Statuses
// ---------------------------------------------------------------------------

/**
 * Итоговый статус готовности заказа к крою:
 *
 * - `READY`         — нет блокеров и нет предупреждений;
 * - `WARNING_ONLY`  — нет блокеров, но есть предупреждения;
 * - `NOT_READY`     — есть хотя бы один блокер.
 *
 * Это ВЫЧИСЛЯЕМОЕ поле, оно НЕ хранится в БД и НЕ копируется в
 * `Order.status`.
 */
export const CUT_READINESS_STATUSES = [
  'READY',
  'NOT_READY',
  'WARNING_ONLY',
] as const;
export type CutReadinessStatus = (typeof CUT_READINESS_STATUSES)[number];

export const CUT_READINESS_STATUS_LABELS: Record<CutReadinessStatus, string> = {
  READY: 'Готов к крою',
  NOT_READY: 'Не готов к крою',
  WARNING_ONLY: 'Готов, есть предупреждения',
};

/**
 * Статус отдельной проверки внутри `CutReadinessDto.sections.*`:
 *
 * - `OK`       — проверка пройдена;
 * - `BLOCKER`  — мешает запуску кроя (учитывается в `blockersCount`);
 * - `WARNING`  — не блокирует, но требует внимания
 *               (учитывается в `warningsCount`);
 * - `INFO`     — справочное сообщение, не считается ни в blockers,
 *               ни в warnings.
 */
export const CUT_READINESS_CHECK_STATUSES = [
  'OK',
  'BLOCKER',
  'WARNING',
  'INFO',
] as const;
export type CutReadinessCheckStatus =
  (typeof CUT_READINESS_CHECK_STATUSES)[number];

/**
 * Роли материала, без готовых поступлений по которым крой
 * технически невозможен (MVP). Совпадает с тканевыми ролями
 * `MATERIAL_ROLES`. Расширение списка не требует миграции.
 */
export const CUT_BLOCKING_MATERIAL_ROLES = [
  'MAIN_FABRIC',
  'RIB',
  'LINING',
] as const;
export type CutBlockingMaterialRole =
  (typeof CUT_BLOCKING_MATERIAL_ROLES)[number];

/**
 * Хелпер: критична ли роль материала для готовности к крою.
 * Используется и на backend (расчёт), и на UI (классификация
 * строки таблицы материалов).
 */
export function isCutBlockingMaterialRole(
  role: string | null | undefined,
): role is CutBlockingMaterialRole {
  return (
    typeof role === 'string' &&
    (CUT_BLOCKING_MATERIAL_ROLES as readonly string[]).includes(role)
  );
}

// ---------------------------------------------------------------------------
// Per-check DTO
// ---------------------------------------------------------------------------

/**
 * Одна строка результата проверки. Используется во всех секциях
 * (`orderSetup` / `pattern` / `receipts`) и в плоских массивах
 * `blockers` / `warnings`.
 *
 * `key` — стабильный строковый идентификатор проверки (например,
 * `order.patternItemId.required`). UI не показывает его в открытую,
 * но может использовать для тестирования и для детекции дубликатов.
 *
 * `entityType` / `entityId` — мягкая ссылка на источник
 * (`PatternItem`, `WorkshopNeed`, `PurchaseReceiptLine`, …). На MVP
 * поля справочные: UI ими не навигирует.
 */
export interface CutReadinessCheckDto {
  key: string;
  status: CutReadinessCheckStatus;
  title: string;
  message?: string | null;
  entityType?: string | null;
  entityId?: string | null;
}

// ---------------------------------------------------------------------------
// Material readiness DTO
// ---------------------------------------------------------------------------

/**
 * Размещение принятой партии в физической ячейке. Соответствует
 * одной строке `PurchaseReceiptLine.cellId` (status = POSTED,
 * cellId IS NOT NULL). Несколько строк по одной ячейке в рамках
 * одной потребности на UI агрегируются (sum qty), поэтому
 * `cellId` уникален в `cells[]` для конкретного материала.
 */
export interface CutMaterialReadinessCellDto {
  cellId: string;
  cellCode: string;
  warehouseName?: string | null;
  lineName?: string | null;
  /** Decimal как строка (формат `Prisma.Decimal.toString()`). */
  qty: string | number;
  unit: string;
}

/**
 * Готовность одного материала / `WorkshopNeed`.
 *
 * Семантика количеств:
 *   - `targetQty`    — `purchaseQty ?? calculatedQty`. Это «сколько
 *                      должны иметь к крою» для данной потребности.
 *   - `receivedQty`  — Σ POSTED `PurchaseReceiptLine.receivedQty`,
 *                      связанных с `workshopNeedId`.
 *   - `placedQty`    — то же самое, но только строки с `cellId IS NOT NULL`.
 *
 * Готовность по материалу:
 *   - `placedQty >= targetQty`              → OK;
 *   - `receivedQty >= targetQty > placedQty` → BLOCKER «Принято, но не размещено»;
 *   - `receivedQty < targetQty`              → BLOCKER «Принято X из Y» / «Не принято».
 *
 * Для некритичных ролей (THREAD/PACKAGING/APPLICATION) backend
 * заведомо помечает строку как `INFO`/`WARNING`, не превращая её в
 * BLOCKER — даже если поступлений нет. См. `CUT_BLOCKING_MATERIAL_ROLES`.
 */
export interface CutMaterialReadinessDto {
  materialRole: string;
  /** Лейбл роли из `MATERIAL_ROLE_LABELS`, если роль известная. */
  roleLabel?: string | null;
  description: string;

  /** Decimal-as-string или number; UI показывает «как есть». */
  targetQty: string | number;
  calculatedQty?: string | number | null;
  purchaseQty?: string | number | null;
  receivedQty: string | number;
  placedQty: string | number;
  unit: string;

  /**
   * `true` для критичной роли, у которой `placedQty >= targetQty`.
   * Для некритичных ролей `ready` отражает «нет требований к крою»
   * (всегда `true`), потому что они не блокируют готовность.
   */
  ready: boolean;
  status: CutReadinessCheckStatus;

  workshopNeedId?: string | null;
  workshopNeedStatus?: string | null;
  /** Принято по приёмке ERP (закупочный шов); входит в receivedQty и placedQty. */
  erpReceivedQty?: string | null;

  cells: CutMaterialReadinessCellDto[];

  /**
   * Человекочитаемое сообщение/причина статуса. Для критичных строк
   * UI рендерит его в колонке «Статус».
   */
  message?: string | null;

  /**
   * Этап «Ручная отметка поступления материала» (см.
   * `apps/api/src/modules/order-material-arrivals/*`).
   *
   * Сумма `qty` всех ACTIVE `OrderMaterialArrivalOverride`, привязанных
   * к этой `WorkshopNeed`. `null`/отсутствует, если активных
   * overrides по этой строке нет.
   *
   * Если override существует с `qty IS NULL`, сервис трактует его
   * как «покрытие `targetQty`» и в эту сумму подставляет `targetQty`.
   * Это сознательный fallback: создатель override мог не знать
   * точное количество, но сказал «материал есть».
   */
  manualArrivedQty?: string | number | null;

  /**
   * `true`, если строка считается готовой к крою благодаря
   * ACTIVE-override (а не реальной приёмке). UI показывает badge
   * «Материал поступил вручную» и поясняет, что складская приёмка
   * НЕ создана.
   */
  manuallyUnblocked?: boolean;

  /**
   * Список ACTIVE-overrides, относящихся к этой `WorkshopNeed`.
   * Опционально для backward-compat — старые потребители без
   * пересборки shared-пакета продолжают компилироваться. UI
   * использует список для рендера «кто отметил / когда / комментарий
   * / кнопка отменить».
   */
  manualArrivalOverrides?: CutMaterialArrivalOverrideRefDto[];
}

/**
 * Краткая ссылка на `OrderMaterialArrivalOverride`, встраиваемая в
 * `CutMaterialReadinessDto.manualArrivalOverrides`. Полный DTO
 * доступен через `GET /api/orders/:id/material-arrival-overrides`.
 *
 * Минимально достаточный набор полей, чтобы UI отрендерил бейдж
 * «Материал поступил вручную: <кто> · <когда>» и кнопку «Отменить»
 * (нужен только `id`).
 */
export interface CutMaterialArrivalOverrideRefDto {
  id: string;
  qty: string | number | null;
  unit: string | null;
  comment: string | null;
  createdById: string | null;
  createdByName: string | null;
  /** ISO-8601. */
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Top-level DTO
// ---------------------------------------------------------------------------

/**
 * Сводный ответ `GET /api/orders/:id/cut-readiness`.
 *
 * Инварианты:
 *   - `blockersCount`  = count(checks where status = BLOCKER) +
 *                        count(materials where status = BLOCKER);
 *   - `warningsCount`  = count(checks where status = WARNING) +
 *                        count(materials where status = WARNING);
 *   - `ready`          = `blockersCount === 0`;
 *   - `status`:
 *       - `READY`         если `blockersCount === 0` и `warningsCount === 0`;
 *       - `WARNING_ONLY`  если `blockersCount === 0` и `warningsCount > 0`;
 *       - `NOT_READY`     если `blockersCount > 0`;
 *   - `blockers` / `warnings` — плоские срезы для UI «Что нужно
 *     поправить» / «На что обратить внимание»; материальные
 *     строки тоже сюда включаются (с `key = material.<role>`).
 */
export interface CutReadinessDto {
  orderId: string;
  ready: boolean;
  status: CutReadinessStatus;
  blockersCount: number;
  warningsCount: number;
  /** ISO timestamp, когда backend выполнил проверку. */
  checkedAt: string;

  sections: {
    orderSetup: CutReadinessCheckDto[];
    pattern: CutReadinessCheckDto[];
    materials: CutMaterialReadinessDto[];
    receipts: CutReadinessCheckDto[];
    /**
     * Этап «Нанесение на заказе покупателя»: проверки заказных
     * нанесений (`OrderApplication`). Опционально для backward-compat —
     * старые потребители без пересборки shared-пакета продолжают
     * компилироваться. Backend всегда отдаёт массив (возможно пустой).
     */
    applications?: CutReadinessCheckDto[];
  };

  blockers: CutReadinessCheckDto[];
  warnings: CutReadinessCheckDto[];
}
