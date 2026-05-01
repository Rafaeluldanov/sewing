/**
 * Admin / monitoring контракты (Шаг 12 — Pilot Rollout / Bugfix Sprint).
 *
 * Лёгкий операционный обзор для начальника цеха. Без аналитики, без
 * долгосрочных трендов — только «что прямо сейчас в цехе?».
 *
 * Источник истины — `docs/api.md §11a`, `docs/screens.md §10`,
 * `docs/pilot/rollout-plan.md §6` (мониторинг по ходу пилота).
 *
 * Контракт:
 *   - `GET /api/admin/overview` (роли SHOP_MANAGER, ADMIN);
 *   - читает живые данные одним запросом, ничего не пишет;
 *   - не использует поллинг — UI обновляется по кнопке Refresh.
 */

export interface AdminOverviewShiftDto {
  shiftId: string;
  startedAt: string;
  employeeId: string;
  employeeName: string;
  employeeRole: string;
  operationCode: string;
  operationName: string;
  equipmentCode: string;
  equipmentName: string;
}

export interface AdminOverviewBoxDto {
  boxId: string;
  number: string;
  totalQty: number;
  maxQty: number;
  itemsCount: number;
  /**
   * Сводка по содержимому — берётся из первого `BoxItem` (коробка
   * однородная по продукту/цвету/размеру). `null`, если коробка пустая.
   */
  productName: string | null;
  color: string | null;
  sizeCode: string | null;
  createdAt: string;
}

export interface AdminOverviewPassportInWorkDto {
  passportId: string;
  number: string;
  status: 'IN_PROGRESS' | 'CREATED';
  qtyCut: number;
  qtyGood: number;
  productName: string;
  color: string;
  sizeCode: string;
  /** Где сейчас паспорт — у сотрудника, в ячейке, или ни там ни там. */
  location: 'EMPLOYEE' | 'CELL' | 'UNASSIGNED';
  currentEmployeeName: string | null;
  currentCellCode: string | null;
  currentOperationCode: string | null;
  currentOperationName: string | null;
  updatedAt: string;
}

export interface AdminOverviewCountersDto {
  activeShifts: number;
  openBoxes: number;
  passportsInProgress: number;
  passportsInCells: number;
  passportsCreatedToday: number;
  /** События `passport.*` за последние 24 часа — индикатор «жизни». */
  eventsLast24h: number;
}

export interface AdminOverviewDto {
  /** Когда сервер сформировал ответ (ISO). */
  updatedAt: string;
  counters: AdminOverviewCountersDto;
  /** До 50 активных смен (на пилоте больше быть не должно). */
  shifts: AdminOverviewShiftDto[];
  /** До 50 открытых коробок. */
  openBoxes: AdminOverviewBoxDto[];
  /** До 100 живых паспортов (`IN_PROGRESS` + `CREATED` в ячейках). */
  passports: AdminOverviewPassportInWorkDto[];
}
