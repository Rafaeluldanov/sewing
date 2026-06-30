/**
 * Контракты модуля «Паспорта изделия» (Шаг 5 MVP).
 *
 * Zod-схемы — источник истины для валидации запросов на API и форм
 * на web. `type`-алиасы выведены из схем, чтобы web и api жили на
 * одних и тех же DTO.
 *
 * Скоуп Шага 5:
 * - выпуск паспорта на операции деление кроя (`CUT_DIVISION`);
 * - размещение паспорта в одной ячейке;
 * - печатная форма + QR-код;
 * - агрегация раскроя по заказу через паспорта (без пошива/ОТК/упаковки).
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

/**
 * Совпадает с `PassportStatus` в Prisma-схеме.
 *
 * - `CREATED`     — создан помощником, но ещё не двинулся;
 * - `IN_PROGRESS` — двинулся по операциям пошива (на Шаге 5 не используется);
 * - `PACKED`      — упакован, выпуск (на Шаге 5 не используется);
 * - `CANCELLED`   — отменён (на будущее).
 */
export const PASSPORT_STATUSES = [
  'CREATED',
  'IN_PROGRESS',
  'PACKED',
  'CANCELLED',
] as const;
export const PassportStatusSchema = z.enum(PASSPORT_STATUSES);
export type PassportStatus = z.infer<typeof PassportStatusSchema>;

// ---------------------------------------------------------------------------
// Request DTO
// ---------------------------------------------------------------------------

const DateStringSchema = z
  .string()
  .min(1, 'Дата обязательна')
  .refine((v) => !Number.isNaN(Date.parse(v)), {
    message: 'Некорректная дата',
  });

/**
 * Тело `POST /api/passports`.
 *
 * - `orderId`  — заказ, в рамках которого выпускается паспорт.
 * - `sizeId`   — размер; должен присутствовать в `OrderItem` заказа.
 * - `cutDate`  — дата фактического кроя.
 * - `qtyCut`   — количество физически раскроенных изделий (> 0,
 *                не сверх остатка плана).
 * - `rollNumber` — номер рулона ткани (свободная строка).
 * - `cutterId` — раскройщик, на которого записываем сдельное
 *                immediate-начисление (ADR-0005 §«Шаг 9»). PHASE 2
 *                STEP 3: поле опциональное на схеме, но backend
 *                требует его явно у не-CUTTER ролей (`CUTTER_ASSISTANT`,
 *                `SHOP_MANAGER`). Для creator с `role = CUTTER` поле
 *                можно не передавать — backend запишет паспорт на
 *                него самого. Старая опасная привязка к seed-учётке
 *                `login = 'cutter'` удалена.
 *
 * Цвет и изделие подставляются на сервере из заказа.
 */
export const CreatePassportSchema = z.object({
  orderId: z.string().min(1, 'orderId обязателен'),
  sizeId: z.string().min(1, 'sizeId обязателен'),
  cutDate: DateStringSchema,
  qtyCut: z
    .number({ invalid_type_error: 'qtyCut должен быть числом' })
    .int('qtyCut должен быть целым')
    .positive('qtyCut должен быть > 0'),
  rollNumber: z
    .string()
    .trim()
    .min(1, 'Номер рулона обязателен')
    .max(64, 'Номер рулона слишком длинный'),
  cutterId: z.string().min(1, 'cutterId обязателен').optional(),
});
export type CreatePassportDto = z.infer<typeof CreatePassportSchema>;

/**
 * Тело `POST /api/passports/release-from-rolls` — рулонный выпуск
 * помощником раскройщика (`CUTTER_ASSISTANT`).
 *
 * В отличие от ручного `POST /api/passports`, здесь помощник ничего не
 * вбивает: количество и номер рулона берутся из завершённой задачи
 * раскройщика (`CuttingTask`). Помощник выбирает расклад (`layOrdinal`),
 * размер и набор рулонов (`rollOrdinals` — из `CuttingTaskRoll.ordinal` в
 * этом раскладе), а backend на каждый рулон создаёт паспорт с
 * `qtyCut = слои рулона × раскладка размера в этом раскладе`
 * (`CuttingTaskLaySize.perLayerQty`) и `rollOrdinal = ordinal`,
 * `cuttingLayOrdinal = layOrdinal`.
 *
 * - `cutterId` НЕ передаётся: сдельное начисление за раскрой идёт
 *   автоматически на `CuttingTask.assignedToId` (раскройщик, выполнивший
 *   задачу).
 * - Идемпотентно: тройки `(layOrdinal, sizeId, ordinal)`, уже выпущенные
 *   ранее, пропускаются (кейс «сломался принтер → продолжить с нужного
 *   рулона», защита от двойного клика).
 */
export const ReleaseFromRollsSchema = z.object({
  orderId: z.string().min(1, 'orderId обязателен'),
  sizeId: z.string().min(1, 'sizeId обязателен'),
  layOrdinal: z
    .number({ invalid_type_error: 'layOrdinal должен быть числом' })
    .int('layOrdinal должен быть целым')
    .positive('layOrdinal должен быть > 0'),
  cutDate: DateStringSchema,
  rollOrdinals: z
    .array(
      z
        .number({ invalid_type_error: 'ordinal должен быть числом' })
        .int('ordinal должен быть целым')
        .positive('ordinal должен быть > 0'),
    )
    .min(1, 'Выберите хотя бы один рулон'),
});
export type ReleaseFromRollsDto = z.infer<typeof ReleaseFromRollsSchema>;

/**
 * Тело `PATCH /api/passports/:id` — редактирование полей паспорта,
 * пока он в статусе `CREATED` и ещё не «уехал» в производство.
 *
 * Зачем: помощник раскройщика на /work/passports может ошибиться при
 * выпуске (не тот размер / рулон / qty / раскройщик / дата кроя) и
 * хочет поправить, не пересоздавая паспорт. Backend разрешает edit
 * только если паспорт ещё «нетронут» — нет ячейки, нет упаковки, нет
 * `PassportEvent` кроме `CREATED`. Иначе теряются инварианты payroll
 * и cell-content. См. `PassportsService.update`,
 * `docs/domain.md §7.8a «Редактирование паспорта»`.
 *
 * Все поля опциональны: backend меняет только переданные и оставляет
 * остальные. Хотя бы одно поле должно быть передано — иначе нет
 * смысла дёргать PATCH (нет операции).
 */
export const UpdatePassportSchema = z
  .object({
    sizeId: z.string().min(1, 'sizeId обязателен').optional(),
    cutDate: DateStringSchema.optional(),
    qtyCut: z
      .number({ invalid_type_error: 'qtyCut должен быть числом' })
      .int('qtyCut должен быть целым')
      .positive('qtyCut должен быть > 0')
      .optional(),
    rollNumber: z
      .string()
      .trim()
      .min(1, 'Номер рулона обязателен')
      .max(64, 'Номер рулона слишком длинный')
      .optional(),
    cutterId: z.string().min(1, 'cutterId обязателен').optional(),
  })
  .refine(
    (v) =>
      v.sizeId !== undefined ||
      v.cutDate !== undefined ||
      v.qtyCut !== undefined ||
      v.rollNumber !== undefined ||
      v.cutterId !== undefined,
    { message: 'Передайте хотя бы одно поле для изменения' },
  );
export type UpdatePassportDto = z.infer<typeof UpdatePassportSchema>;

/**
 * Тело `POST /api/passports/:id/place`.
 *
 * Поддерживаем два варианта идентификации ячейки: по `cellId` (из
 * выпадающего списка) или `cellCode` (свободный ввод/скан, например `A1`).
 * Минимум одно поле должно быть заполнено.
 */
export const PlacePassportSchema = z
  .object({
    cellId: z.string().min(1).optional(),
    cellCode: z.string().trim().min(1).max(64).optional(),
  })
  .refine((v) => Boolean(v.cellId || v.cellCode), {
    message: 'Укажите ячейку (cellId или cellCode)',
    path: ['cellCode'],
  });
export type PlacePassportDto = z.infer<typeof PlacePassportSchema>;

// ---------------------------------------------------------------------------
// Response DTO / view-models
// ---------------------------------------------------------------------------

export interface CellLiteDto {
  id: string;
  code: string;
}

export interface CellSizeRowDto {
  sizeId: string;
  sizeCode: string;
  sizeSortOrder: number;
  quantity: number;
}

export interface CellWarehouseLiteDto {
  id: string;
  name: string;
  code: string | null;
}

export interface CellDetailDto extends CellLiteDto {
  active: boolean;
  qrCode: string;
  contents: CellSizeRowDto[];
  /**
   * Привязанный склад (см. `docs/domain.md §16`). `null`, если ячейка
   * ещё не назначена ни на один склад — на flow размещения паспорта
   * это никак не влияет.
   */
  warehouse: CellWarehouseLiteDto | null;
}

export interface PassportListItemDto {
  id: string;
  number: string;
  status: PassportStatus;
  cutDate: string; // ISO
  createdAt: string; // ISO
  qtyCut: number;
  qtyPlan: number;
  qtyDefect: number;
  qtyGood: number;
  rollNumber: string;
  sizeId: string;
  sizeCode: string;
  sizeSortOrder: number;
  currentCell: CellLiteDto | null;
  /**
   * Soft-route MVP: индекс текущего шага маршрута (`OrderRouteStep.index`,
   * 0-based). `null` — у заказа нет snapshot-а маршрута, либо паспорт
   * ещё ни разу не сканировался по операции из маршрута.
   * Поле — UI-подсказка; backend не использует его для enforcement.
   */
  currentRouteStepIndex: number | null;
}

/**
 * Сжатая ссылка «паспорт упакован в коробку». Появляется на Шаге 8;
 * `null`, если паспорт ещё не в коробке. Дублирует часть BoxLiteDto из
 * `@sewing/shared/packing`, но завязка на packing не делается, чтобы
 * не плодить циклические импорты в shared.
 */
export interface PassportBoxLiteDto {
  id: string;
  number: string;
  status: 'OPEN' | 'CLOSED';
}

/**
 * Soft-route MVP: компактный шаг маршрута для UI-подсказки на /work.
 * Дублирует часть `OrderRouteStepDto`, но без `id` — этого достаточно
 * фронту, чтобы отрисовать «Шаг N: Название» и сравнить `operationId`
 * с операцией активной смены. См. `docs/domain.md §«Маршруты производства»`.
 */
export interface PassportRouteStepLiteDto {
  index: number;
  operationId: string;
  operationCode: string;
  operationName: string;
}

/**
 * Soft-route MVP: подсказка по маршруту для отображения в /work
 * (модалка `PassportConfirmModal` и карточка активного кроя).
 *
 * Поля заполняются при наличии у заказа snapshot маршрута
 * (`OrderRouteStep[]`). Если snapshot пустой — `routeHint = null`.
 *
 * Семантика «expected» (зафиксировано в STEP 8 ТЗ MVP, см. также
 * `docs/flows.md §F4` и `docs/domain.md §18`):
 *   `expectedOperation = currentRouteStep.operation`. То же правило
 *   уже используется в `current-work-card.tsx` и оставлено единым,
 *   чтобы UI везде давал одну и ту же подсказку.
 *
 * `routeMismatchWithActiveShift` = `true` тогда и только тогда, когда:
 *   - есть `currentRouteStep` (паспорт реально стоит на каком-то шаге);
 *   - есть `activeShiftOperationId` (у сотрудника открыта смена);
 *   - они не совпадают.
 *
 * Backend НИКОГДА не использует `routeHint` для блокировок —
 * это исключительно read-only подсказка для оператора (без 409,
 * без disable-кнопок). См. ТЗ MVP §STEP 8.
 */
export interface PassportRouteHintDto {
  currentRouteStep: PassportRouteStepLiteDto | null;
  nextRouteStep: PassportRouteStepLiteDto | null;
  expectedOperationId: string | null;
  expectedOperationName: string | null;
  activeShiftOperationId: string | null;
  activeShiftOperationName: string | null;
  routeMismatchWithActiveShift: boolean;
}

export interface PassportDetailDto extends PassportListItemDto {
  qrCode: string;
  /** Готовая ссылка для печати (HTML). См. ADR-0010. */
  printUrl: string;
  color: string;
  orderId: string;
  orderNumber: string;
  productId: string;
  productName: string;
  cutterId: string;
  cutterName: string;
  creatorId: string;
  creatorName: string;
  /** Коробка, в которую паспорт был упакован (Шаг 8). `null` — ещё нет. */
  box: PassportBoxLiteDto | null;
  /**
   * Soft-route MVP: подсказка по маршруту заказа. `null`, если у
   * заказа нет snapshot маршрута. Поле справочное, без enforcement
   * (см. `PassportRouteHintDto`). Заполняется только в эндпоинтах,
   * где это уместно (`/passports/by-code`, `/passports/:id`); в
   * остальных DTO (issue/scan/complete) тоже отдаём — фронт может
   * безопасно игнорировать.
   */
  routeHint: PassportRouteHintDto | null;
}

/** Компактный ответ `POST /api/passports/:id/place`. */
export interface PassportPlacementResultDto {
  passport: PassportDetailDto;
  cell: CellDetailDto;
}

/** Одна выпущенная по рулону строка в ответе `release-from-rolls`. */
export interface ReleasedPassportLiteDto {
  id: string;
  number: string;
  qtyCut: number;
  rollNumber: string;
  rollOrdinal: number;
}

/**
 * Уведомление «выпуск превысил план размера» (см.
 * `ReleaseFromRollsResultDto.overCut`).
 *
 * Перекрой НЕ блокирует печать: настил иногда даёт больше плана (лишний
 * слой, запас под подмену брака), а раскрой уже физически выполнен.
 * Backend выставляет это поле, когда суммарный выпуск по размеру (по всем
 * раскладам заказа) превысил `OrderItem.qtyPlan`, чтобы UI показал
 * нотификацию.
 */
export interface ReleaseOverCutDto {
  sizeId: string;
  /** План заказа по размеру (`OrderItem.qtyPlan`). */
  planQty: number;
  /** Сколько выпущено по размеру суммарно после этого запроса. */
  cutQty: number;
  /** На сколько `cutQty` превышает `planQty` (всегда > 0). */
  overBy: number;
}

/**
 * Ответ `POST /api/passports/release-from-rolls`.
 *
 * `created` — паспорта, выпущенные этим запросом (для печати); может
 * быть короче `rollOrdinals`, если часть троек `(layOrdinal, sizeId,
 * ordinal)` уже была выпущена ранее или у рулона `qty = 0`. `skipped` —
 * `ordinal`-ы, пропущенные как уже выпущенные (UI покажет «уже выпущено»).
 * `overCut` — уведомление о перекрое плана размера (печать не блокируется);
 * `null`, если выпуск в пределах плана.
 */
export interface ReleaseFromRollsResultDto {
  created: ReleasedPassportLiteDto[];
  skipped: number[];
  overCut: ReleaseOverCutDto | null;
}

/**
 * Причина, по которой паспорт нельзя править/удалять помощником
 * раскройщика на /work/passports. Используется как машинный код,
 * чтобы UI мог показать локализованную подсказку и не повторял текст
 * backend-исключения (`PASSPORT_NOT_EDITABLE`).
 */
export type PassportEditableBlock =
  | 'STATUS_NOT_CREATED'
  | 'PLACED_IN_CELL'
  | 'HAS_EVENTS_BEYOND_CREATED';

/**
 * Строка для страницы «Выпущенные паспорта» помощника раскройщика.
 * Возвращается `GET /api/passports/my-recent`.
 *
 * Минимально достаточный срез для серийной правки/удаления: номер,
 * заказ, размер, qty, дата кроя — и `editable`-флаг, чтобы UI
 * знал, на каких строках можно показывать кнопки.
 */
export interface MyPassportListItem {
  id: string;
  number: string;
  status: PassportStatus;
  cutDate: string;
  createdAt: string;
  qtyCut: number;
  qtyPlan: number;
  rollNumber: string;
  sizeId: string;
  sizeCode: string;
  sizeSortOrder: number;
  orderId: string;
  orderNumber: string;
  productName: string | null;
  currentCell: CellLiteDto | null;
  /**
   * Можно ли отредактировать или удалить паспорт силами автора.
   * `true` ↔ `editableBlockReason === null`.
   */
  editable: boolean;
  /** Причина блокировки редактирования (machine-readable код). */
  editableBlockReason: PassportEditableBlock | null;
}

// ---------------------------------------------------------------------------
// History (PassportEvent timeline) — для `/master`
// ---------------------------------------------------------------------------

/**
 * Типы событий из `PassportEventType` (см. `prisma/schema.prisma`).
 * Здесь дублируем enum как литералы — shared не может зависеть от
 * `@prisma/client`. При расширении enum в schema нужно синхронно
 * расширить этот тип (TS подсветит несоответствие в `PASSPORT_EVENT_LABELS`).
 */
export type PassportHistoryEventType =
  | 'CREATED'
  | 'OPERATION_STARTED'
  | 'OPERATION_FINISHED'
  | 'MOVED'
  | 'DEFECT_RECORDED'
  | 'CELL_PLACED'
  | 'CELL_REMOVED'
  | 'ISSUED_TO_EMPLOYEE'
  | 'OPERATION_SCAN'
  | 'QC_PASSED'
  | 'WTO_PASSED'
  | 'OPERATION_REWORK_OPENED'
  | 'PACKED'
  | 'CANCELLED';

/**
 * Человекочитаемые подписи событий для UI истории паспорта
 * (страница `/master`, кнопка «Посмотреть историю паспорта»).
 * Если в `PassportEventType` появится новый литерал — TS подсветит
 * пропуск в этом mapping'е.
 */
export const PASSPORT_EVENT_LABELS: Record<PassportHistoryEventType, string> = {
  CREATED: 'Паспорт выпущен',
  OPERATION_STARTED: 'Операция начата',
  OPERATION_FINISHED: 'Операция завершена',
  MOVED: 'Перемещение',
  DEFECT_RECORDED: 'Зафиксирован брак',
  CELL_PLACED: 'Положен в ячейку',
  CELL_REMOVED: 'Вынут из ячейки',
  ISSUED_TO_EMPLOYEE: 'Выдан сотруднику',
  OPERATION_SCAN: 'Скан на операции',
  QC_PASSED: 'ОТК пройдено',
  WTO_PASSED: 'ВТО пройдено',
  OPERATION_REWORK_OPENED: 'Возврат на переделку',
  PACKED: 'Упакован',
  CANCELLED: 'Отменён',
};

/**
 * Одна строка истории паспорта. Источник — `PassportEvent` +
 * подтянутые имена `Operation` / `Employee` / `Cell`.
 *
 * Поля типа `*Name` / `*Code` — текущие справочные значения (без
 * historic-snapshot): паспорт может ссылаться на переименованную
 * операцию, мы это не воспроизводим, отдаём актуальное имя на момент
 * запроса.
 *
 * `manual = true` для событий, созданных ручной правкой админа (по
 * convention id с префиксом `man_`). Это позволяет UI пометить такую
 * строку «(ручная правка)», чтобы мастер понимал, что событие не
 * пришло из обычного flow.
 */
export interface PassportHistoryEventDto {
  id: string;
  type: PassportHistoryEventType;
  /**
   * Подпись типа события — `PASSPORT_EVENT_LABELS[type]`. Дублируем
   * на бэке, чтобы UI не зависел от константы — но клиент всё равно
   * может использовать локальный mapping (например, для i18n).
   */
  typeLabel: string;
  createdAt: string;
  /**
   * Кто действовал. `null` для системных событий (`CELL_PLACED`,
   * `CELL_REMOVED` — пишутся flow без явного исполнителя).
   */
  employee: { id: string; fullName: string } | null;
  /** Операция, к которой привязано событие. `null` для CREATED/CELL_*. */
  operation: { id: string; name: string } | null;
  /**
   * «Откуда» — для `MOVED` (паспорт ушёл с предыдущей операции на
   * `operation`). Для остальных типов `null`.
   */
  fromOperation: { id: string; name: string } | null;
  /** Ячейка, если событие связано с ячейкой (`CELL_PLACED`, `ISSUED_TO_EMPLOYEE`). */
  cell: { id: string; code: string } | null;
  /** Кол-во штук, к которому относится событие. `null`, если не применимо. */
  qty: number | null;
  /** Кол-во брака для `DEFECT_RECORDED`. */
  defectQty: number | null;
  /**
   * `true`, если запись создана ручной правкой админа (id с префиксом
   * `man_`). UI помечает такие строки «(ручная правка)».
   */
  manual: boolean;
}

/**
 * Ответ `GET /api/passports/:id/history`. Список событий в
 * хронологическом порядке (старые → новые).
 */
export interface PassportHistoryDto {
  passportId: string;
  events: PassportHistoryEventDto[];
}
