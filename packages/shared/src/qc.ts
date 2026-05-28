/**
 * Контракты Шага 7 MVP: ОТК и фиксация брака по паспорту.
 *
 * Zod-схемы — источник истины для валидации запросов на API и форм
 * на web. `type`-алиасы выведены из схем, чтобы web и api жили на
 * одних и тех же DTO.
 *
 * Скоуп Шага 7:
 * - справочник видов брака (`DefectType`);
 * - список паспортов, доступных для ОТК;
 * - карточка паспорта для ОТК + история дефектов;
 * - фиксация брака (`PassportDefect` + `PassportEvent(DEFECT_RECORDED)`);
 * - агрегация `qtyDefect` в паспорте/заказе.
 *
 * За рамками Шага 7: ВТО, упаковка, коробки, зарплата ОТК (оклад),
 * расследование виновной операции, возврат брака в производство,
 * split одного паспорта на отдельные подпаспорта по браку, экран «Цех».
 */

import { z } from 'zod';
import type { PassportStatus } from './passports';

// ---------------------------------------------------------------------------
// Defect type dictionary
// ---------------------------------------------------------------------------

export interface DefectTypeDto {
  id: string;
  code: string;
  name: string;
  isActive: boolean;
  sortOrder: number;
}

// ---------------------------------------------------------------------------
// Recording a defect
// ---------------------------------------------------------------------------

/**
 * Тело `POST /api/qc/passports/:id/defects`.
 *
 * Правила:
 *   - `defectTypeId` — обязателен; должен существовать и быть активным;
 *   - `qty` — целое > 0; не может превышать `qtyCut − Σ зафиксированного
 *     ранее брака` (сервер вернёт 422 `DEFECT_EXCEEDS_REMAINING`);
 *   - `comment` — опционально, ≤ 500 символов.
 *
 * Идентификация ОТК-сотрудника берётся из сессии (ADR-0014). Поле
 * `employeeId` из тела убрано на MVP 1.1.
 */
export const CreatePassportDefectSchema = z.object({
  defectTypeId: z.string().min(1, 'defectTypeId обязателен'),
  qty: z
    .number({ invalid_type_error: 'qty должен быть числом' })
    .int('qty должен быть целым')
    .positive('qty должен быть > 0'),
  comment: z.string().trim().max(500).optional(),
});
export type CreatePassportDefectDto = z.infer<typeof CreatePassportDefectSchema>;

// ---------------------------------------------------------------------------
// Return to rework
// ---------------------------------------------------------------------------

/**
 * Тело `POST /api/qc/passports/:id/return-to-rework`.
 *
 * `targetOperationId` — операция, на которую возвращаем паспорт.
 * Должна быть в списке `QcPassportDetailDto.eligibleReworkTargets`
 * (SEW-операция из маршрута, у которой есть `OPERATION_FINISHED`
 * и нет открытого rework). Сервер берёт швею-получателя из
 * последнего `OPERATION_FINISHED` для этой операции.
 *
 * См. `QcService.returnToRework`, `docs/flows.md §F5a`.
 */
export const ReturnToReworkSchema = z.object({
  targetOperationId: z.string().min(1, 'Выберите операцию для возврата'),
});
export type ReturnToReworkDto = z.infer<typeof ReturnToReworkSchema>;

// ---------------------------------------------------------------------------
// QC list query
// ---------------------------------------------------------------------------

export const ListQcPassportsQuerySchema = z.object({
  search: z.string().trim().max(100).optional(),
  orderId: z.string().min(1).optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(200).default(50),
});
export type ListQcPassportsQuery = z.infer<typeof ListQcPassportsQuerySchema>;

// ---------------------------------------------------------------------------
// Response DTO / view-models
// ---------------------------------------------------------------------------

/**
 * Запись зафиксированного дефекта (для истории на карточке паспорта
 * и для аналитики). `createdByEmployee*` опциональны — на этапе без
 * auth (см. ADR-0010) ОТК не идентифицируется явно.
 */
export interface PassportDefectDto {
  id: string;
  passportId: string;
  defectTypeId: string;
  defectTypeCode: string;
  defectTypeName: string;
  qty: number;
  comment: string | null;
  createdAt: string; // ISO
  createdByEmployeeId: string | null;
  createdByEmployeeName: string | null;
}

/** Сжатая строка списка ОТК (`GET /api/qc/passports`). */
export interface QcPassportListItemDto {
  passportId: string;
  passportNumber: string;
  orderId: string;
  orderNumber: string;
  productName: string;
  color: string;
  sizeId: string;
  sizeCode: string;
  sizeSortOrder: number;
  qtyCut: number;
  qtyDefect: number;
  qtyGood: number;
  status: PassportStatus;
  currentOperationCode: string | null;
  currentOperationName: string | null;
  currentEmployeeId: string | null;
  currentEmployeeName: string | null;
  updatedAt: string; // ISO
}

/**
 * Один кандидат на возврат в переделку. Каждая SEW-операция из
 * маршрута заказа, у которой есть `OPERATION_FINISHED` в истории
 * паспорта и нет открытого rework, попадает в это перечисление.
 * `finisher*` — швея, что финишировала эту операцию (последний
 * `OPERATION_FINISHED` для пары `(passport, operation)`).
 */
export interface EligibleReworkTargetDto {
  operationId: string;
  operationCode: string;
  operationName: string;
  routeStepIndex: number;
  finisherEmployeeId: string;
  finisherEmployeeName: string;
  finishedAt: string;
}

/** Карточка ОТК (`GET /api/qc/passports/:id`). */
export interface QcPassportDetailDto extends QcPassportListItemDto {
  rollNumber: string;
  cutDate: string; // ISO
  createdAt: string; // ISO
  qtyPlan: number;
  defects: PassportDefectDto[];
  /** Можно ли фиксировать ещё брак (qtyCut − qtyDefect > 0 и статус допустим). */
  canRecordDefect: boolean;
  /** Сколько ещё штук можно отметить браком (`qtyCut − qtyDefect`). */
  remainingForDefect: number;
  /**
   * Когда ОТК последний раз отметил «Проверка выполнена» по этому
   * паспорту (`PassportEvent(QC_PASSED)`). `null` — проверка ещё не
   * подтверждена. Это аудит-маркер: статус паспорта не меняется,
   * `recordDefect` остаётся доступным даже после завершения
   * (повторная проверка/обнаружение брака после первичной QC).
   */
  qcCompletedAt: string | null;
  /**
   * Можно ли сейчас отметить «Проверка выполнена». На MVP правило:
   * `status = IN_PROGRESS` (терминальные `PACKED`/`CANCELLED` не
   * допускаются — закрывать нечего).
   */
  canCompleteQc: boolean;
  /**
   * Backend-сигнал «паспорт уже ушёл с ОТК».
   *
   * `true`, если ОТК уже подтверждал «Проверка выполнена»
   * (`qcCompletedAt != null`) И паспорт после этого либо стал
   * терминальным (`PACKED`/`CANCELLED`), либо его реально
   * отсканировали на следующей операции (свежий
   * `PassportEvent(OPERATION_SCAN)` после `qcCompletedAt`). В этом
   * случае scan-driven терминал ОТК (`apps/web/app/qc/qc-terminal.tsx`)
   * убирает свернутую строку «Проверено ОТК» из окна — паспорт
   * больше не относится к ОТК.
   */
  removedFromQc: boolean;
  /**
   * Можно ли сейчас нажать «Вернуть на переделку». `true`, если
   * паспорт `IN_PROGRESS`, `eligibleReworkTargets.length > 0` и нет
   * уже открытого rework (`reworkPending === false`).
   */
  canReturnToRework: boolean;
  /**
   * Список операций, на которые можно вернуть паспорт. Заполняется
   * только если `canReturnToRework`. UI рендерит из него radio-список
   * и подставляет имя финишёра в подпись confirm-диалога. См.
   * `EligibleReworkTargetDto`.
   */
  eligibleReworkTargets: EligibleReworkTargetDto[];
  /**
   * `true`, если по паспорту был `OPERATION_REWORK_OPENED` после
   * последнего `OPERATION_FINISHED` — то есть ОТК уже отправил его
   * на переделку и ждёт, пока швея заберёт. В этом состоянии
   * `canRecordDefect`/`canCompleteQc`/`canReturnToRework` все
   * `false`, карточка показывается в read-only с баннером
   * «Сейчас на переделке у …».
   */
  reworkPending: boolean;
  /**
   * Подробности активного rework для read-only баннера, если
   * `reworkPending === true`. Берётся из последнего открытого
   * `OPERATION_REWORK_OPENED` — здесь `employeeName` имя реальной
   * швеи-получателя (а не текущего `currentEmployeeName`, которое
   * после rework равно `null`). `null`, если rework не открыт.
   */
  reworkAssignment: {
    operationId: string;
    operationCode: string;
    operationName: string;
    employeeId: string;
    employeeName: string;
    reworkedAt: string;
  } | null;
  /**
   * `true`, если паспорт сейчас стоит на ОТК-операции и по этой ОТК
   * открыт `OPERATION_REWORK_OPENED` — то есть мастер цеха вернул
   * паспорт на повторную проверку через `set-route-step backward`
   * (см. `MasterActionsService.setRouteStep`, ветка
   * `reopenFinishedTarget`). В этом состоянии:
   *   - карточка показывается в рабочем режиме (а не read-only как при
   *     обычном `reworkPending`);
   *   - `qcCompletedAt` принудительно `null` — старый `QC_PASSED` от
   *     предыдущего прохода не считаем за «уже проверено», иначе
   *     сверху висел бы зелёный бейдж и ОТК подумал бы, что делать
   *     ничего не надо;
   *   - в UI поверх карточки рисуется плашка «Возвращён мастером на
   *     повторную проверку», см. `apps/web/app/qc/qc-work-card.tsx`.
   */
  incomingReworkAtQc: boolean;
}

// ---------------------------------------------------------------------------
// Incoming reworks banner
// ---------------------------------------------------------------------------

/**
 * Одна строка в баннере «Возвращены на повторную проверку» на /qc
 * (`GET /api/qc/incoming-reworks`). Берётся из паспортов, что стоят
 * на операции текущей ОТК-смены и по которым на этой же операции
 * открыт `OPERATION_REWORK_OPENED` (мастер вернул через
 * backward `set-route-step`). См. `QcService.listIncomingReworks`.
 */
export interface QcIncomingReworkDto {
  passportId: string;
  passportNumber: string;
  orderNumber: string;
  productName: string;
  color: string;
  sizeCode: string;
  sizeSortOrder: number;
  qtyGood: number;
  /** ISO; момент `OPERATION_REWORK_OPENED` от мастера. */
  returnedAt: string;
}
