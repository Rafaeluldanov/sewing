/**
 * Контракты Шага 6 MVP: смена сотрудника, выдача кроя, сканирование
 * паспорта на операции.
 *
 * Zod-схемы — источник истины для API и server actions web-клиента.
 * Начиная с MVP 1.1 (ADR-0014) `employeeId` берётся из сессии и из
 * тела запроса убран. Web-клиент больше не хранит `demo-employee-id`.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Shift session
// ---------------------------------------------------------------------------

export const StartShiftSchema = z.object({
  equipmentId: z.string().min(1, 'equipmentId обязателен'),
  operationId: z.string().min(1, 'operationId обязателен'),
});
export type StartShiftDto = z.infer<typeof StartShiftSchema>;

/**
 * Тело `POST /api/shifts/stop` после MVP 1.1 — пустое: владелец смены
 * однозначно определяется сессией. Схема оставлена для совместимости
 * сигнатур контроллеров.
 */
export const StopShiftSchema = z.object({}).strict();
export type StopShiftDto = z.infer<typeof StopShiftSchema>;

/**
 * Тело `POST /api/shifts/switch-operation` — переключение операции в
 * активной смене без закрытия/открытия. Используется, когда у швеи на
 * одном оборудовании разрешено несколько операций (например, «Распошив
 * подгиб» и «Распошив рукава» на распошивальной машине), и она хочет
 * перейти с одной на другую без потери смены.
 *
 * `employeeId` берётся из сессии. Backend требует, чтобы у сотрудника
 * сейчас не было ни одного паспорта с `currentEmployeeId = me`
 * (`SHIFT_HAS_ACTIVE_PASSPORTS`) — иначе при `complete` событие
 * `OPERATION_FINISHED` записалось бы на новую операцию вместо той,
 * на которой паспорт реально делался.
 */
export const SwitchShiftOperationSchema = z
  .object({
    operationId: z.string().min(1, 'operationId обязателен'),
  })
  .strict();
export type SwitchShiftOperationDto = z.infer<
  typeof SwitchShiftOperationSchema
>;

export interface ShiftSessionDto {
  id: string;
  employeeId: string;
  employeeFullName: string;
  equipmentId: string;
  equipmentCode: string;
  equipmentName: string;
  operationId: string;
  operationCode: string;
  operationName: string;
  startedAt: string; // ISO
  endedAt: string | null;
  active: boolean;
}

// ---------------------------------------------------------------------------
// Work meta (демо-пикер сотрудника + справочники для формы старта смены)
// ---------------------------------------------------------------------------

export interface EmployeeLiteDto {
  id: string;
  login: string;
  fullName: string;
  role: string;
}

export interface EquipmentLiteDto {
  id: string;
  code: string;
  name: string;
  active: boolean;
  /**
   * Операции (`Operation.id`), разрешённые для этой единицы оборудования.
   * Источник истины — таблица `EquipmentOperation` (см. ADR-0017).
   * Порядок совпадает с порядком отображения на /work
   * (отсортировано по `EquipmentOperation.sortOrder`).
   *
   * Если оборудование не настроено (пустой массив), seamstress flow на
   * /work показывает empty-state «Для этого оборудования нет
   * настроенных операций — обратитесь к мастеру».
   */
  allowedOperationIds: string[];
}

export interface OperationLiteDto {
  id: string;
  code: string;
  name: string;
  category: string;
  sortOrder: number;
  active: boolean;
  /**
   * Способ оплаты операции (`FIXED` | `BY_SIZE` | `SALARY_ONLY`).
   * Опционально: не все источники `OperationLiteDto` его заполняют.
   * Редактор маршрута использует его, чтобы показывать поле
   * «расценка для изделия» только у сдельных `FIXED`-операций.
   */
  pricingMode?: string;
  /**
   * Дефолтная сдельная расценка операции (₽/шт) для `pricingMode = FIXED`
   * или `null`. Показывается в UI как «по умолчанию N ₽», поверх
   * которой задаётся переопределение для конкретного изделия.
   */
  fixedRate?: number | null;
  /**
   * Признак «это коробочная упаковка» (`Operation.boxPacking`).
   * Опционально: не все источники `OperationLiteDto` его заполняют
   * (`GET /api/shifts/meta` — заполняет).
   *
   * Нужен терминалу `/packing`: по операции активной смены он решает,
   * показать окно коробок (`true`) или обычный passport-flow скан +
   * завершение (`false` — так работает «Распаковка», операция
   * категории `PACKING`, стоящая первым шагом маршрута). Категория
   * операции для этой развилки больше не используется.
   */
  boxPacking?: boolean;
}

/** Ответ `GET /api/shifts/meta` — всё нужное для формы старта смены. */
export interface ShiftMetaDto {
  employees: EmployeeLiteDto[];
  equipment: EquipmentLiteDto[];
  operations: OperationLiteDto[];
}

// ---------------------------------------------------------------------------
// Passport issue / scan (Шаг 6)
// ---------------------------------------------------------------------------

/**
 * Тело `POST /api/passports/:id/issue` — «Получить крой».
 * После MVP 1.1 владелец действия определяется сессией — тело пустое,
 * схема оставлена для единообразия контроллерных сигнатур.
 */
export const IssuePassportSchema = z.object({}).strict();
export type IssuePassportDto = z.infer<typeof IssuePassportSchema>;

/** Тело `POST /api/passports/:id/scan` — сканирование на операции. */
export const ScanPassportSchema = z.object({}).strict();
export type ScanPassportDto = z.infer<typeof ScanPassportSchema>;

/**
 * Тело `POST /api/passports/:id/complete-operation` — швея завершает
 * свою операцию по паспорту (снятие себя как `currentEmployee`).
 *
 * Владелец действия определяется сессией (ADR-0014), поэтому тело пустое.
 * Серверная проверка:
 *   - `passport.currentEmployeeId = me`;
 *   - `passport.status = IN_PROGRESS`.
 * Чужой паспорт или паспорт в терминальном статусе — 409 с бизнес-кодом.
 */
export const CompleteOperationSchema = z.object({}).strict();
export type CompleteOperationDto = z.infer<typeof CompleteOperationSchema>;

/**
 * Тело `POST /api/passports/batch/complete-operations` — пакетное
 * завершение операций швеёй сразу по нескольким паспортам, которые
 * уже закреплены за ней (`Passport.currentEmployeeId = me`). UX на
 * /work: швея отмечает чекбоксами карточки в «Текущий крой» и жмёт
 * «Завершить выбранные», вместо посканного завершения по одному.
 *
 * Семантика — те же серверные проверки, что у одиночного
 * `complete-operation`, выполняемые для каждого паспорта в своей
 * транзакции (см. `PassportsService.completeOperationsBatch`):
 * партиальный успех допустим, упавший паспорт не блокирует остальные.
 * `employeeId` берётся из сессии (ADR-0014).
 */
export const BatchCompleteOperationsSchema = z
  .object({
    passportIds: z
      .array(z.string().min(1, 'passportId обязателен'))
      .min(1, 'Выберите хотя бы один паспорт')
      .max(200, 'Слишком много паспортов за один раз'),
  })
  .strict();
export type BatchCompleteOperationsDto = z.infer<
  typeof BatchCompleteOperationsSchema
>;

/**
 * Результат пакетного завершения. `completed` — паспорта, по которым
 * операция закрылась; `failed` — те, что не удалось закрыть, с
 * бизнес-кодом и готовым к показу сообщением (например, откат назад
 * `PASSPORT_COMPLETE_BACKWARD` или незакрытая параллельная группа
 * `PASSPORT_PARALLEL_GROUP_INCOMPLETE`). UI показывает сводку «закрыто
 * N, не закрыто M» и перечисляет причины по `failed`.
 */
export interface BatchCompleteOperationsResultDto {
  completed: { passportId: string; number: string }[];
  failed: {
    passportId: string;
    number: string | null;
    error: string;
    code: string | null;
  }[];
}

/** Тело `POST /api/passports/by-code/:code/*` — поиск по номеру/QR. */
export const PassportCodeSchema = z
  .string()
  .trim()
  .min(1, 'Код паспорта обязателен')
  .max(128, 'Код слишком длинный');

// ---------------------------------------------------------------------------
// Current work (Шаг 6.1: «текущий крой в работе у швеи»)
// ---------------------------------------------------------------------------

/**
 * Активный крой, закреплённый за конкретным сотрудником прямо сейчас.
 *
 * Правило (см. `docs/flows.md §F3a`/`§F4`): паспорт считается «в работе
 * у меня», если `Passport.currentEmployeeId = me.employeeId` и
 * `status = IN_PROGRESS`. Когда другой сотрудник скан-нул паспорт на
 * следующей операции — `currentEmployeeId` перезаписывается, и
 * паспорт автоматически уходит из этого списка. Когда упаковщик закрыл
 * паспорт — `status` становится `PACKED`, и он тоже уходит.
 *
 * Endpoint: `GET /api/shifts/current-work` — backend сам вырезает
 * данные по сессии (`@CurrentUser`), никаких employeeId-параметров от
 * клиента (см. ADR-0014).
 */
/**
 * Один паспорт в секции «К переделке» у швеи (см.
 * `apps/api/src/modules/shifts/shifts.service.ts::getMyReworkPassports`,
 * `apps/web/app/work/seamstress-active-panel.tsx`). Источник —
 * `PassportEvent(OPERATION_REWORK_OPENED)` с `employeeId = me` и без
 * последующего `OPERATION_FINISHED` для пары (passport, operationId).
 *
 * Это не «в работе у меня» (`currentEmployeeId = me`) — паспорт ещё
 * физически у ОТК / по дороге к швее. UI подсказывает: «забери
 * паспорт у ОТК, потом сосканируй у своего станка как обычно».
 */
export interface ReworkPassportDto {
  passportId: string;
  passportNumber: string;
  orderId: string;
  orderNumber: string;
  productName: string;
  color: string;
  sizeCode: string;
  qtyCut: number;
  qtyGood: number;
  /** Операция, на которую возвращён паспорт (target rework). */
  operationCode: string;
  operationName: string;
  /** Когда ОТК нажал «Вернуть на переделку» (для подписи «возвращён в HH:MM»). */
  reworkedAt: string;
}

export interface CurrentWorkPassportDto {
  id: string;
  number: string;
  productName: string;
  color: string;
  sizeId: string;
  sizeCode: string;
  qtyCut: number;
  qtyGood: number;
  qtyDefect: number;
  rollNumber: string;
  /** PassportStatus в string-форме (на стороне UI хватает строки). */
  status: string;
  /**
   * Текущая операция самого паспорта (`Passport.currentOperationId`).
   * После issue от ячейки тут ещё может быть `CUT_DIVISION` — реальный
   * перевод на пошивную операцию случится первым `OPERATION_SCAN`.
   */
  currentOperationId: string | null;
  currentOperationCode: string | null;
  currentOperationName: string | null;
  /**
   * Время последнего `ISSUED_TO_EMPLOYEE` события, инициированного
   * текущим сотрудником, либо `null`, если такого события не было
   * (в этом случае — UI просто покажет `updatedAt`).
   */
  acceptedAt: string | null;
  /** `Passport.updatedAt` — для сортировки и подписи «обновлено». */
  updatedAt: string;
  /**
   * Soft-route MVP: индекс текущего шага (`OrderRouteStep.index`) или
   * `null`, если у заказа нет snapshot маршрута / шаг ещё не известен.
   * См. `docs/domain.md §«Маршруты производства»`.
   */
  currentRouteStepIndex: number | null;
  /**
   * Краткая «карта маршрута» для подсказки на /work: текущий шаг и
   * следующий шаг. `null` — у заказа нет snapshot-а или паспорт уже
   * прошёл последний шаг. Backend никогда не использует эти поля для
   * блокировки скана — это исключительно UI-подсказка.
   */
  routeCurrentStep: {
    index: number;
    operationId: string;
    operationCode: string;
    operationName: string;
  } | null;
  routeNextStep: {
    index: number;
    operationId: string;
    operationCode: string;
    operationName: string;
  } | null;
  /**
   * Все операции снимка маршрута заказа. Нужны /work, чтобы отличить
   * «операция в маршруте есть, но не та по очереди» (частая штатная
   * ситуация — молчим или говорим спокойно) от «операции нет в маршруте
   * ВООБЩЕ» (работа не засчитается на гейте перед ОТК, заказ встанет —
   * об этом надо кричать). До 28.07.2026 UI обе ситуации показывал
   * одинаковым жёлтым баннером, к нему привыкли, и реальное отклонение
   * 01.07 не отличили от фона.
   *
   * Пустой массив — у заказа нет снимка маршрута, сравнивать не с чем.
   */
  routeOperationIds: string[];
}
