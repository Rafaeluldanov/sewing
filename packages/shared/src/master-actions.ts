/**
 * Контракты модуля «Действия мастера над паспортами» (Stage 2 «Мастер
 * цеха», см. `apps/api/src/modules/master-actions/*`,
 * `docs/domain.md §«Действия мастера»`,
 * `docs/flows.md §«F-Master actions»`,
 * `docs/screens.md §«/master mobile actions UI»`).
 *
 * Назначение: дать `SHOPFLOOR_MASTER` (и `SHOP_MANAGER` / `ADMIN`)
 * безопасные ручные действия с паспортами кроя для закрытия проблем —
 * «снять с сотрудника», «передать другому сотруднику», «вернуть в
 * ячейку», «назначить операцию маршрута». Все действия:
 *   - идут через `prisma.$transaction(...)`;
 *   - пишут запись в `AuditLog` с `before`/`after`-снэпшотом;
 *   - требуют обязательной `reason` и опционального `comment`.
 *
 * Stage 2 НЕ делает: ограничения выдачи кроя, авто-fix, передачу
 * паспортов без подтверждения мастера — это сознательно out of scope
 * (см. `docs/domain.md §«Действия мастера»`).
 */

import { z } from 'zod';
import type { MasterCallPassportDto } from './master-calls';

// ---------------------------------------------------------------------------
// Reason
// ---------------------------------------------------------------------------

/**
 * Список причин, по которым мастер инициирует ручное действие.
 *
 * Источник истины — единый список, чтобы UI (select на bottom-sheet),
 * API (validation) и аналитика (`AuditLog.payload.reason`) видели
 * один и тот же словарь без расхождений. Расширение списка не ломает
 * совместимость — Zod-enum в API мягко разрастётся, старые значения
 * продолжат проходить.
 *
 * Семантика (см. `docs/domain.md §«Действия мастера»`):
 *   - `WRONG_SCAN`         — сотрудник ошибочно отсканировал чужой паспорт;
 *   - `SHIFT_HANDOVER`     — пересменка/передача незакрытой работы;
 *   - `EMPLOYEE_MISTAKE`   — ошибка сотрудника, требующая ручной правки;
 *   - `ROUTE_CORRECTION`   — корректировка операции маршрута;
 *   - `CELL_CORRECTION`    — корректировка ячейки;
 *   - `MANAGER_DECISION`   — решение начальника цеха / админа;
 *   - `OTHER`              — иное (рядом обязателен `comment`, см. UI).
 */
export const MASTER_ACTION_REASONS = [
  'WRONG_SCAN',
  'SHIFT_HANDOVER',
  'EMPLOYEE_MISTAKE',
  'ROUTE_CORRECTION',
  'CELL_CORRECTION',
  'MANAGER_DECISION',
  'OTHER',
] as const;

export const MasterActionReasonSchema = z.enum(MASTER_ACTION_REASONS);
export type MasterActionReason = z.infer<typeof MasterActionReasonSchema>;

/**
 * Человекочитаемые подписи причин для UI (mobile bottom sheet,
 * `apps/web/app/master/passport-actions-sheet.tsx`). Хранятся в
 * shared-пакете, чтобы экраны не дублировали лейблы и не
 * расходились с API.
 */
export const MASTER_ACTION_REASON_LABELS: Record<MasterActionReason, string> =
  {
    WRONG_SCAN: 'Ошибочный скан',
    SHIFT_HANDOVER: 'Передача смены',
    EMPLOYEE_MISTAKE: 'Ошибка сотрудника',
    ROUTE_CORRECTION: 'Коррекция маршрута',
    CELL_CORRECTION: 'Коррекция ячейки',
    MANAGER_DECISION: 'Решение менеджера',
    OTHER: 'Другая причина',
  };

// ---------------------------------------------------------------------------
// Common fields
// ---------------------------------------------------------------------------

/**
 * Общие поля для всех bodies action-эндпоинтов: обязательная причина и
 * необязательный комментарий. Без `reason` Zod даст 400 ещё до сервиса —
 * это backend-инвариант «без причины ручное действие невозможно».
 */
const ReasonFields = {
  reason: MasterActionReasonSchema,
  comment: z.string().trim().min(1).max(500).optional(),
};

/**
 * Поле `cellQr` или `cellId` (нужен ровно один). UI чаще всего отдаёт
 * `cellQr` — то, что прочитала камера (`cell:<id>` или человекочитаемый
 * `code`). `cellId` оставлен как fallback для отладки/admin-переходов.
 */
const CellTargetFields = {
  cellQr: z.string().trim().min(1).max(200).optional(),
  cellId: z.string().trim().min(1).max(64).optional(),
};

/**
 * Поле `employeeQr` или `employeeId` (нужен ровно один). Аналог
 * `CellTargetFields`. UI обычно даёт `employeeQr` (`EMPLOYEE:<id>`),
 * но `employeeId` оставлен как fallback (например, при выборе из
 * списка активных сотрудников без QR-печати).
 */
const EmployeeTargetFields = {
  employeeQr: z.string().trim().min(1).max(200).optional(),
  employeeId: z.string().trim().min(1).max(64).optional(),
};

// ---------------------------------------------------------------------------
// Bodies
// ---------------------------------------------------------------------------

/**
 * `POST /api/master-actions/passports/:id/unassign`.
 *
 * Снять паспорт с сотрудника (`currentEmployeeId = null`). Статус
 * `IN_PROGRESS` сохраняем — это точечная коррекция владельца, а не
 * движение по pipeline (см. `docs/domain.md §«Действия мастера»`).
 */
export const UnassignPassportSchema = z.object({ ...ReasonFields });
export type UnassignPassportDto = z.infer<typeof UnassignPassportSchema>;

/**
 * `POST /api/master-actions/passports/:id/transfer-to-employee`.
 *
 * Переназначить паспорт другому активному сотруднику. Если у target
 * есть активная смена с `operationId` из snapshot маршрута заказа —
 * переводим `currentOperationId` / `currentRouteStepIndex` в этот шаг
 * (route-WIP логика). Без активной смены трогаем только владельца.
 */
export const TransferPassportSchema = z
  .object({
    ...ReasonFields,
    ...EmployeeTargetFields,
  })
  .refine(
    (v) =>
      Boolean(v.employeeQr && v.employeeQr.length > 0) ||
      Boolean(v.employeeId && v.employeeId.length > 0),
    {
      message: 'Передайте employeeQr или employeeId',
      path: ['employeeQr'],
    },
  );
export type TransferPassportDto = z.infer<typeof TransferPassportSchema>;

/**
 * `POST /api/master-actions/passports/:id/return-to-cell`.
 *
 * Вернуть паспорт в активную ячейку. Это «обратное» действие к
 * issue-flow: `currentCellId = cell.id`, `currentEmployeeId = null`,
 * `CellContent[size] += qtyCut`. Статус оставляем `IN_PROGRESS`
 * (паспорт уже был в работе — формальный backstep до `CREATED` не
 * нужен и сломал бы аналитику; см. `docs/domain.md §«Действия мастера»`).
 */
export const ReturnPassportToCellSchema = z
  .object({
    ...ReasonFields,
    ...CellTargetFields,
  })
  .refine(
    (v) =>
      Boolean(v.cellQr && v.cellQr.length > 0) ||
      Boolean(v.cellId && v.cellId.length > 0),
    {
      message: 'Передайте cellQr или cellId',
      path: ['cellQr'],
    },
  );
export type ReturnPassportToCellDto = z.infer<
  typeof ReturnPassportToCellSchema
>;

/**
 * `POST /api/master-actions/passports/:id/set-route-step`.
 *
 * Назначить паспорт на операцию маршрута заказа (snapshot
 * `OrderRouteStep[]`). Доступны два способа адресации: `routeStepIndex`
 * (предпочтительно — UI рендерит список из snapshot) или `operationId`
 * (fallback).
 *
 * **Forward-движение** (target.index ≥ currentRouteStepIndex): паспорт
 * уходит «в воздух» — `currentEmployeeId = null`, `currentCellId = null`.
 * Следующий сотрудник перехватит штатным `scan` / `issue`.
 *
 * **Backward-движение** (target.index < currentRouteStepIndex): по
 * инварианту «нет тихого rollback» (см. `docs/flows.md
 * §«F-Master rollback»`) обязательно требуется размещение в ячейку
 * (`cellQr` или `cellId`). Иначе backend отвечает 400
 * `MASTER_BACKWARD_ROUTE_REQUIRES_CELL`. После применения паспорт
 * оказывается в указанной ячейке (`currentCellId = cell.id`,
 * `CellContent` увеличивается на `qtyCut`), `currentEmployeeId = null`.
 */
export const SetRouteStepSchema = z
  .object({
    ...ReasonFields,
    routeStepIndex: z.number().int().min(0).max(1000).optional(),
    operationId: z.string().trim().min(1).max(64).optional(),
    ...CellTargetFields,
  })
  .refine(
    (v) => v.routeStepIndex !== undefined || Boolean(v.operationId),
    {
      message: 'Передайте routeStepIndex или operationId',
      path: ['routeStepIndex'],
    },
  );
export type SetRouteStepDto = z.infer<typeof SetRouteStepSchema>;

// ---------------------------------------------------------------------------
// Response DTOs
// ---------------------------------------------------------------------------

/**
 * Снимок паспорта «после» действия. Тот же набор полей, что и
 * `MasterCallPassportDto`, чтобы UI мог точечно заменить элемент в
 * `currentPassports` без перезагрузки карточки.
 */
export interface MasterActionPassportSnapshotDto {
  id: string;
  number: string;
  size: string;
  color: string | null;
  qtyCut: number;
  status: 'CREATED' | 'IN_PROGRESS' | 'PACKED' | 'CANCELLED';
  currentEmployeeId: string | null;
  currentEmployeeName: string | null;
  currentOperation: { id: string; name: string } | null;
  currentCell: { id: string; code: string } | null;
  currentRouteStepIndex: number | null;
}

/**
 * Унифицированный ответ всех action-эндпоинтов — снэпшот «до/после»,
 * чтобы UI мог обновить карточку без отдельного GET и при необходимости
 * показать пользователю diff («Сняли с Иванова», «Назначили операцию
 * Оверлок 1»).
 */
export interface MasterActionResultDto {
  passport: MasterActionPassportSnapshotDto;
  before: Pick<
    MasterActionPassportSnapshotDto,
    | 'currentEmployeeId'
    | 'currentEmployeeName'
    | 'currentOperation'
    | 'currentCell'
    | 'currentRouteStepIndex'
    | 'status'
  >;
}

// ---------------------------------------------------------------------------
// Find passport by code (для кнопки «Сканировать паспорт» на /master)
// ---------------------------------------------------------------------------

/**
 * `POST /api/master-actions/find-passport-by-code`.
 *
 * Поиск паспорта по произвольному коду — поддерживаются те же форматы,
 * что и у `POST /api/passports/by-code`:
 *   - QR `passport:<id>` (см. ADR-0008);
 *   - человекочитаемый номер `P-YYYYMMDD-NNNN`;
 *   - голый id (на случай, когда код уже распарсен на клиенте).
 *
 * Используется кнопкой «Сканировать паспорт» на `/master`: мастер
 * сканирует ЛЮБОЙ паспорт (не только тот, что числится за «вызвавшим»
 * сотрудником) и получает тот же набор действий, что и в карточке
 * вызова — снять с сотрудника, передать, вернуть в ячейку, назначить
 * операцию маршрута.
 */
export const FindMasterPassportByCodeSchema = z.object({
  code: z.string().trim().min(1).max(200),
});
export type FindMasterPassportByCodeDto = z.infer<
  typeof FindMasterPassportByCodeSchema
>;

/**
 * Ответ `POST /api/master-actions/find-passport-by-code`.
 *
 * `passport` — тот же `MasterCallPassportDto`, что отдаётся в
 * `currentPassports` карточки вызова, чтобы UI мог переиспользовать
 * `PassportActionsSheet` без преобразований. `ownerFullName` —
 * подсказка для заголовка sheet'а: ФИО сотрудника, на котором паспорт
 * сейчас числится; `null`, если паспорт «в воздухе» (нет
 * `currentEmployeeId`).
 */
export interface FindMasterPassportByCodeResultDto {
  passport: MasterCallPassportDto;
  ownerFullName: string | null;
}
