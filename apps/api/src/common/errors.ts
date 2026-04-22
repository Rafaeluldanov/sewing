import { ConflictException, HttpException, HttpStatus } from '@nestjs/common';

/**
 * Бизнес-ошибки (см. `docs/api.md §13`).
 *
 * Формат ответа совпадает с принятым по проекту:
 *   { statusCode, message, code }
 */
export class BusinessException extends HttpException {
  constructor(code: string, message: string, status: HttpStatus) {
    super({ statusCode: status, message, code }, status);
  }
}

export class OrderLockedException extends ConflictException {
  constructor(message = 'Нельзя менять план у заказа в IN_PRODUCTION') {
    super({ statusCode: 409, message, code: 'ORDER_LOCKED' });
  }
}

export class OrderInvalidTransitionException extends BusinessException {
  constructor(message: string) {
    super('ORDER_INVALID_TRANSITION', message, HttpStatus.CONFLICT);
  }
}

// ---------------------------------------------------------------------------
// Passports / Cells (Шаг 5)
// ---------------------------------------------------------------------------

export class PassportOrderNotInProductionException extends BusinessException {
  constructor() {
    super(
      'ORDER_NOT_IN_PRODUCTION',
      'Выпуск паспорта разрешён только для заказа в статусе IN_PRODUCTION',
      HttpStatus.CONFLICT,
    );
  }
}

export class PassportSizeNotInOrderException extends BusinessException {
  constructor() {
    super(
      'SIZE_NOT_IN_ORDER',
      'Размер не входит в данный заказ',
      HttpStatus.BAD_REQUEST,
    );
  }
}

export class PassportQtyExceedsRemainingException extends BusinessException {
  constructor(remaining: number) {
    super(
      'QTY_EXCEEDS_REMAINING_PLAN',
      `Количество в паспорте превышает остаток плана по размеру (доступно ${remaining})`,
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
}

export class PassportAlreadyPlacedException extends BusinessException {
  constructor(cellCode: string) {
    super(
      'PASSPORT_ALREADY_PLACED',
      `Паспорт уже размещён в ячейке ${cellCode}. Перемещение между ячейками появится на следующих шагах.`,
      HttpStatus.CONFLICT,
    );
  }
}

export class PassportNotPlaceableException extends BusinessException {
  constructor() {
    super(
      'PASSPORT_NOT_PLACEABLE',
      'Размещать в ячейке можно только паспорт в статусе CREATED',
      HttpStatus.CONFLICT,
    );
  }
}

export class CellNotFoundException extends BusinessException {
  constructor() {
    super('CELL_NOT_FOUND', 'Ячейка не найдена', HttpStatus.NOT_FOUND);
  }
}

export class CellInactiveException extends BusinessException {
  constructor() {
    super('CELL_INACTIVE', 'Ячейка деактивирована', HttpStatus.CONFLICT);
  }
}

// ---------------------------------------------------------------------------
// Warehouses (управленческая группировка ячеек)
// ---------------------------------------------------------------------------

export class WarehouseNotFoundException extends BusinessException {
  constructor() {
    super('WAREHOUSE_NOT_FOUND', 'Склад не найден', HttpStatus.NOT_FOUND);
  }
}

export class WarehouseNameTakenException extends BusinessException {
  constructor() {
    super(
      'WAREHOUSE_NAME_TAKEN',
      'Склад с таким названием уже существует',
      HttpStatus.CONFLICT,
    );
  }
}

export class WarehouseCodeTakenException extends BusinessException {
  constructor() {
    super(
      'WAREHOUSE_CODE_TAKEN',
      'Склад с таким кодом уже существует',
      HttpStatus.CONFLICT,
    );
  }
}

/**
 * Глобально уникальный код линии (`WarehouseLine.code`) уже занят
 * другой линией. Срабатывает при `POST /api/warehouses/:id/lines`.
 */
export class WarehouseLineCodeTakenException extends BusinessException {
  constructor(code: string) {
    super(
      'WAREHOUSE_LINE_CODE_TAKEN',
      `Линия с кодом «${code}» уже существует`,
      HttpStatus.CONFLICT,
    );
  }
}

/**
 * Хотя бы один из планируемых кодов ячеек (`${lineCode}${index}`) уже
 * занят существующей ячейкой. Транзакция откатывается целиком —
 * частичных линий не остаётся.
 */
export class WarehouseLineCellCodeTakenException extends BusinessException {
  constructor(takenCodes: string[]) {
    const sample = takenCodes.slice(0, 5).join(', ');
    super(
      'WAREHOUSE_LINE_CELL_CODE_TAKEN',
      `Уже существуют ячейки с такими кодами: ${sample}${
        takenCodes.length > 5 ? '…' : ''
      }. Выберите другой код линии.`,
      HttpStatus.CONFLICT,
    );
  }
}

/**
 * `POST /api/warehouses/:id/print-cells`: на складе нет ни одной
 * активной ячейки, печатать нечего. UI этот случай отдельно обрабатывает
 * (кнопка disabled + empty-state в окне настройки печати), но мы
 * валидируем и на сервере, чтобы не положить в очередь принтера 0
 * заданий молча.
 */
export class WarehouseNoCellsToPrintException extends BusinessException {
  constructor() {
    super(
      'WAREHOUSE_NO_CELLS_TO_PRINT',
      'На складе нет активных ячеек для печати',
      HttpStatus.CONFLICT,
    );
  }
}

// ---------------------------------------------------------------------------
// Shifts / work (Шаг 6)
// ---------------------------------------------------------------------------

export class EmployeeNotFoundException extends BusinessException {
  constructor() {
    super('EMPLOYEE_NOT_FOUND', 'Сотрудник не найден', HttpStatus.NOT_FOUND);
  }
}

export class EmployeeInactiveException extends BusinessException {
  constructor() {
    super(
      'EMPLOYEE_INACTIVE',
      'Сотрудник деактивирован',
      HttpStatus.CONFLICT,
    );
  }
}

export class EquipmentNotFoundException extends BusinessException {
  constructor() {
    super('EQUIPMENT_NOT_FOUND', 'Оборудование не найдено', HttpStatus.NOT_FOUND);
  }
}

export class EquipmentInactiveException extends BusinessException {
  constructor() {
    super(
      'EQUIPMENT_INACTIVE',
      'Оборудование деактивировано',
      HttpStatus.CONFLICT,
    );
  }
}

/**
 * Дубликат `Equipment.code`. Уникальность гарантирована БД, но мы
 * перехватываем P2002 в `EquipmentService` и отдаём бизнес-ошибку
 * с понятным текстом и стабильным `code`, чтобы UI мог подсветить
 * именно поле «Код» (или подсказать, что автогенерация попала в
 * существующее значение — подсказать сменить имя/код вручную).
 */
export class EquipmentCodeTakenException extends BusinessException {
  constructor() {
    super(
      'EQUIPMENT_CODE_TAKEN',
      'Оборудование с таким кодом уже существует',
      HttpStatus.CONFLICT,
    );
  }
}

export class OperationNotFoundException extends BusinessException {
  constructor() {
    super('OPERATION_NOT_FOUND', 'Операция не найдена', HttpStatus.NOT_FOUND);
  }
}

export class OperationInactiveException extends BusinessException {
  constructor() {
    super(
      'OPERATION_INACTIVE',
      'Операция деактивирована',
      HttpStatus.CONFLICT,
    );
  }
}

// ---------------------------------------------------------------------------
// Operations management (управленческий блок «Операции»)
// ---------------------------------------------------------------------------

/**
 * Дубликат `Operation.code`. Уникальность гарантирована БД, но мы
 * перехватываем P2002 в `OperationsService` и отдаём бизнес-ошибку
 * с понятным текстом и стабильным `code`, чтобы UI мог подсветить
 * именно поле «Код».
 */
export class OperationCodeTakenException extends BusinessException {
  constructor() {
    super(
      'OPERATION_CODE_TAKEN',
      'Операция с таким кодом уже существует',
      HttpStatus.CONFLICT,
    );
  }
}

/**
 * Размер из `ratesBySize` не существует в справочнике `Size`. Защита
 * от подмены id — отдельная бизнес-ошибка вместо общего 500.
 */
export class OperationRateSizeNotFoundException extends BusinessException {
  constructor(sizeId: string) {
    super(
      'OPERATION_RATE_SIZE_NOT_FOUND',
      `Размер ${sizeId} не найден в справочнике`,
      HttpStatus.BAD_REQUEST,
    );
  }
}

/**
 * В `ratesBySize` дважды передан один и тот же `sizeId`. Уникальность
 * `(operationId, sizeId)` гарантирована БД, но удобнее отдать понятную
 * 400, чем ждать P2002.
 */
export class OperationRateDuplicateSizeException extends BusinessException {
  constructor(sizeId: string) {
    super(
      'OPERATION_RATE_DUPLICATE_SIZE',
      `Размер передан дважды (${sizeId})`,
      HttpStatus.BAD_REQUEST,
    );
  }
}

/**
 * Для `pricingMode = BY_SIZE` для конкретного размера не задана ставка.
 * Бросается `OperationsService.resolveRate` и/или `EarningsService`,
 * когда сдельную ставку нужно посчитать, но управление операцией
 * её не содержит. Сообщение совместимо по смыслу с
 * `PIECE_RATE_NOT_FOUND` (старый код), но кодом ошибки отличается —
 * чтобы было видно, что источник истины уже новый.
 */
export class OperationRateMissingException extends BusinessException {
  constructor(operationCode: string, sizeCode: string) {
    super(
      'OPERATION_RATE_MISSING',
      `Нет ставки для операции ${operationCode} и размера ${sizeCode}. ` +
        `Заполните ставки в /admin/operations.`,
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
}

export class ShiftAlreadyActiveException extends BusinessException {
  constructor() {
    super(
      'SHIFT_ALREADY_ACTIVE',
      'У сотрудника уже есть активная смена. Завершите текущую смену перед началом новой.',
      HttpStatus.CONFLICT,
    );
  }
}

export class ShiftNotActiveException extends BusinessException {
  constructor() {
    super(
      'SHIFT_NOT_ACTIVE',
      'У сотрудника нет активной смены',
      HttpStatus.CONFLICT,
    );
  }
}

/**
 * Любая работа с паспортами на Шаге 6 требует активной смены
 * (см. `docs/flows.md §F8`).
 */
export class ShiftSessionRequiredException extends BusinessException {
  constructor() {
    super(
      'SHIFT_SESSION_REQUIRED',
      'Нужна активная смена: отсканируйте оборудование и выберите операцию.',
      HttpStatus.CONFLICT,
    );
  }
}

export class PassportNotInCellException extends BusinessException {
  constructor() {
    super(
      'PASSPORT_NOT_IN_CELL',
      'Паспорт ещё не размещён в ячейке — получать нечего.',
      HttpStatus.CONFLICT,
    );
  }
}

export class PassportAlreadyIssuedException extends BusinessException {
  constructor() {
    super(
      'PASSPORT_ALREADY_ISSUED',
      'Паспорт уже выдан сотруднику.',
      HttpStatus.CONFLICT,
    );
  }
}

export class PassportAlreadyPackedException extends BusinessException {
  constructor() {
    super(
      'PASSPORT_ALREADY_PACKED',
      'Паспорт уже упакован — сканирование невозможно.',
      HttpStatus.CONFLICT,
    );
  }
}

export class PassportCancelledException extends BusinessException {
  constructor() {
    super(
      'PASSPORT_CANCELLED',
      'Паспорт отменён — действие невозможно.',
      HttpStatus.CONFLICT,
    );
  }
}

/**
 * Швея пытается завершить операцию по чужому паспорту.
 * Проверка `passport.currentEmployeeId = me`
 * (см. `POST /api/passports/:id/complete-operation`).
 */
export class PassportNotYoursException extends BusinessException {
  constructor() {
    super(
      'PASSPORT_NOT_YOURS',
      'Этот паспорт закреплён за другим сотрудником.',
      HttpStatus.CONFLICT,
    );
  }
}

/**
 * Попытка завершить операцию по паспорту, который ещё не в работе
 * (например, только что создан и лежит в ячейке, или уже упакован /
 * отменён). Проверка `passport.status = IN_PROGRESS`.
 */
export class PassportNotInProgressException extends BusinessException {
  constructor() {
    super(
      'PASSPORT_NOT_IN_PROGRESS',
      'Паспорт не в работе — завершать нечего.',
      HttpStatus.CONFLICT,
    );
  }
}

// ---------------------------------------------------------------------------
// QC / defects (Шаг 7)
// ---------------------------------------------------------------------------

export class DefectTypeNotFoundException extends BusinessException {
  constructor() {
    super(
      'DEFECT_TYPE_NOT_FOUND',
      'Вид брака не найден',
      HttpStatus.NOT_FOUND,
    );
  }
}

export class DefectTypeInactiveException extends BusinessException {
  constructor() {
    super(
      'DEFECT_TYPE_INACTIVE',
      'Вид брака деактивирован',
      HttpStatus.CONFLICT,
    );
  }
}

/**
 * Паспорт ещё не доступен ОТК (см. `docs/flows.md §F5`).
 *
 * На Шаге 7 ОТК работает только с паспортами в статусе `IN_PROGRESS`:
 * раскрой и размещение прошли, паспорт уже был выдан швее или
 * отсканирован хотя бы на одной операции, но не упакован/отменён.
 */
export class PassportNotQcableException extends BusinessException {
  constructor() {
    super(
      'PASSPORT_NOT_QCABLE',
      'Паспорт ещё не в работе или уже завершён — фиксировать брак нельзя.',
      HttpStatus.CONFLICT,
    );
  }
}

/**
 * Сумма брака превысила бы `qtyCut`. На MVP `qtyGood = qtyCut − qtyDefect`
 * не может стать отрицательным (см. `docs/domain.md §13`).
 */
export class DefectExceedsRemainingException extends BusinessException {
  constructor(remaining: number) {
    super(
      'DEFECT_EXCEEDS_REMAINING',
      `Зафиксировать столько брака нельзя: остаток годных по паспорту — ${remaining} шт.`,
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
}

// ---------------------------------------------------------------------------
// WTO / ironing (role-terminal)
// ---------------------------------------------------------------------------

/**
 * Сотрудник ВТО пытается принять паспорт, который ещё не прошёл ОТК.
 *
 * Источник истины — `PassportEvent(QC_PASSED)`: по контракту F5 ОТК
 * нажимает «Проверка выполнена», и backend пишет соответствующее
 * событие. Если такого события нет — паспорт ещё не считается
 * проверенным, и переходить на ВТО нельзя.
 *
 * Заворачиваем именно на backend (`PassportsService.scanOnOperation`,
 * `WtoService.acceptOnWto`), а не только в UI: WTO-flow scan-driven, а
 * `OPERATION_SCAN` есть и у сменного `/api/passports/:id/scan`,
 * который мог бы обойти UI-проверку.
 */
export class PassportNotQcPassedException extends BusinessException {
  constructor() {
    super(
      'PASSPORT_NOT_QC_PASSED',
      'Паспорт ещё не прошёл ОТК — принимать на ВТО нельзя.',
      HttpStatus.CONFLICT,
    );
  }
}

/**
 * Паспорт не доступен ВТО (см. `docs/flows.md §F6`).
 *
 * ВТО работает только с «живыми» паспортами в статусе `IN_PROGRESS`:
 * раскрой и размещение прошли, паспорт уже проходил ОТК и не
 * упакован/отменён. По аналогии с `PASSPORT_NOT_QCABLE` для ОТК.
 */
export class PassportNotWtoableException extends BusinessException {
  constructor() {
    super(
      'PASSPORT_NOT_WTOABLE',
      'Паспорт ещё не в работе или уже завершён — принимать на ВТО нельзя.',
      HttpStatus.CONFLICT,
    );
  }
}

// ---------------------------------------------------------------------------
// Packing (Шаг 8)
// ---------------------------------------------------------------------------

export class BoxNotFoundException extends BusinessException {
  constructor() {
    super('BOX_NOT_FOUND', 'Коробка не найдена', HttpStatus.NOT_FOUND);
  }
}

export class BoxClosedException extends BusinessException {
  constructor() {
    super(
      'BOX_CLOSED',
      'Коробка уже закрыта — добавлять паспорта нельзя.',
      HttpStatus.CONFLICT,
    );
  }
}

export class BoxEmptyCloseException extends BusinessException {
  constructor() {
    super(
      'BOX_EMPTY',
      'Нельзя закрыть пустую коробку.',
      HttpStatus.CONFLICT,
    );
  }
}

export class BoxCapacityExceededException extends BusinessException {
  constructor(remaining: number) {
    super(
      'BOX_CAPACITY_EXCEEDED',
      `В коробке осталось ${remaining} шт. до лимита — паспорт не помещается.`,
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
}

export class PassportNotPackableException extends BusinessException {
  constructor() {
    super(
      'PASSPORT_NOT_PACKABLE',
      'Паспорт ещё не готов к упаковке: нужен статус IN_PROGRESS и qtyGood > 0.',
      HttpStatus.CONFLICT,
    );
  }
}

export class BoxHomogeneityViolatedException extends BusinessException {
  constructor() {
    super(
      'BOX_HOMOGENEITY_VIOLATED',
      'Коробка должна быть однородной по изделию, цвету и размеру.',
      HttpStatus.CONFLICT,
    );
  }
}

/**
 * Сотрудник пытается работать с упаковкой, но активная смена не на
 * операции с категорией PACKING. На MVP это soft-validation: блокируем
 * только мутации (создание коробки, добавление, закрытие). Просмотр
 * списка коробок открыт всем.
 */
export class PackingShiftRequiredException extends BusinessException {
  constructor() {
    super(
      'PACKING_SHIFT_REQUIRED',
      'Нужна активная смена на операции категории «Упаковка».',
      HttpStatus.CONFLICT,
    );
  }
}

// ---------------------------------------------------------------------------
// Earnings / payroll (Шаг 9)
// ---------------------------------------------------------------------------

/**
 * Не нашли действующей `PieceRate` для пары `(operationId, sizeId)`
 * (с учётом `productId = null` — общая ставка). На MVP это явная
 * бизнес-ошибка, а не silent skip — иначе доверие к зарплатной логике
 * сломается при первой же забытой расценке. См. ADR-0005 §«Ставка»
 * и `docs/api.md §10`.
 */
export class PieceRateNotFoundException extends BusinessException {
  constructor(operationCode: string, sizeCode: string) {
    super(
      'PIECE_RATE_NOT_FOUND',
      `Нет действующей расценки для операции ${operationCode} и размера ${sizeCode}. Заполните PieceRate.`,
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
}

/** На MVP не выбрасывается из API, но зарезервирован под детальный lookup. */
export class EarningNotFoundException extends BusinessException {
  constructor() {
    super('EARNING_NOT_FOUND', 'Начисление не найдено', HttpStatus.NOT_FOUND);
  }
}

// ---------------------------------------------------------------------------
// Salary entries / employees (ADR-0021, post-Шаг 18)
// ---------------------------------------------------------------------------

/**
 * Запись `SalaryEntry` не найдена. Бросается из ручного редактирования
 * `PATCH /api/salary/:id`, когда менеджер пытается обновить
 * несуществующий id (например, запись успели удалить параллельным
 * процессом или id из старой вкладки).
 */
export class SalaryEntryNotFoundException extends BusinessException {
  constructor() {
    super(
      'SALARY_ENTRY_NOT_FOUND',
      'Окладное начисление не найдено',
      HttpStatus.NOT_FOUND,
    );
  }
}

/**
 * Менеджер запросил `reset = true` для `SalaryEntry`, но у сотрудника
 * не задана `salaryPerShift`. Возвращать к чему — непонятно: нужно
 * сначала проставить ставку в карточке сотрудника.
 */
export class SalaryReentryWithoutRateException extends BusinessException {
  constructor() {
    super(
      'SALARY_RATE_MISSING',
      'У сотрудника не задана ставка за смену — сначала укажите её в карточке.',
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
}

/**
 * Сотруднику пытаются выставить `compensationType in (SALARY, MIXED)`
 * без `salaryPerShift`. Инвариант ADR-0021 — без ставки оклад
 * считать нечем.
 */
export class EmployeeSalaryRateRequiredException extends BusinessException {
  constructor() {
    super(
      'EMPLOYEE_SALARY_RATE_REQUIRED',
      'Для типа SALARY/MIXED обязательна ставка за смену.',
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
}

// ---------------------------------------------------------------------------
// Production routes (soft-route MVP)
// ---------------------------------------------------------------------------

/**
 * Шаблон маршрута не найден — отдаётся `/admin/routes/:id`,
 * `OrdersService` (при выборе несуществующего `routeTemplateId`),
 * админскими PATCH/DELETE.
 */
export class RouteTemplateNotFoundException extends BusinessException {
  constructor() {
    super(
      'ROUTE_TEMPLATE_NOT_FOUND',
      'Шаблон маршрута не найден',
      HttpStatus.NOT_FOUND,
    );
  }
}

/**
 * Дубликат `RouteTemplate.code`. Уникальность гарантирована БД, но
 * перехватываем P2002 в `RoutesService` и отдаём бизнес-ошибку с
 * понятным текстом — UI подсветит поле «Код».
 */
export class RouteTemplateCodeTakenException extends BusinessException {
  constructor() {
    super(
      'ROUTE_TEMPLATE_CODE_TAKEN',
      'Шаблон маршрута с таким кодом уже существует',
      HttpStatus.CONFLICT,
    );
  }
}

/**
 * Менеджер пытается выбрать неактивный шаблон при создании/обновлении
 * заказа. На MVP это soft-error на API-уровне (UI не показывает
 * неактивные в селекте), но мы блокируем явный bypass через прямой
 * POST/PATCH с произвольным `routeTemplateId`.
 */
export class RouteTemplateInactiveException extends BusinessException {
  constructor() {
    super(
      'ROUTE_TEMPLATE_INACTIVE',
      'Шаблон маршрута деактивирован — выбрать его нельзя.',
      HttpStatus.CONFLICT,
    );
  }
}

/**
 * `routeTemplateId` уже зафиксирован в snapshot (`OrderRouteStep[]`):
 * заказ запущен, маршрут «застыл», менять привязку нельзя. Это правило
 * не ломает MVP soft-route — оно только запрещает поздно «переключить»
 * заказ на другой маршрут (ради будущего предсказуемого пересчёта KPI).
 */
export class OrderRouteAlreadyStartedException extends BusinessException {
  constructor() {
    super(
      'ORDER_ROUTE_ALREADY_STARTED',
      'У заказа уже зафиксирован snapshot маршрута — переназначить шаблон нельзя.',
      HttpStatus.CONFLICT,
    );
  }
}

// ---------------------------------------------------------------------------
// Tech cards (MVP, ADR-0022)
// ---------------------------------------------------------------------------

/**
 * Шаблон техкарты не найден — отдаётся `/admin/tech-cards/:id`,
 * `OrdersService` (при выборе несуществующего `techCardId`),
 * админскими PATCH/DELETE.
 */
export class TechCardNotFoundException extends BusinessException {
  constructor() {
    super(
      'TECH_CARD_NOT_FOUND',
      'Техкарта не найдена',
      HttpStatus.NOT_FOUND,
    );
  }
}

/**
 * Дубликат `TechCardTemplate.code`. Уникальность гарантирована БД, но
 * перехватываем P2002 в `TechCardsService` и отдаём бизнес-ошибку с
 * понятным текстом — UI подсветит поле «Код».
 */
export class TechCardCodeTakenException extends BusinessException {
  constructor() {
    super(
      'TECH_CARD_CODE_TAKEN',
      'Техкарта с таким кодом уже существует',
      HttpStatus.CONFLICT,
    );
  }
}

/**
 * Менеджер пытается выбрать неактивную техкарту при создании/обновлении
 * заказа. На MVP это soft-error на API-уровне (UI не показывает
 * неактивные в селекте), но мы блокируем явный bypass через прямой
 * POST/PATCH с произвольным `techCardId`.
 */
export class TechCardInactiveException extends BusinessException {
  constructor() {
    super(
      'TECH_CARD_INACTIVE',
      'Техкарта деактивирована — выбрать её нельзя.',
      HttpStatus.CONFLICT,
    );
  }
}

/**
 * `techCardId` уже зафиксирован в snapshot-ах (`materialRequirements` /
 * `outsourceRequirements`): заказ запущен, техкарта «застыла», менять
 * привязку нельзя. Аналог `OrderRouteAlreadyStartedException`.
 */
export class OrderTechCardAlreadyStartedException extends BusinessException {
  constructor() {
    super(
      'ORDER_TECH_CARD_ALREADY_STARTED',
      'У заказа уже зафиксирован snapshot техкарты — переназначить шаблон нельзя.',
      HttpStatus.CONFLICT,
    );
  }
}

// ---------------------------------------------------------------------------
// Auth (MVP 1.1, ADR-0014)
// ---------------------------------------------------------------------------

export class InvalidCredentialsException extends BusinessException {
  constructor() {
    super(
      'INVALID_CREDENTIALS',
      'Неверный логин или пароль.',
      HttpStatus.UNAUTHORIZED,
    );
  }
}

export class UnauthenticatedException extends BusinessException {
  constructor() {
    super(
      'UNAUTHENTICATED',
      'Нужно войти в систему.',
      HttpStatus.UNAUTHORIZED,
    );
  }
}

export class ForbiddenRoleException extends BusinessException {
  constructor() {
    super(
      'FORBIDDEN_ROLE',
      'У вашей роли нет доступа к этому действию.',
      HttpStatus.FORBIDDEN,
    );
  }
}

// ---------------------------------------------------------------------------
// Cutting closure requests (ADR-0018)
// ---------------------------------------------------------------------------

/**
 * Размерная строка `(orderId, productId, sizeId)` не существует в
 * заказе — заявка на закрытие раскроя бессмысленна.
 */
export class CuttingClosureSizeNotInOrderException extends BusinessException {
  constructor() {
    super(
      'CUTTING_CLOSURE_SIZE_NOT_IN_ORDER',
      'По этому заказу нет такой размерной строки — закрывать нечего.',
      HttpStatus.BAD_REQUEST,
    );
  }
}

/**
 * По строке уже есть открытая заявка (`status = REQUESTED`). Двух
 * одновременно активных заявок не бывает (см. partial unique index
 * `cutting_closure_request_active_uniq`).
 */
export class CuttingClosureAlreadyRequestedException extends BusinessException {
  constructor() {
    super(
      'CUTTING_CLOSURE_ALREADY_REQUESTED',
      'Заявка на закрытие раскроя по этому размеру уже отправлена мастеру.',
      HttpStatus.CONFLICT,
    );
  }
}

/**
 * По строке уже есть подтверждённая заявка (`status = APPROVED`).
 * Раскрой считается закрытым — повторно подавать заявку нельзя.
 */
export class CuttingClosureAlreadyApprovedException extends BusinessException {
  constructor() {
    super(
      'CUTTING_CLOSURE_ALREADY_APPROVED',
      'Раскрой по этому размеру уже закрыт мастером.',
      HttpStatus.CONFLICT,
    );
  }
}

/**
 * Заявку нельзя подать на завершённый/отменённый заказ — некому
 * выпускать паспорта в любом случае. Возвращаем ту же бизнес-ошибку,
 * что для выпуска паспорта, чтобы на UI был один и тот же текст.
 */
export class CuttingClosureOrderNotInProductionException extends BusinessException {
  constructor() {
    super(
      'CUTTING_CLOSURE_ORDER_NOT_IN_PRODUCTION',
      'Заявку на закрытие раскроя можно подать только по заказу в статусе IN_PRODUCTION.',
      HttpStatus.CONFLICT,
    );
  }
}

export class CuttingClosureRequestNotFoundException extends BusinessException {
  constructor() {
    super(
      'CUTTING_CLOSURE_REQUEST_NOT_FOUND',
      'Заявка на закрытие раскроя не найдена.',
      HttpStatus.NOT_FOUND,
    );
  }
}

/**
 * Approve/reject допустим только для `REQUESTED`. Терминальные
 * статусы (`APPROVED`/`REJECTED`) уже зафиксированы — повторное
 * решение не имеет смысла.
 */
export class CuttingClosureRequestNotPendingException extends BusinessException {
  constructor() {
    super(
      'CUTTING_CLOSURE_REQUEST_NOT_PENDING',
      'Заявка уже рассмотрена — решение поменять нельзя.',
      HttpStatus.CONFLICT,
    );
  }
}

/**
 * Backend enforcement при выпуске паспорта: по строке есть
 * подтверждённая заявка на закрытие раскроя. UI обязан скрывать
 * кнопку «Выпустить паспорт», но и без этого мы не пускаем создание.
 */
export class PassportCuttingClosedException extends BusinessException {
  constructor() {
    super(
      'CUTTING_CLOSED',
      'Раскрой по этому размеру закрыт мастером — выпускать паспорта больше нельзя.',
      HttpStatus.CONFLICT,
    );
  }
}
