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
   * паспорт `IN_PROGRESS`, есть кому возвращать (хотя бы один
   * `OPERATION_FINISHED`) и нет уже открытого rework
   * (`reworkPending === false`).
   */
  canReturnToRework: boolean;
  /**
   * `true`, если по паспорту был `OPERATION_REWORK_OPENED` после
   * последнего `OPERATION_FINISHED` — то есть ОТК уже отправил его
   * на переделку и ждёт, пока швея заберёт. В этом состоянии
   * `canRecordDefect`/`canCompleteQc`/`canReturnToRework` все
   * `false`, карточка показывается в read-only с баннером
   * «Сейчас на переделке у …».
   */
  reworkPending: boolean;
}
