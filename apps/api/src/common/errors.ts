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

// ---------------------------------------------------------------------------
// Правка заказа В ПРОИЗВОДСТВЕ (order amendments, фича
// FEATURE_ORDER_AMENDMENTS). Второй ярус редактируемости поверх заморозки
// плана (ADR-0006): аддитивные, forward-only правки в `IN_PRODUCTION`.
// ---------------------------------------------------------------------------

/**
 * Правка (напр. количества по размерам) запрошена для заказа не в
 * производстве. Amendment-путь работает только в `IN_PRODUCTION`: в
 * `DRAFT`/`CALCULATION` есть обычная свободная правка, в `DONE`/`CANCELLED`
 * менять нечего. Отдельный код — чтобы UI показал адресный текст.
 */
export class OrderNotAmendableException extends ConflictException {
  constructor(
    message = 'Править заказ в этом режиме можно только когда он в производстве.',
  ) {
    super({ statusCode: 409, message, code: 'ORDER_NOT_AMENDABLE' });
  }
}

/**
 * Попытка опустить плановый тираж размера ниже уже раскроенного
 * (Σ `Passport.qtyCut`). Раскрой необратим, поэтому план не может стать
 * меньше факта кроя — иначе поехали бы остатки склада и сдельная ЗП.
 */
export class AmendmentBelowCutException extends ConflictException {
  constructor(message: string) {
    super({ statusCode: 409, message, code: 'AMENDMENT_BELOW_CUT' });
  }
}

/**
 * Правка количества запрошена у заказа с ≥2 расцветками. В производстве
 * агрегатная правка размера неоднозначна (в какой цвет отнести дельту),
 * а правка per-цвет — следующая фаза фичи. Пока отклоняем адресной 409.
 */
export class AmendmentMultiVariantUnsupportedException extends ConflictException {
  constructor(
    message = 'У заказа несколько расцветок — правка количества per-цвет пока не поддержана.',
  ) {
    super({
      statusCode: 409,
      message,
      code: 'AMENDMENT_MULTIVARIANT_UNSUPPORTED',
    });
  }
}

/**
 * Правка размерности (ФАЗА 2): попытка добавить размер, который уже есть
 * в плане заказа. Для изменения его тиража — правка количества, не
 * размерности.
 */
export class AmendmentSizeAlreadyInOrderException extends ConflictException {
  constructor(message: string) {
    super({ statusCode: 409, message, code: 'AMENDMENT_SIZE_ALREADY_IN_ORDER' });
  }
}

/**
 * Правка размерности: попытка убрать размер, по которому уже есть работа
 * (раскрой/настилы). Раскрой необратим — размер удалить нельзя.
 */
export class AmendmentSizeHasWorkException extends ConflictException {
  constructor(message: string) {
    super({ statusCode: 409, message, code: 'AMENDMENT_SIZE_HAS_WORK' });
  }
}

/**
 * Правка маршрута (ФАЗА 3): добавляемая операция уже есть в маршруте
 * заказа. Дубли операции ломают доску/подстановки (дедуп по operationId).
 */
export class AmendmentOperationAlreadyInRouteException extends ConflictException {
  constructor(message: string) {
    super({
      statusCode: 409,
      message,
      code: 'AMENDMENT_OPERATION_ALREADY_IN_ROUTE',
    });
  }
}

/**
 * Правка маршрута: попытка вставить операцию НЕ впереди фронта
 * производства (какой-то паспорт уже прошёл эту позицию). Добавление
 * операции аддитивно — только вперёд, иначе пришлось бы возвращать уже
 * сделанную работу (это отдельный rework-флоу).
 */
export class AmendmentOperationBehindFrontierException extends ConflictException {
  constructor(message: string) {
    super({
      statusCode: 409,
      message,
      code: 'AMENDMENT_OPERATION_BEHIND_FRONTIER',
    });
  }
}

/**
 * Правка маршрута целиком (вкладка «Маршрут» drawer-а): клиент прислал
 * маршрут, у которого изменился замороженный префикс — шаги, которые
 * паспорта уже прошли или проходят прямо сейчас. Обычно это гонка: пока
 * менеджер собирал маршрут, фронт производства уехал вперёд. UI по этому
 * коду просит обновить страницу и повторить правку.
 */
export class AmendmentRouteFrontierChangedException extends ConflictException {
  constructor(message: string) {
    super({
      statusCode: 409,
      message,
      code: 'AMENDMENT_ROUTE_FRONTIER_CHANGED',
    });
  }
}

/**
 * Правка маршрута: попытка убрать шаг, по операции которого в заказе уже
 * есть выработка (`OperationEntry`). Формально шаг может стоять впереди
 * фронта (например, работу засчитали подстановкой), но удаление осиротило
 * бы сдельные начисления — отклоняем адресной 409.
 */
export class AmendmentRouteStepHasWorkException extends ConflictException {
  constructor(message: string) {
    super({
      statusCode: 409,
      message,
      code: 'AMENDMENT_ROUTE_STEP_HAS_WORK',
    });
  }
}

export class OrderInvalidTransitionException extends BusinessException {
  constructor(message: string) {
    super('ORDER_INVALID_TRANSITION', message, HttpStatus.CONFLICT);
  }
}

// ---------------------------------------------------------------------------
// Order calculation transition (этап «Расчёт»)
// ---------------------------------------------------------------------------

/**
 * Менеджер вызвал `POST /api/orders/:id/start-calculation` для заказа,
 * который не в `DRAFT` (например, уже `CALCULATION` / `IN_PRODUCTION` /
 * `DONE` / `CANCELLED`). Отдельный код выделен сознательно — общий
 * `ORDER_INVALID_TRANSITION` уже занят PATCH-переходами `start /
 * complete / cancel`, а UI кнопки «Перевести в расчёт» хочет показать
 * адресный текст «Перевести в расчёт можно только из «Черновик»».
 */
export class OrderInvalidStatusTransitionException extends BusinessException {
  constructor(message: string) {
    super(
      'ORDER_INVALID_STATUS_TRANSITION',
      message,
      HttpStatus.CONFLICT,
    );
  }
}

/**
 * Заказ в `DRAFT` без выбранного `patternItemId`: перевести в расчёт
 * нельзя — по лекалу считается площадь × плотность для AREA_DENSITY.
 * UI на форме создания/редактирования делает то же требование, но
 * прямой POST через API мы тоже отбиваем адресной 400-кой.
 */
export class OrderPatternRequiredException extends BusinessException {
  constructor() {
    super(
      'ORDER_PATTERN_REQUIRED',
      'Чтобы перевести заказ в расчёт, нужно выбрать номенклатуру / лекало.',
      HttpStatus.BAD_REQUEST,
    );
  }
}

/**
 * Заказ в `DRAFT` без выбранного `techCardId`: перевести в расчёт
 * нельзя — техкарта поставляет строки материалов и подрядных
 * размещений для расчёта (см. `WorkshopNeedsService.calculateForOrder`).
 */
export class OrderTechCardRequiredException extends BusinessException {
  constructor() {
    super(
      'ORDER_TECH_CARD_REQUIRED',
      'Чтобы перевести заказ в расчёт, нужно выбрать техкарту.',
      HttpStatus.BAD_REQUEST,
    );
  }
}

/**
 * Этап «Клиент — обязательный атрибут заказа».
 *
 * Заказ без `Order.clientId` не может уйти дальше `DRAFT`: клиент —
 * управленческий владелец заказа (себестоимость / отгрузки / балансы
 * готовой продукции ведутся по нему, см. `FinishedGoodsService`,
 * `ProductionCostV2Service`), и заказ «без клиента» ломает всю
 * управленческую аналитику ниже по потоку.
 *
 * Где бросается:
 *   - `OrdersService.startCalculation` — гейт перевода DRAFT → CALCULATION
 *     (в одном ряду с `ORDER_PATTERN_REQUIRED` / `ORDER_TECH_CARD_REQUIRED`
 *     / `ORDER_ITEMS_REQUIRED`);
 *   - `OrdersService.update` — попытка СНЯТЬ привязку (`clientId: null`)
 *     у заказа: обязательное поле нельзя очистить, только заменить.
 *
 * Сознательно НЕ бросается в `create`: `POST /api/orders` остаётся
 * backward-compatible (легаси-flow `/orders/new`, CUTTER_ASSISTANT,
 * DRAFT-заказ из КБ-задачи `ConstructorTasksService`), а требование
 * добивается формами (`required`-селект «Клиент») и этим гейтом.
 */
export class OrderClientRequiredException extends BusinessException {
  constructor(message?: string) {
    super(
      'ORDER_CLIENT_REQUIRED',
      message ?? 'Чтобы перевести заказ в расчёт, нужно выбрать клиента.',
      HttpStatus.BAD_REQUEST,
    );
  }
}

/**
 * У заказа нет ни одной размерной строки с `qtyPlan > 0` — без
 * размерной матрицы расчёт чистой потребности невозможен.
 * Эта ошибка отличается от `WORKSHOP_NEED_ORDER_ITEMS_REQUIRED` тем,
 * что бросается ДО вызова `WorkshopNeedsService` — в гарде
 * `OrdersService.startCalculation`, чтобы не открывать транзакцию
 * расчёта впустую.
 */
export class OrderItemsRequiredException extends BusinessException {
  constructor() {
    super(
      'ORDER_ITEMS_REQUIRED',
      'Чтобы перевести заказ в расчёт, заполните количество хотя бы по одному размеру.',
      HttpStatus.BAD_REQUEST,
    );
  }
}

/**
 * Расчёт потребности цеха дал число, не помещающееся в
 * `WorkshopNeed`-колонку `Decimal(14,4)` (абсолютное значение должно
 * быть < 10^10). Почти всегда это означает нереалистичный ввод:
 * слишком большой тираж (`OrderItem.qtyPlan`) или расход на изделие
 * (площадь / погонные метры / норма фурнитуры).
 *
 * Без этого гарда Prisma бросает `numeric field overflow`, который
 * `GlobalExceptionFilter` отдаёт как 500 `INTERNAL_ERROR` — менеджер
 * не понимает, что именно поправить. Сообщение формируется сервисом
 * и адресно называет проблемную позицию и число.
 */
export class WorkshopNeedCalculationOverflowException extends BusinessException {
  constructor(message: string) {
    super(
      'WORKSHOP_NEED_CALCULATION_OVERFLOW',
      message,
      HttpStatus.BAD_REQUEST,
    );
  }
}

// ---------------------------------------------------------------------------
// Корректировка материалов после просчёта (ручные строки + прочие расходы)
// ---------------------------------------------------------------------------

/**
 * Менеджер пытается добавить/править/удалить материал или прочий расход
 * на заказе в неподходящем статусе. Корректировка разрешена только в
 * `CALCULATION` / `CALCULATION_DONE` / `IN_PRODUCTION` (см.
 * `OrderMaterialCorrectionService` / `WorkshopNeedsService.createManual`).
 * В `DRAFT` состав ведётся обычным редактированием заказа, в
 * `DONE`/`CANCELLED` заказ закрыт. Сообщение формирует сервис, чтобы
 * назвать текущий статус.
 */
export class OrderMaterialCorrectionStatusException extends BusinessException {
  constructor(message: string) {
    super(
      'ORDER_MATERIAL_CORRECTION_INVALID_STATUS',
      message,
      HttpStatus.CONFLICT,
    );
  }
}

/**
 * Менеджер пытается редактировать состав (description / unit /
 * materialRole / calculatedQty) или физически удалить СИСТЕМНУЮ строку
 * потребности (`isManual = false`). Такие строки — неизменяемый snapshot
 * из техкарты; их можно только гасить через `cancel`. Менять состав
 * разрешено только у ручных строк (`isManual = true`).
 */
export class WorkshopNeedNotManualException extends BusinessException {
  constructor(
    message = 'Системную строку потребности нельзя править или удалять — её можно только отменить. Состав меняется у ручных строк.',
  ) {
    super('WORKSHOP_NEED_NOT_MANUAL', message, HttpStatus.CONFLICT);
  }
}

/** Прочий расход (`OrderExtraCost`) не найден. */
export class OrderExtraCostNotFoundException extends BusinessException {
  constructor(message = 'Прочий расход не найден') {
    super('ORDER_EXTRA_COST_NOT_FOUND', message, HttpStatus.NOT_FOUND);
  }
}

/**
 * Этап 2 «План операций на заказе» (см.
 * `docs/operation-time-norms-recon.md §11`,
 * `apps/api/src/modules/orders/order-operation-plan.service.ts`).
 *
 * Менеджер вызвал `POST /api/orders/:id/operation-plan/recalculate`
 * для заказа в неподходящем статусе. Ручной пересчёт допустим только
 * пока заказ в `DRAFT` или `CALCULATION` — то есть до фиксации
 * `OrderCostEstimate` и до запуска в производство.
 *
 * Почему именно так:
 *   - в `CALCULATION_DONE` уже зафиксирован документ себестоимости;
 *     молча менять `operationCostPlanRub` нельзя — у нас уже есть flow
 *     «Вернуть заказ на пересчёт» (`reopenCalculation`), и пересчёт
 *     операций должен идти через него, чтобы не разъехались числа в
 *     «План операций» и «Себестоимость»;
 *   - в `IN_PRODUCTION` / `DONE` план операций считается зафиксированным
 *     по контракту ADR-0006 (snapshot «как заказ ушёл в работу»);
 *   - в `CANCELLED` пересчёт бессмыслен.
 *
 * Сообщение формируется сервисом, чтобы для `CALCULATION_DONE` UI
 * мог адресно подсказать «Чтобы пересчитать операции, верните заказ
 * на просчёт».
 */
export class OrderOperationPlanRecalculateNotAllowedException extends BusinessException {
  constructor(message: string) {
    super(
      'ORDER_OPERATION_PLAN_RECALCULATE_NOT_ALLOWED',
      message,
      HttpStatus.CONFLICT,
    );
  }
}

// ---------------------------------------------------------------------------
// Order cost estimate / completeCalculation (этап «Себестоимость заказа»)
// ---------------------------------------------------------------------------

/**
 * Менеджер вызвал `POST /api/orders/:id/complete-calculation` или
 * `reopen-calculation` для заказа в неподходящем статусе:
 *   - complete: ожидаем `CALCULATION`;
 *   - reopen:   ожидаем `CALCULATION_DONE` (для MVP).
 *
 * Сообщение формируется сервисом, чтобы UI мог показать конкретный
 * текущий статус.
 */
export class OrderCalculationInvalidStatusException extends BusinessException {
  constructor(message: string) {
    super(
      'ORDER_CALCULATION_INVALID_STATUS',
      message,
      HttpStatus.CONFLICT,
    );
  }
}

/**
 * Хотя бы одна активная (`status != CANCELLED`) строка `WorkshopNeed`
 * не готова к завершению расчёта:
 *   - `purchaseQty ?? calculatedQty <= 0`;
 *   - `quotedPrice <= 0` или не указан;
 *   - `quotedCurrency` не выбрана / не из `MONEY_CURRENCIES`.
 *
 * payload содержит детали по проблемным строкам (см.
 * `OrdersService.completeCalculation`), чтобы UI мог подсветить
 * именно их.
 */
export class OrderCalculationIncompleteException extends BusinessException {
  constructor(
    message: string,
    public readonly details: ReadonlyArray<{
      needId: string;
      description: string;
      reason: string;
    }>,
  ) {
    super('ORDER_CALCULATION_INCOMPLETE', message, HttpStatus.UNPROCESSABLE_ENTITY);
  }
}

/**
 * Среди строк `WorkshopNeed` есть USD-строки, но в теле запроса
 * `usdRateRub` пустой/нулевой/не передан. Чтобы не делать тихий
 * fallback (например, `1`), отдаём отдельную 422-ку — UI просит
 * закупщика ввести курс.
 */
export class OrderCalculationUsdRateRequiredException extends BusinessException {
  constructor() {
    super(
      'ORDER_CALCULATION_USD_RATE_REQUIRED',
      'Укажите курс USD/RUB — в расчёте есть строки в долларах.',
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
}

// ---------------------------------------------------------------------------
// Order applications (этап «Нанесение на заказе покупателя»)
// ---------------------------------------------------------------------------

/**
 * Менеджер пытается изменить нанесения у заказа, чей расчёт уже
 * завершён (`CALCULATION_DONE` и дальше). Окно правки —
 * `DRAFT`/`CALCULATION` (см.
 * `ORDER_APPLICATION_EDITABLE_ORDER_STATUSES` в shared): пока расчёт
 * идёт, правка нанесений пересобирает потребность цеха, а после его
 * завершения себестоимость и потребность зафиксированы. Тот же стиль,
 * что `OrderLockedException` (409, code
 * `ORDER_APPLICATION_ORDER_LOCKED`), чтобы UI мог адресно подсказать
 * «верните заказ на пересчёт».
 */
export class OrderApplicationOrderLockedException extends ConflictException {
  constructor(
    message = 'Изменить нанесения можно, пока расчёт не завершён — в статусе «Черновик» или «Расчёт». Чтобы отредактировать после расчёта, верните заказ на пересчёт.',
  ) {
    super({
      statusCode: 409,
      message,
      code: 'ORDER_APPLICATION_ORDER_LOCKED',
    });
  }
}

/**
 * Запрошенное нанесение не существует (или было удалено вместе с
 * заказом). Не используется для PUT-replace (там удаляем по orderId
 * без выборки), но удобно держать готовый класс на будущее —
 * например, при PATCH-эндпоинте по `applicationId`.
 */
export class OrderApplicationNotFoundException extends BusinessException {
  constructor() {
    super(
      'ORDER_APPLICATION_NOT_FOUND',
      'Нанесение не найдено',
      HttpStatus.NOT_FOUND,
    );
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

export class PassportNotPlacedInCellException extends BusinessException {
  constructor() {
    super(
      'PASSPORT_NOT_PLACED_IN_CELL',
      'Сначала нужно разместить крой в ячейку. Помощник раскройщика ' +
        'размещает паспорт в ячейку — только после этого его можно ' +
        'выдать или отсканировать на операцию.',
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
// Cutter attribution (PHASE 2 STEP 3, см. `docs/api.md §13`,
// `docs/domain.md §«Cutter attribution»`).
// ---------------------------------------------------------------------------

/**
 * `POST /api/passports` пришёл от не-CUTTER (например,
 * `CUTTER_ASSISTANT` или `SHOP_MANAGER`) без `cutterId`. Раньше
 * сервис тихо подбирал учётку по `Employee.login = 'cutter'` —
 * это давало ложные начисления при любом несовпадении логина и
 * рушило payroll. PHASE 2 STEP 3 убрал fallback: атрибуция
 * раскройщика обязана быть явной (UI это уже соблюдает).
 *
 * Сценарии:
 *   - creator.role !== CUTTER и `cutterId` не передан → 400
 *     `CUTTER_REQUIRED`;
 *   - creator.role === CUTTER без `cutterId` → начисление
 *     самому creator (без ошибки).
 */
export class CutterRequiredException extends BusinessException {
  constructor() {
    super(
      'CUTTER_REQUIRED',
      'Укажите раскройщика — выберите его из списка перед выпуском паспорта.',
      HttpStatus.BAD_REQUEST,
    );
  }
}

/**
 * Переданный `cutterId` не существует в таблице `Employee` или
 * принадлежит сотруднику с ролью, отличной от `CUTTER`. Раньше
 * этот кейс попадал в лог-only «cutterFromSeed not found» — на
 * пилоте это могло привести к ошибочной атрибуции под seed-
 * учётку. PHASE 2 STEP 3 делает явный 404.
 */
export class CutterNotFoundException extends BusinessException {
  constructor() {
    super(
      'CUTTER_NOT_FOUND',
      'Раскройщик не найден или не имеет роли CUTTER.',
      HttpStatus.NOT_FOUND,
    );
  }
}

/**
 * Переданный `cutterId` есть в БД и роль `CUTTER`, но карточка
 * деактивирована (`active = false`). Начислять зарплату такому
 * сотруднику нельзя — payroll-фильтр `active = true` его всё
 * равно отфильтрует, и сдельное начисление окажется «ничьим».
 * Поэтому отбиваем 409 ещё на input-валидации.
 */
export class CutterInactiveException extends BusinessException {
  constructor() {
    super(
      'CUTTER_INACTIVE',
      'Раскройщик деактивирован — выберите активного.',
      HttpStatus.CONFLICT,
    );
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

/**
 * `:lineId` не существует или принадлежит другому складу. Срабатывает
 * на per-line ручках (`DELETE /api/warehouses/:id/lines/:lineId`,
 * `POST /api/warehouses/:id/lines/:lineId/print-cells`).
 */
export class WarehouseLineNotFoundException extends BusinessException {
  constructor() {
    super(
      'WAREHOUSE_LINE_NOT_FOUND',
      'Линия склада не найдена',
      HttpStatus.NOT_FOUND,
    );
  }
}

/**
 * `DELETE /api/warehouses/:id/lines/:lineId`: в одной из ячеек линии
 * есть содержимое (`CellContent`), активные паспорта (`Passport.currentCellId`),
 * исторические события (`PassportEvent.cellId`) или ненулевой остаток
 * (`StockBalance.qty > 0`). Удаление заблокировано — менеджер должен
 * сначала освободить ячейки.
 */
export class WarehouseLineHasContentException extends BusinessException {
  constructor(busyCodes: string[]) {
    const sample = busyCodes.slice(0, 5).join(', ');
    super(
      'WAREHOUSE_LINE_HAS_CONTENT',
      `Нельзя удалить линию: в ячейках ${sample}${
        busyCodes.length > 5 ? '…' : ''
      } есть содержимое, паспорта или остатки. Сначала освободите ячейки.`,
      HttpStatus.CONFLICT,
    );
  }
}

/**
 * `POST /api/warehouses/:id/lines/:lineId/print-cells`: в линии нет ни
 * одной активной ячейки. UI отдельно отрисует empty-state, но
 * валидируем и на backend, чтобы не положить 0 заданий в очередь принтера.
 */
export class WarehouseLineNoCellsToPrintException extends BusinessException {
  constructor() {
    super(
      'WAREHOUSE_LINE_NO_CELLS_TO_PRINT',
      'В линии нет активных ячеек для печати',
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

/**
 * Дубликат `Employee.login`. Уникальность гарантирована БД (`@unique`),
 * но мы перехватываем P2002 в `EmployeesService.create` и отдаём
 * бизнес-ошибку с понятным текстом и стабильным `code`, чтобы UI
 * мог подсветить именно поле «Логин» (см. `docs/api.md §3b`).
 */
export class EmployeeLoginTakenException extends BusinessException {
  constructor() {
    super(
      'EMPLOYEE_LOGIN_TAKEN',
      'Сотрудник с таким логином уже существует',
      HttpStatus.CONFLICT,
    );
  }
}

// ---------------------------------------------------------------------------
// Employee archive / delete (см. `docs/employee-deletion-recon.md`)
// ---------------------------------------------------------------------------

/**
 * Нельзя архивировать сотрудника: у него открыта смена / висят
 * паспорта на `currentEmployeeId` / открыт `MasterCall` /
 * `REQUESTED`-заявка на закрытие раскроя. Конкретный список блокеров
 * UI получает из `GET /api/employees/:id/blockers`; ошибка нужна
 * только для случая, когда состояние изменилось между preflight'ом и
 * `POST /archive` (race).
 */
export class EmployeeArchiveBlockedException extends BusinessException {
  constructor() {
    super(
      'EMPLOYEE_ARCHIVE_BLOCKED',
      'Сотрудник занят: завершите смену / передайте паспорта / закройте вызовы мастера и попробуйте снова.',
      HttpStatus.CONFLICT,
    );
  }
}

/**
 * Нельзя физически удалить сотрудника: у него есть начисления,
 * паспорта, смены или иная финансовая/производственная история.
 * Менеджер должен заархивировать карточку, а не удалять. Detail —
 * через `GET /api/employees/:id/blockers`.
 */
export class EmployeeHasHistoryException extends BusinessException {
  constructor() {
    super(
      'EMPLOYEE_HAS_HISTORY',
      'У сотрудника есть финансовая или производственная история — удаление невозможно. Заархивируйте карточку.',
      HttpStatus.CONFLICT,
    );
  }
}

/**
 * Менеджер пытается заархивировать или удалить сам себя. Запрещено —
 * иначе администратор останется без доступа к собственной учётке.
 */
export class EmployeeCannotModifySelfException extends BusinessException {
  constructor() {
    super(
      'EMPLOYEE_CANNOT_MODIFY_SELF',
      'Нельзя выполнить это действие с собственной учётной записью.',
      HttpStatus.FORBIDDEN,
    );
  }
}

/**
 * Архивирование / удаление последнего активного ADMIN-сотрудника —
 * запрещено: без него систему некому администрировать.
 */
export class EmployeeLastAdminException extends BusinessException {
  constructor() {
    super(
      'EMPLOYEE_LAST_ADMIN',
      'Это последний активный администратор — операция запрещена.',
      HttpStatus.CONFLICT,
    );
  }
}

/**
 * `SHOP_MANAGER` пытается выполнить административное действие
 * (archive / hard-delete) над сотрудником с ролью `ADMIN`. Управлять
 * учётками `ADMIN` может только другой `ADMIN`.
 */
export class EmployeeAdminTargetForbiddenException extends BusinessException {
  constructor() {
    super(
      'EMPLOYEE_ADMIN_TARGET_FORBIDDEN',
      'Управление учётной записью администратора доступно только администратору.',
      HttpStatus.FORBIDDEN,
    );
  }
}

/**
 * Hard-delete пользователя с ролью `DISPLAY` каскадно снесёт
 * `DisplayScreenConfig` (FK с `onDelete: Cascade`). Backend требует
 * явное подтверждение через query/body `?ackDisplayCascade=true`,
 * чтобы менеджер видел в UI чек-бокс «Я понимаю, что также удалится
 * экран».
 */
export class EmployeeDisplayCascadeAckRequiredException extends BusinessException {
  constructor() {
    super(
      'EMPLOYEE_DISPLAY_CASCADE_ACK_REQUIRED',
      'Это DISPLAY-учётка с привязанным экраном — для удаления требуется подтверждение каскадного сноса.',
      HttpStatus.CONFLICT,
    );
  }
}

/**
 * Дубликат `Employee.login` при создании display-экрана
 * (`POST /api/display-screens`). Семантически это та же P2002 на
 * `Employee.login`, что и `EMPLOYEE_LOGIN_TAKEN`, но отдельный код
 * нужен фронту: создание display-экрана — отдельный flow с двумя
 * сущностями (`Employee` + `DisplayScreenConfig`) в одной транзакции,
 * и UI хочет подсветить именно поле «Логин дисплея» на форме
 * `/admin/display-screens/new`. См. `docs/api.md §11`.
 */
export class DisplayLoginTakenException extends BusinessException {
  constructor() {
    super(
      'DISPLAY_LOGIN_TAKEN',
      'Учётная запись с таким логином уже существует — выберите другой логин для дисплея.',
      HttpStatus.CONFLICT,
    );
  }
}

// ---------------------------------------------------------------------------
// Справочник ролей (`/admin/roles`, `AppRolesService`)
// ---------------------------------------------------------------------------

export class AppRoleNotFoundException extends BusinessException {
  constructor() {
    super('APP_ROLE_NOT_FOUND', 'Роль не найдена', HttpStatus.NOT_FOUND);
  }
}

export class AppRoleCodeTakenException extends BusinessException {
  constructor(code: string) {
    super(
      'APP_ROLE_CODE_TAKEN',
      `Роль с кодом «${code}» уже существует — выберите другой код.`,
      HttpStatus.CONFLICT,
    );
  }
}

/**
 * В `inherits` указан код, которого нет в справочнике. Молча
 * проглатывать нельзя: роль выглядела бы настроенной, а прав не давала.
 */
export class AppRoleUnknownParentException extends BusinessException {
  constructor(codes: string[]) {
    super(
      'APP_ROLE_UNKNOWN_PARENT',
      `Неизвестные роли в списке наследования: ${codes.join(', ')}`,
      HttpStatus.BAD_REQUEST,
    );
  }
}

/**
 * «A наследует B, B наследует A». Раскрытие такое переживает
 * (`expandRoleCodes` защищён от циклов), но в справочнике это всегда
 * ошибка ввода — понять права такой роли невозможно.
 */
export class AppRoleInheritanceCycleException extends BusinessException {
  constructor(cycle: string[]) {
    super(
      'APP_ROLE_INHERITANCE_CYCLE',
      `Циклическое наследование ролей: ${cycle.join(' → ')}`,
      HttpStatus.BAD_REQUEST,
    );
  }
}

/**
 * Попытка изменить структурные поля системной роли или удалить её.
 * Системные коды зашиты в декораторах `@Roles(...)` и терминалах —
 * их правка ломает доступ по всему приложению.
 */
/**
 * Сотруднику назначают роль, которой нет в справочнике. Раньше это
 * ловил Zod-enum на входе; теперь роли — данные, и проверка ушла в
 * сервис. Молча создавать сотрудника с несуществующим кодом нельзя:
 * он бы получил ровно ноль прав, а причина осталась бы невидимой.
 */
export class EmployeeRoleUnknownException extends BusinessException {
  constructor(codes: string[]) {
    super(
      'EMPLOYEE_ROLE_UNKNOWN',
      `Неизвестные роли: ${codes.join(', ')}. Заведите роль в разделе «Роли» или выберите существующую.`,
      HttpStatus.BAD_REQUEST,
    );
  }
}

export class AppRoleSystemImmutableException extends BusinessException {
  constructor(message = 'Системную роль изменить нельзя') {
    super('APP_ROLE_SYSTEM_IMMUTABLE', message, HttpStatus.CONFLICT);
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
 * Фича «смена роли сканом рабочего места» (`POST /api/me/switch-workplace`).
 * Отсканированное оборудование не привязано к роли (`Equipment.role IS
 * NULL`) — переключиться на него нельзя, менеджер должен задать роль
 * рабочего места в `/admin/equipment`.
 */
export class WorkplaceNoRoleException extends BusinessException {
  constructor() {
    super(
      'WORKPLACE_NO_ROLE',
      'У этого рабочего места не задана роль — обратитесь к начальнику цеха.',
      HttpStatus.BAD_REQUEST,
    );
  }
}

/**
 * Роль отсканированного рабочего места не входит в набор ролей
 * сотрудника (`Employee.roles`). Переключение запрещено.
 */
export class WorkplaceRoleForbiddenException extends BusinessException {
  constructor() {
    super(
      'WORKPLACE_ROLE_FORBIDDEN',
      'У вас нет доступа к этому участку.',
      HttpStatus.FORBIDDEN,
    );
  }
}

/**
 * При переключении рабочего места у сотрудника есть незавершённая
 * работа (открытая смена с паспортом на руках). Требуется явное
 * подтверждение — UI повторит запрос с `force: true`. Код синхронен
 * с `WORKPLACE_SWITCH_CONFIRM_REQUIRED_CODE` из `@sewing/shared/workplace`.
 */
export class WorkplaceSwitchConfirmRequiredException extends BusinessException {
  constructor() {
    super(
      'WORKPLACE_SWITCH_CONFIRM_REQUIRED',
      'У вас есть незавершённая работа. Закрыть смену и перейти на другой участок?',
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
 * Нельзя физически удалить операцию: на неё ссылается
 * производственная / финансовая история или конфигурация маршрутов
 * (`OperationEntry`, `PassportEvent`, `OrderRouteStep`,
 * `RouteTemplateStep`, `ShiftSession`, текущая операция паспорта,
 * `MasterCall`, `OperationSubstitution`). Менеджер должен
 * деактивировать операцию (`isActive = false`), а не удалять.
 * Detail — через `GET /api/operations/:id/blockers`.
 *
 * Параллель к `EmployeeHasHistoryException`: hard-delete доступен
 * только для свежесозданных, нигде не использованных операций.
 */
export class OperationInUseException extends BusinessException {
  constructor() {
    super(
      'OPERATION_IN_USE',
      'Операция используется в истории или маршрутах — удаление невозможно. Деактивируйте её.',
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
 * её не содержит. На MVP это явная бизнес-ошибка, а не silent skip —
 * иначе доверие к зарплатной логике сломается при первой же забытой
 * ставке. Заменил исторический `PIECE_RATE_NOT_FOUND` (удалён в
 * PHASE 2 STEP 1 вместе с таблицей `PieceRate`).
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

/**
 * Сотрудник пытается стартовать смену на оборудовании, для которого
 * выбранная операция не входит в allow-list `EquipmentOperation`
 * (см. ADR-0017). Источник истины — та же выборка, что у
 * `/api/shifts/meta`: связь должна существовать и быть `isActive=true`.
 */
export class ShiftOperationNotAllowedForEquipmentException extends BusinessException {
  constructor() {
    super(
      'SHIFT_OPERATION_NOT_ALLOWED_FOR_EQUIPMENT',
      'Операция недоступна для выбранного оборудования.',
      HttpStatus.CONFLICT,
    );
  }
}

/**
 * Сотрудник пытается сменить операцию в активной смене
 * (`POST /api/shifts/switch-operation`), пока у него ещё есть паспорта
 * `currentEmployeeId = me AND status = IN_PROGRESS`. Запрещено: если
 * переключить операцию в этот момент, при `completeOperationByEmployee`
 * событие `OPERATION_FINISHED` зафиксируется на НОВОЙ операции вместо
 * той, на которой паспорт реально шился (см. использование
 * `session.operationId` в `PassportsService.completeOperationByEmployee`).
 */
export class ShiftHasActivePassportsException extends BusinessException {
  constructor() {
    super(
      'SHIFT_HAS_ACTIVE_PASSPORTS',
      'Сначала завершите все паспорта на текущей операции — потом можно переключиться.',
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

/**
 * По паспорту уже зафиксировано `OPERATION_FINISHED` на той же операции
 * текущей смены. Повторная выдача (`issueToEmployee`) или повторное
 * завершение (`completeOperationByEmployee`) той же операции запрещены —
 * операция считается закрытой безвозвратно для рядового сотрудника.
 * Откат для переделки возможен только админом через прямую правку БД.
 */
export class PassportOperationAlreadyFinishedException extends BusinessException {
  constructor() {
    super(
      'PASSPORT_OPERATION_ALREADY_FINISHED',
      'Операция по данному паспорту закрыта для вас.',
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

/**
 * ОТК пытается «Вернуть на переделку», но по паспорту нет ни одного
 * `OPERATION_FINISHED` — некому возвращать. Теоретически невозможно
 * (ОТК получает паспорт только после прохождения хотя бы одной
 * пошивной операции), но защита оставлена на случай ручной правки БД.
 */
export class PassportNoFinishedOperationException extends BusinessException {
  constructor() {
    super(
      'PASSPORT_NO_FINISHED_OPERATION',
      'У паспорта нет завершённых операций — некому возвращать на переделку.',
      HttpStatus.CONFLICT,
    );
  }
}

/**
 * ОТК пытается «Вернуть на переделку», но в маршруте заказа нет шага
 * с операцией предыдущего финиша (маршрут перерисовали уже после
 * прохождения). Edge-case; решается мастером через `set-route-step`.
 */
export class PassportReworkRouteStepMissingException extends BusinessException {
  constructor() {
    super(
      'PASSPORT_REWORK_ROUTE_STEP_MISSING',
      'В текущем маршруте заказа нет шага под операцию предыдущего финиша. Обратитесь к мастеру цеха.',
      HttpStatus.CONFLICT,
    );
  }
}

/**
 * ОТК пытается «Вернуть на переделку» паспорт, который уже отправлен
 * на rework и ждёт сканирования швеёй. Защита от двойного нажатия.
 */
export class PassportReworkAlreadyPendingException extends BusinessException {
  constructor() {
    super(
      'PASSPORT_REWORK_ALREADY_PENDING',
      'Паспорт уже возвращён на переделку и ждёт сканирования швеёй.',
      HttpStatus.CONFLICT,
    );
  }
}

/**
 * Сканирование паспорта на ОТК запрещено, пока открыт rework. Иначе
 * scan переключает `currentRouteStepIndex` обратно на QC-шаг, и
 * последующая выдача швее падает на `PASSPORT_ISSUE_BACKWARD`.
 * Источник истины: ОТК должна дождаться, пока швея переделает.
 */
export class PassportReworkPendingException extends BusinessException {
  constructor() {
    super(
      'PASSPORT_REWORK_PENDING',
      'Паспорт сейчас на переделке у швеи. Дождитесь её сканирования у станка.',
      HttpStatus.CONFLICT,
    );
  }
}

/**
 * ОТК пытается вернуть паспорт на операцию, которой нет в списке
 * допустимых (не в маршруте, не SEWING, нет завершений, либо по ней
 * уже открыт rework). Источник истины — `QcService.getQcDetail`
 * (`eligibleReworkTargets`).
 */
export class PassportReworkTargetNotEligibleException extends BusinessException {
  constructor() {
    super(
      'PASSPORT_REWORK_TARGET_NOT_ELIGIBLE',
      'На эту операцию вернуть нельзя: она не из числа доступных для переделки.',
      HttpStatus.CONFLICT,
    );
  }
}

/**
 * Швея берёт/завершает паспорт, возвращённый ОТК на переделку, но
 * операция этой переделки не разрешена на оборудовании её текущей смены
 * (allow-list `EquipmentOperation`). Авто-определение операции по
 * паспорту (см. `PassportsService.resolveOperationForPassport`) не имеет
 * права молча закрыть rework на «не той» операции — иначе
 * `OPERATION_FINISHED` зафиксируется неверно. Просим перейти на
 * подходящее оборудование/операцию. Сообщение содержит имя нужной
 * операции, чтобы швея сразу понимала, куда переключиться.
 */
export class PassportReworkOperationNotAllowedForShiftException extends BusinessException {
  constructor(operationName: string) {
    super(
      'PASSPORT_REWORK_OPERATION_NOT_ALLOWED_FOR_SHIFT',
      `Этот паспорт нужно переделать на операции «${operationName}» — она не разрешена на оборудовании вашей смены. Переключитесь на подходящее оборудование.`,
      HttpStatus.CONFLICT,
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
      'Паспорт ещё не прошёл ОТК.',
      HttpStatus.CONFLICT,
    );
  }
}

/**
 * Паспорт пытаются упаковать, не пройдя ВТО.
 *
 * Источник истины — `PassportEvent(WTO_PASSED)`: ВТО нажимает «Завершить
 * ВТО», и backend пишет соответствующее событие. Без него паспорт ещё
 * не отглажен и упаковывать его нельзя. Симметрично `PASSPORT_NOT_QC_
 * PASSED`, применяется в `PackingService.addPassport`, если в маршруте
 * заказа есть шаг категории `IRONING`.
 */
export class PassportNotWtoPassedException extends BusinessException {
  constructor() {
    super(
      'PASSPORT_NOT_WTO_PASSED',
      'Паспорт ещё не прошёл ВТО — упаковывать нельзя.',
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

/** Размещение коробки в ячейку до её закрытия запрещено. */
export class BoxNotClosedForPlacementException extends BusinessException {
  constructor() {
    super(
      'BOX_NOT_CLOSED_FOR_PLACEMENT',
      'Сначала закройте коробку — размещать в ячейку можно только закрытые.',
      HttpStatus.CONFLICT,
    );
  }
}

/** Коробка уже размещена в ячейку. */
export class BoxAlreadyPlacedException extends BusinessException {
  constructor() {
    super(
      'BOX_ALREADY_PLACED',
      'Коробка уже размещена в ячейку.',
      HttpStatus.CONFLICT,
    );
  }
}

// ---------------------------------------------------------------------------
// Earnings / payroll (Шаг 9)
// ---------------------------------------------------------------------------

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
 * не задана ставка, по которой запись пересчитывается: почасовая для
 * дневных/подкройных строк, месячный оклад — для `MONTH_SALARY`.
 * Возвращать к чему — непонятно: нужно сначала проставить ставку в
 * карточке сотрудника.
 */
export class SalaryReentryWithoutRateException extends BusinessException {
  constructor() {
    super(
      'SALARY_RATE_MISSING',
      'У сотрудника не задана ставка — сначала укажите её в карточке.',
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
}

/**
 * Строка производственного календаря (`PayrollCalendarMonth`) не
 * найдена. Бросается из `PayrollCalendarService.remove`, когда
 * менеджер удаляет месяц, которого уже нет (двойной клик, старая
 * вкладка).
 */
export class PayrollCalendarMonthNotFoundException extends BusinessException {
  constructor() {
    super(
      'PAYROLL_CALENDAR_MONTH_NOT_FOUND',
      'Месяц производственного календаря не найден',
      HttpStatus.NOT_FOUND,
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
 * Inline-создание изделия из формы заказа (см.
 * `OrdersService.create::CREATE_FOR_CALCULATION`,
 * `apps/web/app/admin/orders/new/admin-create-order-form.tsx`).
 *
 * Техкарта несовместима с выбранной группой номенклатуры: хотя бы
 * один активный `PatternCategoryParameter(inputType=AREA_M2_BY_SIZE)`
 * не имеет соответствующей строки `TechCardMaterialLine.materialRole`.
 * UI получает `missingRoleKeys` через payload и подсвечивает
 * недостающие роли.
 */
export class TechCardNotCompatibleWithCategoryException extends HttpException {
  constructor(missingRoleKeys: string[]) {
    super(
      {
        statusCode: HttpStatus.CONFLICT,
        code: 'TECH_CARD_NOT_COMPATIBLE_WITH_CATEGORY',
        message:
          missingRoleKeys.length > 0
            ? `Техкарта не покрывает обязательные материалы группы: ${missingRoleKeys.join(', ')}.`
            : 'Техкарта не совместима с группой номенклатуры.',
        missingRoleKeys,
      },
      HttpStatus.CONFLICT,
    );
  }
}

/**
 * Строка материала техкарты (`TechCardMaterialLine`) не найдена.
 * Используется upload-эндпоинтом изображения строки материала
 * (см. `TechCardsService.uploadMaterialImage`, ТЗ §5).
 */
export class TechCardMaterialLineNotFoundException extends BusinessException {
  constructor() {
    super(
      'TECH_CARD_MATERIAL_LINE_NOT_FOUND',
      'Строка материала не найдена',
      HttpStatus.NOT_FOUND,
    );
  }
}

/**
 * Загруженный файл изображения строки материала техкарты не прошёл
 * валидацию (расширение / размер / попытка path-traversal в
 * `originalname`). Сообщение формируется сервисом — UI показывает
 * его как inline-error на форме загрузки. См.
 * `TechCardsStorageService.saveMaterialImage`, ТЗ §5, §9.
 */
export class TechCardImageUploadInvalidException extends BusinessException {
  constructor(message: string) {
    super(
      'TECH_CARD_IMAGE_UPLOAD_INVALID',
      message,
      HttpStatus.BAD_REQUEST,
    );
  }
}

/**
 * Загруженный файл вложения задачи конструктору не прошёл валидацию
 * (размер / попытка path-traversal в `originalname`). Расширение файла
 * НЕ ограничено — конструктору можно слать любые форматы. См.
 * `ConstructorTasksStorageService.saveTaskFile`.
 */
export class ConstructorTaskFileInvalidException extends BusinessException {
  constructor(message: string) {
    super(
      'CONSTRUCTOR_TASK_FILE_INVALID',
      message,
      HttpStatus.BAD_REQUEST,
    );
  }
}

/**
 * `ConstructorTask` не найдена. Используется в админских GET-эндпоинтах
 * `/api/constructor-tasks/:id`.
 */
export class ConstructorTaskNotFoundException extends BusinessException {
  constructor() {
    super(
      'CONSTRUCTOR_TASK_NOT_FOUND',
      'Заявка конструктору не найдена',
      HttpStatus.NOT_FOUND,
    );
  }
}

/**
 * Payload `saveConstructorDraftAction` ссылается на размер `Size.id`,
 * которого нет в справочнике. Защита от подделки/несинхронизированной
 * формы — UI заполняет sizeId из активных размеров заказа.
 */
export class ConstructorTaskSizeNotFoundException extends BusinessException {
  constructor(sizeId: string) {
    super(
      'CONSTRUCTOR_TASK_SIZE_NOT_FOUND',
      `Размер ${sizeId} не найден в справочнике`,
      HttpStatus.BAD_REQUEST,
    );
  }
}

/**
 * Недопустимый переход статуса заявки конструктору (напр. cancel
 * `DONE`-задачи — лекало уже передано, отменять нечего).
 */
export class ConstructorTaskInvalidTransitionException extends BusinessException {
  constructor(message: string) {
    super(
      'CONSTRUCTOR_TASK_INVALID_TRANSITION',
      message,
      HttpStatus.CONFLICT,
    );
  }
}

/**
 * Конструктор пытается выполнить действие (assignSelf / updateComment /
 * complete) с задачей, которую уже взял другой конструктор. ADMIN /
 * SHOP_MANAGER эту проверку обходят (в контроллере мы не передаём
 * `enforceOwnership = true` для них), поэтому исключение поднимается
 * только для роли `CONSTRUCTOR`.
 */
export class ConstructorTaskAssignedToOtherException extends BusinessException {
  constructor() {
    super(
      'CONSTRUCTOR_TASK_ASSIGNED_TO_OTHER',
      'Задача уже назначена другому конструктору',
      HttpStatus.CONFLICT,
    );
  }
}

/**
 * Попытка завершить задачу (`POST /:id/complete`), которая не находится
 * в статусе `IN_PROGRESS`. Сценарии: задача ещё `NEW` (не взята в
 * работу), уже `DONE` (повторное завершение), или `CANCELLED`.
 */
export class ConstructorTaskNotInProgressException extends BusinessException {
  constructor() {
    super(
      'CONSTRUCTOR_TASK_NOT_IN_PROGRESS',
      'Завершить можно только задачу в статусе «В работе»',
      HttpStatus.CONFLICT,
    );
  }
}

/**
 * Набор `sizeId` в payload `complete` не совпадает с `task.sizeRows[]`
 * — есть лишний размер либо нет файла на один из обязательных. UI
 * рендерит по одному `<input type="file" name="file_<sizeId>">` на
 * каждую строку task — обычно это значит, что пользователь не выбрал
 * файл для всех полей.
 */
export class ConstructorTaskCompleteFilesMismatchException extends BusinessException {
  constructor(message: string) {
    super(
      'CONSTRUCTOR_TASK_COMPLETE_FILES_MISMATCH',
      message,
      HttpStatus.BAD_REQUEST,
    );
  }
}

/**
 * Менеджер пытается принять (`POST /:id/accept`) задачу не в
 * `PENDING_ACCEPT`. Сценарии: ещё не завершена конструктором (NEW /
 * IN_PROGRESS / REWORK), уже принята (DONE) или отменена.
 */
export class ConstructorTaskAcceptInvalidException extends BusinessException {
  constructor() {
    super(
      'CONSTRUCTOR_TASK_ACCEPT_INVALID',
      'Принять можно только задачу в статусе «На приёмке»',
      HttpStatus.CONFLICT,
    );
  }
}

/**
 * Менеджер пытается вернуть на доработку (`POST /:id/rework`) задачу
 * не в `PENDING_ACCEPT`, либо payload пришёл невалидный (например,
 * пустой комментарий).
 */
export class ConstructorTaskReworkInvalidException extends BusinessException {
  constructor(message: string) {
    super(
      'CONSTRUCTOR_TASK_REWORK_INVALID',
      message,
      HttpStatus.CONFLICT,
    );
  }
}

/**
 * Попытка создать заявку конструктору для лекала, у которого она уже
 * есть (`ConstructorTask.patternItemId` — `@unique`, строго 1:1).
 * Используется в `createForExistingPattern` («Отправить конструктору»
 * из карточки заказа / номенклатуры). Менеджеру предлагаем открыть
 * существующую заявку в разделе «Заявки конструктору».
 */
export class ConstructorTaskAlreadyExistsException extends BusinessException {
  constructor() {
    super(
      'CONSTRUCTOR_TASK_ALREADY_EXISTS',
      'У этого лекала уже есть заявка конструктору — откройте её в разделе «Заявки конструктору».',
      HttpStatus.CONFLICT,
    );
  }
}

/**
 * Multipart-запрос upload-а изображения строки материала техкарты
 * пришёл без файла (`file` пустое или отсутствует).
 */
export class TechCardImageUploadMissingFileException extends BusinessException {
  constructor() {
    super(
      'TECH_CARD_IMAGE_UPLOAD_MISSING_FILE',
      'Файл не загружен — добавьте JPG/PNG в форме перед отправкой.',
      HttpStatus.BAD_REQUEST,
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

/**
 * Этап «Указать в заказе» (ТЗ §4): менеджер пытается сохранить цвет
 * через `PATCH /api/orders/:id/material-requirements/:requirementId/color`
 * для snapshot-строки `OrderMaterialRequirement`, у которой
 * `requiresColorSelection = false` (т.е. в техкарте `colorRule != ORDER_SELECTED_COLOR`
 * — цвет берётся автоматически из `Order.color` или фиксированного
 * текста). Не баг ввода (DTO валиден), а конфликт с состоянием
 * snapshot-а — отдаём 409, чтобы UI мог адресно показать «цвет
 * указывать не нужно» вместо общего 400.
 *
 * Раньше бросался inline-ом как `BadRequestException` с `body.statusCode = 409`,
 * но HTTP-статус всё равно был 400 (Nest берёт статус из конструктора,
 * а не из тела) — фронт получал расхождение `status !== body.statusCode`.
 */
export class OrderMaterialRequirementColorNotRequiredException extends BusinessException {
  constructor() {
    super(
      'ORDER_MATERIAL_REQUIREMENT_COLOR_NOT_REQUIRED',
      'Для этой строки цвет берётся автоматически — указывать вручную не нужно.',
      HttpStatus.CONFLICT,
    );
  }
}

// ---------------------------------------------------------------------------
// Outsource requirement execution status (MVP-3 техкарт, ADR-0022
// §«Manual execution status»).
// ---------------------------------------------------------------------------

/**
 * Snapshot-строка `OrderOutsourceRequirement` не найдена ни для
 * указанного `:id` (заказа), ни для `:requirementId`. Бросается
 * `OrdersService.updateOutsourceRequirementStatus`.
 */
export class OrderOutsourceRequirementNotFoundException extends BusinessException {
  constructor() {
    super(
      'OUTSOURCE_REQUIREMENT_NOT_FOUND',
      'Внешняя потребность не найдена в этом заказе',
      HttpStatus.NOT_FOUND,
    );
  }
}

/**
 * Менеджер пытается сделать недопустимый переход ручного статуса
 * выполнения внешней потребности.
 *
 * На MVP линейный жизненный цикл `PLANNED → ORDERED → RECEIVED`,
 * откатов через action нет (см. ADR-0022). Сюда же попадает попытка
 * `PLANNED → RECEIVED` (без промежуточного ORDERED).
 */
export class OrderOutsourceRequirementInvalidTransitionException extends BusinessException {
  constructor(message: string) {
    super(
      'OUTSOURCE_REQUIREMENT_INVALID_TRANSITION',
      message,
      HttpStatus.CONFLICT,
    );
  }
}

/**
 * Для `triggerType = CUT_READY` нельзя отметить строку как `ORDERED`,
 * пока derived `isReadyToOrder = false` (т.е. крой ещё не размещён в
 * ячейки по правилу ALL_PASSPORTS). Это бизнес-инвариант MVP-2/MVP-3:
 * UI скрывает кнопку, но action делает явный backend-guard на случай
 * прямого вызова API.
 */
export class OrderOutsourceRequirementNotReadyException extends BusinessException {
  constructor() {
    super(
      'OUTSOURCE_NOT_READY_TO_ORDER',
      'Внешнюю потребность нельзя отметить как заказанную, пока крой не размещён в ячейки.',
      HttpStatus.CONFLICT,
    );
  }
}

/**
 * Ручная строка логистики заказа (`OrderLogisticsLine`) не найдена ни
 * для указанного `:id` (заказа), ни для `:lineId`. Бросается
 * `OrdersService.updateLogisticsLine` / `deleteLogisticsLine`.
 */
export class OrderLogisticsLineNotFoundException extends BusinessException {
  constructor() {
    super(
      'ORDER_LOGISTICS_LINE_NOT_FOUND',
      'Строка логистики не найдена в этом заказе',
      HttpStatus.NOT_FOUND,
    );
  }
}

// ---------------------------------------------------------------------------
// Master actions (Stage 2 «Мастер цеха», см.
// `apps/api/src/modules/master-actions/*`).
// ---------------------------------------------------------------------------

/**
 * Мастер пытается изменить терминальный паспорт (`PACKED` / `CANCELLED`).
 * Конкретный статус указан в сообщении, чтобы UI показывал понятный
 * текст. Используем общий код `PASSPORT_TERMINAL`, чтобы фронт мог
 * единообразно подсветить попытку «трогать» закрытый паспорт.
 */
export class PassportTerminalForMasterException extends BusinessException {
  constructor(status: 'PACKED' | 'CANCELLED') {
    super(
      'PASSPORT_TERMINAL',
      status === 'PACKED'
        ? 'Паспорт уже упакован — действие недоступно.'
        : 'Паспорт отменён — действие недоступно.',
      HttpStatus.CONFLICT,
    );
  }
}

/**
 * Мастер пытается передать паспорт сотруднику, которого нет в базе —
 * скорее всего, отсканирован старый/чужой QR.
 */
export class MasterTargetEmployeeNotFoundException extends BusinessException {
  constructor() {
    super(
      'TARGET_EMPLOYEE_NOT_FOUND',
      'Сотрудник по этому QR не найден.',
      HttpStatus.NOT_FOUND,
    );
  }
}

/**
 * Мастер пытается передать паспорт деактивированному сотруднику.
 * Активность — единственный признак «может работать» на MVP
 * (см. `Employee.active`).
 */
export class MasterTargetEmployeeInactiveException extends BusinessException {
  constructor() {
    super(
      'TARGET_EMPLOYEE_INACTIVE',
      'Этот сотрудник деактивирован — передавать паспорт ему нельзя.',
      HttpStatus.CONFLICT,
    );
  }
}

/**
 * Наряд-допуск выдаётся на операцию, которая УЖЕ есть в маршруте
 * заказа. Такой допуск бессмыслен (работа и так разрешена) и почти
 * наверняка означает, что мастер промахнулся строкой в списке.
 */
export class RouteWorkPermitOperationAlreadyInRouteException extends BusinessException {
  constructor() {
    super(
      'ROUTE_WORK_PERMIT_OPERATION_ALREADY_IN_ROUTE',
      'Эта операция уже есть в маршруте заказа — допуск не нужен. Проверьте, ту ли операцию выбрали.',
      HttpStatus.CONFLICT,
    );
  }
}

export class RouteWorkPermitNotFoundException extends BusinessException {
  constructor() {
    super(
      'ROUTE_WORK_PERMIT_NOT_FOUND',
      'Наряд-допуск не найден.',
      HttpStatus.NOT_FOUND,
    );
  }
}

/**
 * Швея берёт/сканирует/закрывает паспорт на операции, которой НЕТ в
 * маршруте его заказа (и которая не является заместителем ни одного
 * шага). Бросается из `PassportsService` при
 * `CompanySettings.offRouteWorkPolicy = BLOCK`.
 *
 * Это корневой гейт всей истории «работа мимо маршрута». До 28.07.2026
 * такой случай не проверялся ВООБЩЕ: `evaluateRouteOrder` возвращал
 * пустой результат и отключал проверку целиком, из-за чего правило было
 * вывернуто наизнанку — взять операцию на шаг раньше нельзя,
 * перепрыгнуть незакрытый шаг нельзя, а взять операцию, которой в
 * маршруте нет вовсе, можно. Работа принималась молча, партия шилась до
 * конца и упиралась в AND-гейт перед ОТК недели спустя: 28.07 — 70
 * паспортов в 8 заказах, лаг обнаружения 27 дней, шестой случай подряд.
 *
 * Проверка касается ТОЛЬКО категории `SEWING`: крой закрывается при
 * выпуске паспорта, ОТК/ВТО/упаковка — на собственных гейтах, и в
 * снимке маршрута их штатно нет. Без этого сужения гейт положил бы
 * четыре участка из пяти.
 */
export class PassportOperationNotInOrderRouteException extends BusinessException {
  constructor(orderNumber: string | null, operationName: string) {
    super(
      'PASSPORT_OPERATION_NOT_IN_ORDER_ROUTE',
      `Операции «${operationName}» нет в маршруте заказа${orderNumber ? ` ${orderNumber}` : ''}. Эта работа не засчитается, и заказ встанет на ОТК. Позовите мастера.`,
      HttpStatus.CONFLICT,
    );
  }
}

/**
 * Попытка ДОБАВИТЬ в шаблон маршрута операцию, которая лежит в архиве.
 *
 * Проверяются только добавляемые операции: на проде 14 из 20 активных
 * шаблонов уже содержат архивные шаги (наследство прошлых чисток
 * справочника), и проверка «все шаги активны» сделала бы несохраняемыми
 * почти все шаблоны, включая основные. Правило: старое не трогаем,
 * новое не пускаем.
 */
export class RouteTemplateStepOperationArchivedException extends BusinessException {
  constructor(archived: readonly string[]) {
    super(
      'ROUTE_TEMPLATE_STEP_OPERATION_ARCHIVED',
      `Нельзя добавить в маршрут операции из архива: ${archived.join(', ')}. Верните их из архива или выберите другие.`,
      HttpStatus.CONFLICT,
    );
  }
}

/**
 * Заказ нельзя запустить в производство: в шаблоне его маршрута есть
 * ШВЕЙНЫЕ операции, отправленные в архив (или архивен сам шаблон).
 *
 * Почему это блокировка, а не предупреждение. Список операций станка
 * (`EquipmentOperation`) отдаёт швее только активные операции. Значит
 * архивная швейная операция в снимке маршрута — это шаг, который швея
 * ФИЗИЧЕСКИ не может выбрать: заказ уходит в производство уже мёртвым,
 * молча стоит и обнаруживается случайно. Так умерли O-20260615-0004
 * (188 паспортов, 3 500 шт, простой 28 дней) и O-20260615-0005.
 *
 * Только `SEWING`: крой, ОТК, ВТО и упаковка закрываются на собственных
 * гейтах и из списка станка не выбираются — архивная кроевая операция
 * безвредна. Это не теория: шаблоны 01 и 02 (основной поток футболок)
 * годами работают с архивным «Делением кроя», и ни один заказ на этом
 * не встал. Расширение проверки на все категории положило бы основной
 * поток в первый же день.
 *
 * Проверка стоит ТОЛЬКО на `start()` — точке невозврата, где снимок
 * становится immutable. На создании и правке заказа не блокируем:
 * заказ ещё планируется, технолог может починить шаблон.
 */
export class OrderRouteTemplateHasArchivedOperationsException extends BusinessException {
  constructor(templateName: string, archived: readonly string[]) {
    super(
      'ORDER_ROUTE_TEMPLATE_HAS_ARCHIVED_OPERATIONS',
      `Нельзя запустить заказ: в маршруте «${templateName}» есть операции из архива — ${archived.join(', ')}. Швея не сможет их выбрать, и заказ встанет. Верните операции из архива или поправьте шаблон.`,
      HttpStatus.CONFLICT,
    );
  }
}

/**
 * Заказ нельзя запустить: сам шаблон маршрута отправлен в архив.
 * Архивный шаблон — это «больше так не шьём»; запуск по нему означает,
 * что заказ поедет по устаревшей технологии. Инцидент 22.07.2026:
 * через три недели после перехода цеха на окантовку на архивируемом
 * сплит-шаблоне создали новый заказ с киперкой.
 */
export class OrderRouteTemplateArchivedException extends BusinessException {
  constructor(templateName: string) {
    super(
      'ORDER_ROUTE_TEMPLATE_ARCHIVED',
      `Нельзя запустить заказ: шаблон маршрута «${templateName}» в архиве. Выберите актуальный шаблон или верните этот из архива.`,
      HttpStatus.CONFLICT,
    );
  }
}

/**
 * Запрошенный шаг маршрута не существует в snapshot заказа
 * (`OrderRouteStep`). Мастер должен выбирать только реальные шаги
 * snapshot'а, иначе паспорт окажется на «несуществующей» операции.
 */
export class MasterRouteStepNotInSnapshotException extends BusinessException {
  constructor() {
    super(
      'ROUTE_STEP_NOT_IN_SNAPSHOT',
      'Эта операция не входит в маршрут заказа этого паспорта.',
      HttpStatus.CONFLICT,
    );
  }
}

/**
 * У заказа этого паспорта нет snapshot маршрута — назначать шаг
 * нечего. Бросается до проверки конкретного индекса.
 */
export class MasterOrderHasNoRouteSnapshotException extends BusinessException {
  constructor() {
    super(
      'ORDER_HAS_NO_ROUTE_SNAPSHOT',
      'У заказа этого паспорта нет маршрута — нечего назначать.',
      HttpStatus.CONFLICT,
    );
  }
}

/**
 * Мастер пытается переместить паспорт назад по маршруту
 * (target step index < currentRouteStepIndex), но не указал ни ячейку
 * (`cellQr` / `cellId`), ни сотрудника (`employeeQr` / `employeeId`).
 * По инварианту из `docs/flows.md` («Master rollback») любое
 * откат-движение должно заканчиваться явным placement-ом: либо паспорт
 * ложится в ячейку, либо передаётся «из рук в руки» конкретному
 * сотруднику — иначе он зависнет «в воздухе» (no employee, no cell),
 * и это нельзя будет отличить от ошибки в БД.
 *
 * Бросается из `MasterActionsService.setRouteStep`.
 */
export class MasterBackwardRouteRequiresPlacementException extends BusinessException {
  constructor() {
    super(
      'MASTER_BACKWARD_ROUTE_REQUIRES_PLACEMENT',
      'Откат паспорта назад по маршруту разрешён только с одновременным placement-ом. Укажите либо ячейку (cellQr/cellId), либо сотрудника (employeeQr/employeeId).',
      HttpStatus.BAD_REQUEST,
    );
  }
}

/**
 * Мастер пытается назначить паспорту шаг маршрута на операцию, по
 * которой у этого паспорта уже зафиксировано `OPERATION_FINISHED`.
 * Возврат на завершённую операцию запрещён — она считается закрытой
 * безвозвратно. Для исправления (переделка по браку и т.п.) требуется
 * прямая правка БД админом.
 *
 * Бросается из `MasterActionsService.setRouteStep`.
 */
export class MasterTargetOperationAlreadyFinishedException extends BusinessException {
  constructor() {
    super(
      'MASTER_TARGET_OPERATION_ALREADY_FINISHED',
      'Операция по этому паспорту уже завершена; вернуть паспорт на неё нельзя.',
      HttpStatus.CONFLICT,
    );
  }
}

/**
 * Сотрудник пытается завершить операцию, которая стоит в маршруте
 * РАНЬШЕ текущего `currentRouteStepIndex` паспорта. Обычный
 * complete-operation не может откатывать паспорт назад — этим
 * занимается мастер через `set-route-step` с placement-ом в ячейку.
 *
 * Бросается из `PassportsService.completeOperationByEmployee`, когда
 * `activeShift.operationId` соответствует более раннему шагу маршрута.
 */
export class PassportCompleteBackwardException extends BusinessException {
  constructor() {
    super(
      'PASSPORT_COMPLETE_BACKWARD',
      'Нельзя завершить операцию, стоящую в маршруте раньше текущей. Откат назад делает мастер.',
      HttpStatus.CONFLICT,
    );
  }
}

/**
 * Сотрудник пытается «взять» паспорт сканированием на операции, которая
 * стоит в маршруте РАНЬШЕ уже зафиксированного `currentRouteStepIndex`.
 * Симметрично `PASSPORT_COMPLETE_BACKWARD`: откат паспорта назад по
 * маршруту — прерогатива мастера (`MasterActionsService.setRouteStep`).
 *
 * Бросается из `PassportsService.scanOnOperation`, когда операция
 * активной смены найдена в snapshot маршрута заказа с индексом меньше
 * текущего.
 */
export class PassportScanBackwardException extends BusinessException {
  constructor() {
    super(
      'PASSPORT_SCAN_BACKWARD',
      'Нельзя взять эту операцию: по маршруту она идёт раньше текущего шага паспорта. Откат назад делает мастер.',
      HttpStatus.CONFLICT,
    );
  }
}

/**
 * Сотрудник пытается «получить крой» (issue) на операции, которая стоит
 * в маршруте РАНЬШЕ уже зафиксированного `currentRouteStepIndex`. Без
 * этой симметрии с `PASSPORT_SCAN_BACKWARD` issue-канал становился
 * лазейкой: switch на «прошлый» шаг через issue не двигает
 * `currentRouteStepIndex`, а последующий complete падает с
 * `PASSPORT_COMPLETE_BACKWARD` — паспорт «зависает» у швеи.
 *
 * Бросается из `PassportsService.issueToEmployee`, когда операция
 * активной смены найдена в snapshot маршрута заказа с индексом меньше
 * текущего.
 */
export class PassportIssueBackwardException extends BusinessException {
  constructor() {
    super(
      'PASSPORT_ISSUE_BACKWARD',
      'Нельзя получить крой на этой операции: по маршруту она идёт раньше текущего шага паспорта. Возврат назад делает мастер.',
      HttpStatus.CONFLICT,
    );
  }
}

/**
 * Попытка взять паспорт на операцию, идущую ПОСЛЕ параллельной
 * (взаимозаменяемой) группы маршрута, до того как завершены ВСЕ операции
 * этой группы. Пример: маршрут `… ОВР → {КИПЕРКА ⇄ РАСПОШИВ} → ОТК …`;
 * на ОТК нельзя, пока не сделаны и КИПЕРКА, и РАСПОШИВ (порядок внутри
 * пары любой). Бросается из `PassportsService.issueToEmployee` /
 * `scanOnOperation`. Внутри самой группы порядок свободный — это НЕ
 * откат назад (`PASSPORT_*_BACKWARD`).
 *
 * `missing` — названия реально незакрытых операций группы (с учётом
 * `OperationSubstitution`: закрытие заместителя засчитывает замещаемую).
 * Раньше текст был статичным примером «например, КИПЕРКА и РАСПОШИВ», и
 * это стабильно уводило разбор в сторону: инцидент 28.07.2026 (заказ
 * O-20260510-0001) — не хватало ОДНОЙ киперки, а мастер по тексту искал
 * ещё и распошив, который на самом деле был закрыт через заместителя.
 * Пустой список (не смогли назвать) → прежняя формулировка.
 */
export class PassportParallelGroupIncompleteException extends BusinessException {
  constructor(missing: readonly string[] = []) {
    super(
      'PASSPORT_PARALLEL_GROUP_INCOMPLETE',
      missing.length > 0
        ? `Нельзя перейти на следующую операцию: на предыдущем этапе не завершено — ${missing.join(', ')}.`
        : 'Нельзя перейти на следующую операцию: не завершены все взаимозаменяемые операции предыдущего этапа (например, КИПЕРКА и РАСПОШИВ).',
      HttpStatus.CONFLICT,
    );
  }
}

/**
 * Попытка взять/отсканировать паспорт на швейную операцию, перепрыгнув
 * незавершённую швейную операцию, которая по маршруту стоит строго между
 * текущим шагом паспорта и целевой операцией. Пример (инцидент
 * 16.06.2026): маршрут `Деление кроя → ОВР/ФУЛ → {КИПЕРКА ⇄ РАСПОШИВ} →
 * ОТК`; нельзя взять КИПЕРКУ, пока не закрыт ОВР/ФУЛ.
 *
 * В отличие от `PASSPORT_PARALLEL_GROUP_INCOMPLETE` (AND-гейт по
 * параллельной группе), это последовательный шаг вне группы. Проверка
 * только для категории `SEWING`: крой закрывается при выпуске, ОТК/ВТО —
 * на собственных гейтах, и `OPERATION_FINISHED` они не пишут. Бросается
 * из `PassportsService.issueToEmployee` / `scanOnOperation`; к `complete`
 * НЕ применяется (завершить саму операцию всегда допустимо). Откат назад
 * остаётся прерогативой мастера (`set-route-step`).
 *
 * `missing` — названия незакрытых швейных шагов (см. коммент к
 * `PassportParallelGroupIncompleteException`: называем то, что реально
 * мешает, а не пример из документации).
 */
export class PassportPrecedingStepIncompleteException extends BusinessException {
  constructor(missing: readonly string[] = []) {
    super(
      'PASSPORT_PRECEDING_STEP_INCOMPLETE',
      missing.length > 0
        ? `Нельзя перейти на эту операцию: по маршруту раньше не завершено — ${missing.join(', ')}. Сначала закройте её.`
        : 'Нельзя перейти на эту операцию: по маршруту раньше стоит незавершённая швейная операция (например, ОВР/ФУЛ перед КИПЕРКОЙ). Сначала закройте её.',
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
// Employee self-service (GET /api/me/employee-qr, см.
// `apps/api/src/modules/me/*`, `packages/shared/src/employee-qr.ts`).
// ---------------------------------------------------------------------------

/**
 * `GET /api/me/employee-qr`: у текущего пользователя не нашлась
 * карточка `Employee` (теоретически возможно, если сотрудника
 * удалили между выдачей сессии и вызовом). В SEWING `Employee`
 * совпадает с auth-principal'ом, поэтому для практики это «не
 * должно случиться», но endpoint всё равно обязан иметь явный
 * код — иначе UI будет ловить generic 500.
 */
export class EmployeeProfileNotFoundException extends BusinessException {
  constructor() {
    super(
      'EMPLOYEE_PROFILE_NOT_FOUND',
      'К учётной записи не привязана карточка сотрудника.',
      HttpStatus.NOT_FOUND,
    );
  }
}

/**
 * `GET /api/me/employee-qr`: карточка найдена, но `active = false`.
 *
 * В обычном flow `AuthGuard` уже режет неактивных сотрудников в
 * `resolvePrincipal` (вернёт `null` → 401). Этот класс нужен как
 * defence-in-depth: если в будущем появится способ «ADMIN смотрит
 * чужой QR» или session-логика релаксирует проверку `active`, мы
 * всё равно обязаны отдавать 403 `EMPLOYEE_INACTIVE` без утечки
 * токена.
 *
 * Статус сознательно 403 (а не 409, как у исторического
 * `EmployeeInactiveException`): задача явно требует
 * «`403 EMPLOYEE_INACTIVE`». Код сообщения совпадает с существующим
 * классом — UI уже умеет показывать «Сотрудник деактивирован».
 */
export class EmployeeInactiveForbiddenException extends BusinessException {
  constructor() {
    super(
      'EMPLOYEE_INACTIVE',
      'Сотрудник деактивирован.',
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

// ---------------------------------------------------------------------------
// Passport qty corrections (корректировка фактического количества ОТК → мастер,
// см. `apps/api/src/modules/passport-qty-corrections/*`).
// ---------------------------------------------------------------------------

/**
 * Корректировать количество можно только у паспорта «в работе»
 * (`IN_PROGRESS`). Упакованные/отменённые — вне Фазы 1 (там пришлось бы
 * откатывать коробки и склад готовой продукции).
 */
export class QtyCorrectionPassportNotEditableException extends BusinessException {
  constructor() {
    super(
      'QTY_CORRECTION_PASSPORT_NOT_EDITABLE',
      'Корректировать количество можно только у паспорта в работе (до упаковки).',
      HttpStatus.CONFLICT,
    );
  }
}

/**
 * Новое количество приводит к отрицательному `qtyGood`
 * (`qtyCut − qtyDefect < 0`). Нельзя опустить фактическое количество
 * ниже уже зафиксированного брака.
 */
export class QtyCorrectionBelowDefectException extends BusinessException {
  constructor(minQty: number) {
    super(
      'QTY_CORRECTION_BELOW_DEFECT',
      `Новое количество не может быть меньше ${minQty}: по паспорту уже зафиксирован брак.`,
      HttpStatus.CONFLICT,
    );
  }
}

/**
 * По паспорту уже есть открытая (`PENDING`) заявка на корректировку.
 * Двух одновременно открытых не бывает (partial unique index
 * `passport_qty_correction_pending_uniq`).
 */
export class QtyCorrectionAlreadyPendingException extends BusinessException {
  constructor() {
    super(
      'QTY_CORRECTION_ALREADY_PENDING',
      'По этому паспорту уже есть корректировка на согласовании у мастера.',
      HttpStatus.CONFLICT,
    );
  }
}

export class QtyCorrectionNotFoundException extends BusinessException {
  constructor() {
    super(
      'QTY_CORRECTION_NOT_FOUND',
      'Заявка на корректировку количества не найдена.',
      HttpStatus.NOT_FOUND,
    );
  }
}

/**
 * Approve/reject/cancel допустим только для `PENDING`. Терминальные
 * статусы (`APPROVED`/`REJECTED`) уже зафиксированы.
 */
export class QtyCorrectionNotPendingException extends BusinessException {
  constructor() {
    super(
      'QTY_CORRECTION_NOT_PENDING',
      'Заявка уже рассмотрена — решение поменять нельзя.',
      HttpStatus.CONFLICT,
    );
  }
}

// ---------------------------------------------------------------------------
// Passport delete blockers (см. `PassportsService.delete`,
// `docs/domain.md §7.8 «Удаление паспорта»`).
//
// Удаление паспорта — операционная корректировка ошибки выпуска. Поэтому
// мы блокируем удаление, как только данные паспорта уже «уехали в
// бухгалтерию» (подтверждённые сдельные начисления / проведённый
// документ расхода материалов) или физически легли в коробку (упаковка
// уже считает паспорт выпущенным изделием).
// ---------------------------------------------------------------------------

export class PassportPackedDeleteException extends BusinessException {
  constructor(boxNumber: string) {
    super(
      'PASSPORT_HAS_BOX',
      `Паспорт упакован в коробку ${boxNumber}. Удалите паспорт из коробки на упаковке, тогда его можно будет удалить.`,
      HttpStatus.CONFLICT,
    );
  }
}

export class PassportHasApprovedEarningsException extends BusinessException {
  constructor() {
    super(
      'PASSPORT_HAS_APPROVED_EARNINGS',
      'По паспорту есть подтверждённые сдельные начисления. Удалить паспорт нельзя — это сотрёт начисленную сотрудникам зарплату.',
      HttpStatus.CONFLICT,
    );
  }
}

/**
 * Помощник раскройщика / раскройщик пытается отредактировать или
 * удалить чужой паспорт со страницы «Выпущенные паспорта»
 * (`/work/passports`). Бросается из `PassportsService.update` /
 * `delete`, когда `actorRole` нечуток к менеджерскому RBAC и
 * `passport.creatorId !== actorEmployeeId`. Менеджеры/админ ошибки
 * не получают — они и так могут править/удалять чужие паспорта.
 */
export class PassportNotYoursToEditException extends BusinessException {
  constructor() {
    super(
      'PASSPORT_NOT_YOURS_TO_EDIT',
      'Этот паспорт выпустил другой сотрудник — изменять его нельзя.',
      HttpStatus.FORBIDDEN,
    );
  }
}

/**
 * Паспорт уже «уехал» в производство — редактировать или удалять
 * силами помощника/раскройщика нельзя:
 *   - status != CREATED,
 *   - currentCellId != null (паспорт лежит в ячейке),
 *   - есть `PassportEvent`, отличный от `CREATED` (issue/scan/qc/place).
 *
 * Менеджер на admin-карточке тоже ловит этот код для PATCH (с теми же
 * инвариантами): после первого скана/размещения паспорт правится
 * только через master-actions и операционные сервисы.
 */
export class PassportNotEditableException extends BusinessException {
  constructor() {
    super(
      'PASSPORT_NOT_EDITABLE',
      'Паспорт уже двинулся: размещён в ячейке, попал в работу или упакован — править его нельзя. Создайте новый паспорт.',
      HttpStatus.CONFLICT,
    );
  }
}

export class PassportHasPostedMaterialIssueException extends BusinessException {
  constructor() {
    super(
      'PASSPORT_HAS_POSTED_MATERIAL_ISSUE',
      'По паспорту проведён документ расхода материалов. Удалить паспорт нельзя — это сломает учёт расхода.',
      HttpStatus.CONFLICT,
    );
  }
}

// ---------------------------------------------------------------------------
// Clients (управленческий справочник, см.
// `apps/api/src/modules/clients/*`, `prisma/schema.prisma model Client`).
// ---------------------------------------------------------------------------

/**
 * Карточка клиента не найдена. Бросается из `ClientsService.get/update`,
 * а также из `OrdersService.create/update`, если менеджер указал
 * несуществующий `clientId`.
 */
export class ClientNotFoundException extends BusinessException {
  constructor() {
    super('CLIENT_NOT_FOUND', 'Клиент не найден', HttpStatus.NOT_FOUND);
  }
}

/**
 * Менеджер пытается привязать заказ к деактивированной карточке
 * клиента (`isActive = false`). На MVP это soft-error на API-уровне:
 * UI скрывает неактивных в селекте, но прямой POST/PATCH
 * `/api/orders` блокируется отдельной 400-кой, чтобы не было
 * случайных «зомби-связей».
 */
export class ClientInactiveException extends BusinessException {
  constructor() {
    super(
      'CLIENT_INACTIVE',
      'Клиент деактивирован — выбрать его нельзя.',
      HttpStatus.BAD_REQUEST,
    );
  }
}

// ---------------------------------------------------------------------------
// Cut release policy (Stage 3 «Мастер цеха», см.
// `apps/api/src/modules/cut-release-policy/*`,
// `apps/api/src/modules/passports/passports.service.ts`).
// ---------------------------------------------------------------------------

/**
 * Активная политика выдачи кроя (`CutReleasePolicy.isActive = true`)
 * не разрешает выдать данный паспорт сотруднику. Срабатывает в
 * `PassportsService.issueToEmployee` ТОЛЬКО для первой операции
 * маршрута (`currentRouteStepIndex === 0`) или операций категории
 * `CUTTING`. Не блокирует движение паспорта `scan`/`complete-operation`
 * по дальнейшему маршруту — это сознательная граница Stage 3.
 *
 * Сообщение формируется сервисом динамически из самой политики
 * (цвет / размер / лимит), без префикса `[CODE]` со стороны UI —
 * фронт показывает его строго как inline-message
 * (см. `apps/web/app/work/seamstress-active-panel.tsx`,
 * `apps/web/app/work/actions.ts::explainApiError`).
 */
export class CutReleasePolicyViolationException extends BusinessException {
  constructor(message: string) {
    super('CUT_RELEASE_POLICY_VIOLATION', message, HttpStatus.CONFLICT);
  }
}

// ---------------------------------------------------------------------------
// Order cut issue rules (Очередь выдачи кроя по размерам, см.
// `apps/api/src/modules/order-cut-issue-rules/*`,
// `apps/api/src/modules/passports/passports.service.ts`,
// `prisma/schema.prisma::OrderCutIssueRule`).
// ---------------------------------------------------------------------------

/**
 * Активная очередь выдачи кроя (`OrderCutIssueRule`) по заказу не
 * разрешает выдать паспорт этого размера сейчас. Срабатывает в
 * `PassportsService.issueToEmployee` ТОЛЬКО для первой операции
 * маршрута (`currentRouteStepIndex === 0`) или операций категории
 * `CUTTING` — точно так же, как `CutReleasePolicy`. Дальнейшее
 * движение паспорта по маршруту (`scan` / `complete-operation`) НЕ
 * блокируется.
 *
 * Сообщение формируется сервисом динамически из активных
 * незавершённых строк очереди (см.
 * `formatOrderCutIssueRuleViolationMessage`) — UI показывает его
 * «как есть», без префикса `[CODE] ` (см.
 * `apps/web/app/work/actions.ts::RAW_API_ERROR_CODES`).
 */
export class OrderCutIssueRuleViolationException extends BusinessException {
  constructor(message: string) {
    super('ORDER_CUT_ISSUE_RULE_VIOLATION', message, HttpStatus.CONFLICT);
  }
}

/**
 * Запрошенная строка очереди выдачи кроя не существует (или была
 * удалена параллельным процессом). Используется одиночными PATCH/
 * DELETE-эндпоинтами по конкретному `ruleId` — на MVP их пока нет,
 * но класс готов: bulk-upsert и disable-all без отдельного 404 не
 * обходятся.
 */
export class OrderCutIssueRuleNotFoundException extends BusinessException {
  constructor() {
    super(
      'ORDER_CUT_ISSUE_RULE_NOT_FOUND',
      'Строка очереди выдачи кроя не найдена',
      HttpStatus.NOT_FOUND,
    );
  }
}

/**
 * В bulk-upsert менеджер указал `sizeId`, которого нет в строках
 * `OrderItem` этого заказа. Пускать такой ввод нельзя: правило
 * было бы заведомо «бесполезным» (паспортов этого размера в заказе
 * не появится), а UI этим прикрылся бы.
 */
export class OrderCutIssueRuleSizeNotInOrderException extends BusinessException {
  constructor(sizeCode?: string) {
    super(
      'ORDER_CUT_ISSUE_RULE_SIZE_NOT_IN_ORDER',
      sizeCode
        ? `Размер ${sizeCode} не входит в данный заказ — добавить его в очередь нельзя.`
        : 'Указанный размер не входит в данный заказ — добавить его в очередь нельзя.',
      HttpStatus.BAD_REQUEST,
    );
  }
}

/**
 * В bulk-upsert менеджер пытается уменьшить `requiredQty` ниже
 * уже накопленного `issuedQty`. Это сломало бы инвариант
 * `issuedQty <= requiredQty`, который держит и UI-прогресс, и
 * атомарный consume в `consumeInTx`. Вместо тихого «обрежем до
 * `issuedQty`» бросаем 422 — пусть менеджер сознательно решит,
 * деактивировать ли строку или поднять `requiredQty`.
 */
export class OrderCutIssueRuleRequiredBelowIssuedException extends BusinessException {
  constructor(sizeCode?: string) {
    super(
      'ORDER_CUT_ISSUE_RULE_REQUIRED_BELOW_ISSUED',
      sizeCode
        ? `Нельзя уменьшить «нужно» ниже уже выданного количества по размеру ${sizeCode}.`
        : 'Нельзя уменьшить «нужно» ниже уже выданного количества по этой строке.',
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
}

/**
 * `requiredQty` строки превышает плановое количество (`OrderItem.qtyPlan`)
 * по этому размеру. С учётом множественных очередей проверяется
 * суммарно по всем очередям заказа (Σ requiredQty по размеру не
 * должна превышать план). Пускать такой ввод нельзя: очередь
 * блокирует выдачу до выполнения, а выполнить «больше плана»
 * физически невозможно.
 */
export class OrderCutIssueRuleRequiredAbovePlanException extends BusinessException {
  constructor(sizeCode: string, qtyPlan: number, remainder?: number) {
    super(
      'ORDER_CUT_ISSUE_RULE_REQUIRED_ABOVE_PLAN',
      remainder !== undefined
        ? `Нельзя поставить в очередь больше, чем остаток плана по размеру ${sizeCode} (доступно ${remainder} из ${qtyPlan} шт).`
        : `Нельзя поставить в очередь больше, чем план по размеру ${sizeCode} (план ${qtyPlan} шт).`,
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
}

/**
 * Удалить очередь нельзя: либо она не последняя (нельзя удалять
 * «дырку» в середине), либо в ней уже что-то выдано
 * (`Σ issuedQty > 0`). Бросается из `DELETE /api/orders/:id/cut-issue-rules/queues/:queueIndex`.
 */
export class OrderCutIssueQueueDeleteNotAllowedException extends BusinessException {
  constructor(message: string) {
    super(
      'ORDER_CUT_ISSUE_QUEUE_DELETE_NOT_ALLOWED',
      message,
      HttpStatus.CONFLICT,
    );
  }
}

/**
 * Очередь с указанным `queueIndex` для заказа не существует.
 * Бросается из bulk-upsert / delete по `queueIndex`, на который нет
 * ни одной строки.
 */
export class OrderCutIssueQueueNotFoundException extends BusinessException {
  constructor(queueIndex: number) {
    super(
      'ORDER_CUT_ISSUE_QUEUE_NOT_FOUND',
      `Очередь №${queueIndex} не найдена для этого заказа.`,
      HttpStatus.NOT_FOUND,
    );
  }
}

// ---------------------------------------------------------------------------
// Patterns (Лекала, MVP-1, см. `apps/api/src/modules/patterns/*`,
// `prisma/schema.prisma::PatternItem`).
// ---------------------------------------------------------------------------

/**
 * Карточка лекала не найдена. Бросается из `PatternsService.get/update`
 * и из upload-эндпоинтов (`/api/patterns/:id/preview`,
 * `/api/patterns/:id/sizes/:sizeId/file`).
 */
export class PatternNotFoundException extends BusinessException {
  constructor() {
    super('PATTERN_NOT_FOUND', 'Лекало не найдено', HttpStatus.NOT_FOUND);
  }
}

/**
 * Дубликат `PatternItem.article`. Уникальность гарантирована БД
 * (`@unique`), но мы перехватываем P2002 в `PatternsService` и отдаём
 * бизнес-ошибку с понятным текстом и стабильным `code`, чтобы UI
 * мог подсветить именно поле «Артикул».
 */
export class PatternArticleTakenException extends BusinessException {
  constructor() {
    super(
      'PATTERN_ARTICLE_TAKEN',
      'Лекало с таким артикулом уже существует',
      HttpStatus.CONFLICT,
    );
  }
}

/**
 * `PatternSizeFile` не найден (используется в endpoint архивации
 * `DELETE /api/patterns/:id/sizes/:sizeId/file/:fileId`).
 */
export class PatternSizeFileNotFoundException extends BusinessException {
  constructor() {
    super(
      'PATTERN_SIZE_FILE_NOT_FOUND',
      'Файл лекала по этому размеру не найден',
      HttpStatus.NOT_FOUND,
    );
  }
}

/**
 * Размер из upload/material-areas-DTO не существует в справочнике
 * `Size`. Защита от подмены id — отдельная бизнес-ошибка вместо
 * общего 500.
 */
export class PatternSizeNotFoundException extends BusinessException {
  constructor() {
    super(
      'PATTERN_SIZE_NOT_FOUND',
      'Размер не найден в справочнике',
      HttpStatus.BAD_REQUEST,
    );
  }
}

/**
 * Загруженный файл не прошёл валидацию (расширение / mime / попытка
 * path-traversal в `originalname`). Сообщение формируется сервисом —
 * UI показывает его как inline-error на форме загрузки.
 */
export class PatternUploadInvalidException extends BusinessException {
  constructor(message: string) {
    super('PATTERN_UPLOAD_INVALID', message, HttpStatus.BAD_REQUEST);
  }
}

/**
 * Multipart-запрос пришёл без файла (поле `file` пустое или отсутствует).
 * Отдельная ошибка нужна, чтобы UI мог отличить «пустой submit» от
 * «формат не подошёл».
 */
export class PatternUploadMissingFileException extends BusinessException {
  constructor() {
    super(
      'PATTERN_UPLOAD_MISSING_FILE',
      'Файл не загружен — добавьте его в форме перед отправкой.',
      HttpStatus.BAD_REQUEST,
    );
  }
}

/**
 * Soft-pattern MVP (этап 2 «Лекала»): менеджер пытается выбрать
 * лекало с не-`ACTIVE` статусом при создании/обновлении заказа.
 * UI скрывает такие лекала из селекта, но прямой POST/PATCH
 * `/api/orders` блокируется отдельной 409-кой по аналогии с
 * `RouteTemplateInactiveException` / `TechCardInactiveException`.
 */
export class PatternInactiveException extends BusinessException {
  constructor() {
    super(
      'PATTERN_INACTIVE',
      'Лекало неактивно — выбрать его нельзя.',
      HttpStatus.CONFLICT,
    );
  }
}

/**
 * Soft-pattern MVP (этап 2 «Лекала»): после запуска заказа в
 * производство лекало «застыло» (snapshot полей зафиксирован), и
 * сменить `patternItemId` через PATCH нельзя — это нарушит инвариант
 * «уже запущенный заказ показывает snapshot, не новое лекало».
 *
 * Сценарий ловится общим ORDER_LOCKED guard в `OrdersService.update`
 * (поле «потенциально опасное», как `routeTemplateId`/`techCardId`),
 * а отдельный код этой 409-ки полезен, если фронту в будущем
 * захочется адресной подсказки именно про лекало. На MVP не
 * выбрасывается напрямую — оставлено как зарезервированный код для
 * параллельной диагностики.
 */
export class OrderPatternAlreadyStartedException extends BusinessException {
  constructor() {
    super(
      'ORDER_PATTERN_ALREADY_STARTED',
      'У заказа уже зафиксирован snapshot лекала — переназначить лекало нельзя.',
      HttpStatus.CONFLICT,
    );
  }
}

// ---------------------------------------------------------------------------
// Pattern categories (Этап «Категории номенклатуры», см.
// `apps/api/src/modules/pattern-categories/*`,
// `prisma/schema.prisma::PatternCategory` / `PatternCategoryParameter`).
// ---------------------------------------------------------------------------

/**
 * Карточка категории номенклатуры не найдена. Бросается из
 * `PatternCategoriesService.get/update/replaceParameters/archive`,
 * а также из `PatternsService.create/update`, если менеджер указал
 * несуществующий `categoryId`.
 */
export class PatternCategoryNotFoundException extends BusinessException {
  constructor() {
    super(
      'PATTERN_CATEGORY_NOT_FOUND',
      'Категория номенклатуры не найдена',
      HttpStatus.NOT_FOUND,
    );
  }
}

/**
 * Менеджер пытается привязать карточку лекала к архивной категории
 * (`status != ACTIVE`). UI её не показывает, но прямой POST/PATCH
 * `/api/patterns` блокируется этой 409-кой.
 */
export class PatternCategoryInactiveException extends BusinessException {
  constructor() {
    super(
      'PATTERN_CATEGORY_INACTIVE',
      'Категория архивирована — выбрать её нельзя.',
      HttpStatus.CONFLICT,
    );
  }
}

/**
 * Дубликат `PatternCategory.slug`. Уникальность гарантирована БД
 * (`@unique`), но мы перехватываем P2002 в `PatternCategoriesService`
 * и отдаём бизнес-ошибку, чтобы UI мог подсветить именно поле «slug»
 * (или подсказать сгенерировать другой slug).
 */
export class PatternCategorySlugTakenException extends BusinessException {
  constructor() {
    super(
      'PATTERN_CATEGORY_SLUG_TAKEN',
      'Категория с таким slug уже существует',
      HttpStatus.CONFLICT,
    );
  }
}

/**
 * Этап «Категории номенклатуры»: при сохранении площадей материалов
 * (`PUT /api/patterns/:id/material-areas`) указан `materialRole`,
 * которого нет в активных параметрах категории лекала. Сообщение
 * формируется сервисом и содержит конкретный roleKey + список
 * допустимых ключей категории — UI рисует inline-error на форме.
 */
export class PatternMaterialRoleNotInCategoryException extends BusinessException {
  constructor(message: string) {
    super(
      'PATTERN_MATERIAL_ROLE_NOT_IN_CATEGORY',
      message,
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
}

/**
 * Этап «Фурнитура и нормы»: при сохранении норм
 * (`PUT /api/patterns/:id/parameter-norms`) передан
 * `categoryParameterId`, который:
 *   - не существует, или
 *   - принадлежит другой категории (не той, что у лекала), или
 *   - имеет `inputType != QTY_PER_ITEM` (например, AREA_M2_BY_SIZE
 *     — площади хранятся в `PatternMaterialArea`, а не как нормы),
 *   - архивирован (`status != ACTIVE`).
 *
 * Сообщение формируется сервисом и содержит конкретный
 * `categoryParameterId` + причину — UI рисует inline-error на
 * форме «Фурнитура и нормы».
 */
export class PatternParameterNormNotAllowedException extends BusinessException {
  constructor(message: string) {
    super(
      'PATTERN_PARAMETER_NORM_NOT_ALLOWED',
      message,
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
}

/**
 * Этап «Погонные метры по размерам»: при сохранении значений
 * (`PUT /api/patterns/:id/size-parameter-values`) передан
 * `categoryParameterId`, который:
 *   - не существует, или
 *   - принадлежит другой категории (не той, что у лекала), или
 *   - имеет `inputType != LINEAR_M_BY_SIZE` (на MVP таблица
 *     `PatternItemSizeParameterValue` хранит только погонные метры
 *     — для AREA_M2_BY_SIZE есть `PatternMaterialArea`, для
 *     QTY_PER_ITEM — `PatternItemParameterNorm`),
 *   - архивирован (`status != ACTIVE`).
 *
 * Аналог `PatternParameterNormNotAllowedException` для блока
 * «Погонные метры». UI рисует inline-error на форме «Погонные метры»
 * в карточке лекала.
 */
export class PatternSizeParameterValueNotAllowedException extends BusinessException {
  constructor(message: string) {
    super(
      'PATTERN_SIZE_PARAMETER_VALUE_NOT_ALLOWED',
      message,
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
}

// ---------------------------------------------------------------------------
// Workshop needs (Этап 4А, см. `apps/api/src/modules/workshop-needs/*`,
// `prisma/schema.prisma::WorkshopNeed`).
// ---------------------------------------------------------------------------

/**
 * Потребность цеха не найдена. Бросается из `WorkshopNeedsService.get`
 * / `update` / `cancel`.
 */
export class WorkshopNeedNotFoundException extends BusinessException {
  constructor() {
    super(
      'WORKSHOP_NEED_NOT_FOUND',
      'Потребность цеха не найдена',
      HttpStatus.NOT_FOUND,
    );
  }
}

/**
 * Расчёт потребностей заказа без `force`, но у заказа уже есть строки
 * в статусе не-`CALCULATED` (`REVIEWED` / `PURCHASE_PLANNED`). Чтобы
 * не потерять ручные правки закупщика, расчёт блокируется до
 * принудительного `force: true` (UI должен явно подтвердить).
 */
export class WorkshopNeedsAlreadyReviewedException extends BusinessException {
  constructor() {
    super(
      'WORKSHOP_NEEDS_ALREADY_REVIEWED',
      'Есть проверенные потребности. Пересчёт может удалить ручные данные. Используйте force-пересчёт, если уверены.',
      HttpStatus.CONFLICT,
    );
  }
}

/**
 * Пересчёт потребности заказа удаляет и пересоздаёт системные строки
 * `WorkshopNeed` с новыми id. Если по строке уже прошли складские
 * движения (`StockMovement` — приёмка / расход материала), удаление
 * снесло бы каскадом (`onDelete: Cascade`) её `StockBalance` и весь
 * журнал движений, молча обнулив физический остаток на складе (при этом
 * документы приёмки/расхода намеренно переживают удаление — `SetNull`).
 * Блокируем пересчёт: сначала нужно разобраться с уже принятым/выданным
 * материалом.
 */
export class WorkshopNeedsHaveStockException extends BusinessException {
  constructor() {
    super(
      'WORKSHOP_NEEDS_HAVE_STOCK',
      'По потребностям этого заказа уже есть складские движения (приёмка или расход материала). Пересчёт удалил бы физический остаток на складе. Сначала обработайте принятый/выданный материал (или отмените соответствующие приёмки/расходы), затем повторите расчёт.',
      HttpStatus.CONFLICT,
    );
  }
}

/**
 * Не из чего считать потребность заказа. Универсальный код, конкретику
 * передаём в message — менеджер сразу видит, что именно поправить:
 *   - техкарта выбрана, но пустая (нет TechCardMaterialLine-ов);
 *   - лекало без заполненных параметров (нет PatternMaterialArea-ов,
 *     PatternItemParameterNorm-ов и PatternItemSizeParameterValue-ов),
 *     при том что категория тоже не помогает (см. `isCategoryDriven`);
 *   - вообще ничего не привязано (исторический generic-кейс).
 *
 * Конкретный текст конструируется в
 * `WorkshopNeedsService.calculateForOrder` на месте throw, чтобы
 * сообщение знало `techCardId`/`patternItemId` контекста.
 */
export class WorkshopNeedCalculationSourceException extends BusinessException {
  constructor(
    message: string = 'Для расчёта потребности нужна техкарта или snapshot материалов.',
  ) {
    super(
      'WORKSHOP_NEED_SOURCE_REQUIRED',
      message,
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
}

/**
 * У заказа нет позиций или все `qtyPlan = 0`. Без размерной матрицы
 * чистую потребность считать не на чём.
 */
export class WorkshopNeedOrderItemsRequiredException extends BusinessException {
  constructor() {
    super(
      'WORKSHOP_NEED_ORDER_ITEMS_REQUIRED',
      'У заказа нет позиций или все плановые количества равны нулю — считать нечего.',
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
}

// ---------------------------------------------------------------------------
// Suppliers (Этап 5, см. `apps/api/src/modules/suppliers/*`,
// `prisma/schema.prisma::Supplier`).
// ---------------------------------------------------------------------------

/**
 * Карточка поставщика не найдена. Бросается из `SuppliersService.get/update`,
 * а также из `WorkshopNeedsService.update`, если закупщик указал
 * несуществующий `selectedSupplierId`.
 */
export class SupplierNotFoundException extends BusinessException {
  constructor() {
    super('SUPPLIER_NOT_FOUND', 'Поставщик не найден', HttpStatus.NOT_FOUND);
  }
}

/**
 * Закупщик пытается привязать `WorkshopNeed` к деактивированной
 * карточке поставщика (`status != ACTIVE`). UI скрывает таких в
 * селекте, но прямой PATCH `/api/workshop-needs/:id` блокируется
 * этой 409-кой по аналогии с `ClientInactiveException`.
 */
export class SupplierInactiveException extends BusinessException {
  constructor() {
    super(
      'SUPPLIER_INACTIVE',
      'Поставщик неактивен — выбрать его нельзя.',
      HttpStatus.CONFLICT,
    );
  }
}

/**
 * Удаление поставщика заблокировано: на него выписаны заказы
 * поставщику (`PurchaseOrder`, hard-FK `onDelete: Restrict`). Чтобы не
 * «потерять» закупочные документы, физическое удаление запрещаем —
 * предлагаем архивировать карточку (`status = INACTIVE`). Контакты и
 * каталог удаляются каскадом, поэтому блокируем только по PO.
 */
export class SupplierHasPurchaseOrdersException extends BusinessException {
  constructor(count: number) {
    super(
      'SUPPLIER_HAS_PURCHASE_ORDERS',
      `Нельзя удалить поставщика: на него выписано заказов — ${count}. ` +
        'Архивируйте карточку (статус «Неактивен») вместо удаления.',
      HttpStatus.CONFLICT,
    );
  }
}

/**
 * Контакт поставщика не найден. Бросается из
 * `SuppliersService.updateContact/deleteContact`, либо когда указан
 * `contactId`, не принадлежащий заданному `supplierId`.
 */
export class SupplierContactNotFoundException extends BusinessException {
  constructor() {
    super(
      'SUPPLIER_CONTACT_NOT_FOUND',
      'Контакт поставщика не найден',
      HttpStatus.NOT_FOUND,
    );
  }
}

/**
 * Позиция каталога поставщика не найдена. Бросается из
 * `SuppliersService.updateCatalogItem/archiveCatalogItem`, либо когда
 * `itemId` не принадлежит указанному `supplierId`, либо при попытке
 * привязать `WorkshopNeed` к несуществующему
 * `selectedSupplierCatalogItemId`.
 */
export class SupplierCatalogItemNotFoundException extends BusinessException {
  constructor() {
    super(
      'SUPPLIER_CATALOG_ITEM_NOT_FOUND',
      'Позиция каталога поставщика не найдена',
      HttpStatus.NOT_FOUND,
    );
  }
}

/**
 * Закупщик пытается выбрать архивную позицию каталога
 * (`status != ACTIVE`) в `WorkshopNeed`. UI её не показывает, но
 * прямой PATCH блокируется отдельной 409-кой.
 */
export class SupplierCatalogItemInactiveException extends BusinessException {
  constructor() {
    super(
      'SUPPLIER_CATALOG_ITEM_INACTIVE',
      'Позиция каталога архивирована — выбрать её нельзя.',
      HttpStatus.CONFLICT,
    );
  }
}

/**
 * `selectedSupplierCatalogItemId` принадлежит другому поставщику,
 * не тому, что выбран в `selectedSupplierId`. Защищает от рассинхрона:
 * UI всегда подгружает каталог под выбранного поставщика, но прямой
 * PATCH с произвольной парой id блокируется этой 400-кой.
 */
export class SupplierCatalogItemSupplierMismatchException extends BusinessException {
  constructor() {
    super(
      'SUPPLIER_CATALOG_ITEM_SUPPLIER_MISMATCH',
      'Позиция каталога принадлежит другому поставщику.',
      HttpStatus.BAD_REQUEST,
    );
  }
}

// ---------------------------------------------------------------------------
// Purchase orders (Этап 6А, см. `apps/api/src/modules/purchase-orders/*`,
// `prisma/schema.prisma::PurchaseOrder`).
// ---------------------------------------------------------------------------

/**
 * Закупочный документ (`PurchaseOrder`) не найден. Бросается из
 * `PurchaseOrdersService.get/update/send/confirm/cancel`.
 */
export class PurchaseOrderNotFoundException extends BusinessException {
  constructor() {
    super(
      'PURCHASE_ORDER_NOT_FOUND',
      'Заказ поставщику не найден',
      HttpStatus.NOT_FOUND,
    );
  }
}

/**
 * Строка закупочного документа (`PurchaseOrderLine`) не найдена ни
 * для указанного `:id` (заказа), ни для `:lineId`.
 */
export class PurchaseOrderLineNotFoundException extends BusinessException {
  constructor() {
    super(
      'PURCHASE_ORDER_LINE_NOT_FOUND',
      'Строка заказа поставщику не найдена',
      HttpStatus.NOT_FOUND,
    );
  }
}

/**
 * `POST /api/purchase-orders/from-needs` пришёл с пустым массивом
 * `workshopNeedIds`. Без потребности создавать PO нечего.
 */
export class PurchaseOrderNeedsRequiredException extends BusinessException {
  constructor() {
    super(
      'PURCHASE_ORDER_NEEDS_REQUIRED',
      'Нужна хотя бы одна потребность для создания заказа поставщику.',
      HttpStatus.BAD_REQUEST,
    );
  }
}

/**
 * Хотя бы у одной потребности из набора не задан `selectedSupplierId`.
 * UI должен скрывать кнопку «Создать заказ поставщику» в этом случае,
 * но мы дополнительно блокируем прямой POST.
 */
export class PurchaseOrderNeedsSupplierRequiredException extends BusinessException {
  constructor() {
    super(
      'PURCHASE_ORDER_NEEDS_SUPPLIER_REQUIRED',
      'У всех потребностей должен быть выбран поставщик из справочника.',
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
}

/**
 * В наборе потребностей встречаются разные `selectedSupplierId`.
 * На MVP один PO = один поставщик.
 */
export class PurchaseOrderNeedsDifferentSuppliersException extends BusinessException {
  constructor() {
    super(
      'PURCHASE_ORDER_NEEDS_DIFFERENT_SUPPLIERS',
      'Все потребности должны быть от одного поставщика.',
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
}

/**
 * В наборе потребностей встречаются разные `orderId`. На MVP мы
 * запрещаем смешивать потребности разных заказов покупателя — иначе
 * `customerOrderId` PO становится бессмысленным.
 */
export class PurchaseOrderNeedsDifferentOrdersException extends BusinessException {
  constructor() {
    super(
      'PURCHASE_ORDER_NEEDS_DIFFERENT_ORDERS',
      'Все потребности должны быть из одного заказа покупателя.',
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
}

/**
 * По одной из потребностей уже есть активная `PurchaseOrderLine`
 * (`DRAFT`/`SENT`/`CONFIRMED`). Дубль создавать не разрешаем —
 * иначе можно случайно «заказать дважды».
 */
export class PurchaseOrderNeedAlreadyOrderedException extends BusinessException {
  constructor() {
    super(
      'PURCHASE_ORDER_NEED_ALREADY_ORDERED',
      'По одной из потребностей уже есть активный заказ поставщику.',
      HttpStatus.CONFLICT,
    );
  }
}

/**
 * У одной из потребностей не заполнено `purchaseQty`. Без явного
 * количества к закупке создавать строку PO нечего.
 */
export class PurchaseOrderNeedPurchaseQtyRequiredException extends BusinessException {
  constructor() {
    super(
      'PURCHASE_ORDER_NEED_PURCHASE_QTY_REQUIRED',
      'У всех потребностей должно быть заполнено «К закупке».',
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
}

/**
 * Недопустимый переход статуса PO. На MVP допустимы:
 *   DRAFT → SENT, DRAFT → CONFIRMED, DRAFT → CANCELLED
 *   SENT → CONFIRMED, SENT → CANCELLED
 *   CONFIRMED → CANCELLED
 * Любой откат (SENT → DRAFT, CONFIRMED → SENT, …) запрещён.
 */
export class PurchaseOrderInvalidStatusTransitionException extends BusinessException {
  constructor(message: string) {
    super(
      'PURCHASE_ORDER_INVALID_STATUS_TRANSITION',
      message,
      HttpStatus.CONFLICT,
    );
  }
}

/**
 * Откат статуса PO на шаг назад (`reopen`: CONFIRMED → SENT,
 * SENT → DRAFT) запрещён, потому что по заказу уже есть проведённая
 * приёмка. Сначала отмените приёмки, потом откатывайте статус.
 */
export class PurchaseOrderHasReceiptsException extends BusinessException {
  constructor() {
    super(
      'PURCHASE_ORDER_HAS_RECEIPTS',
      'По заказу уже есть проведённые приёмки — сначала отмените их, затем откатывайте статус.',
      HttpStatus.CONFLICT,
    );
  }
}

// ---------------------------------------------------------------------------
// Supplier payment requests (заявки на оплату поставщику, см.
// `apps/api/src/modules/supplier-payment-requests/*`,
// `prisma/schema.prisma::SupplierPaymentRequest`).
// ---------------------------------------------------------------------------

/**
 * Заявка на оплату (`SupplierPaymentRequest`) не найдена. Бросается из
 * `SupplierPaymentRequestsService.get`.
 */
export class SupplierPaymentRequestNotFoundException extends BusinessException {
  constructor() {
    super(
      'SUPPLIER_PAYMENT_REQUEST_NOT_FOUND',
      'Заявка на оплату не найдена',
      HttpStatus.NOT_FOUND,
    );
  }
}

/**
 * Невалидное вложение заявки на оплату (нет имени файла, пустой файл,
 * превышен лимит размера и т.п.). Бросается из
 * `SupplierPaymentRequestsStorageService`.
 */
export class SupplierPaymentRequestFileInvalidException extends BusinessException {
  constructor(message: string) {
    super(
      'SUPPLIER_PAYMENT_REQUEST_FILE_INVALID',
      message,
      HttpStatus.BAD_REQUEST,
    );
  }
}

/**
 * Редактирование заявки на оплату пересоздаёт этапы целиком. Если по
 * этапу уже создана и СОГЛАСОВАНА либо ОПЛАЧЕНА «заявка на расход»
 * (`SupplierPayment` в статусе APPROVED/PAID), пересоздание этапов
 * оставило бы её осиротевшей на старой сумме — казначейство оплатило бы
 * устаревшее. Блокируем правку: сначала отмените заявку на расход.
 * (Черновики — `DRAFT` — правка пересобирает автоматически.)
 */
export class SupplierPaymentRequestHandedOffException extends BusinessException {
  constructor() {
    super(
      'SUPPLIER_PAYMENT_REQUEST_HANDED_OFF',
      'Заявка уже передана в казначейство и согласована или оплачена. Отредактировать сумму или этапы нельзя — сначала отмените связанную заявку на расход.',
      HttpStatus.CONFLICT,
    );
  }
}

// ---------------------------------------------------------------------------
// Purchase receipts (Этап 7А, см.
// `apps/api/src/modules/purchase-receipts/*`,
// `prisma/schema.prisma::PurchaseReceipt` / `PurchaseReceiptLine`).
// ---------------------------------------------------------------------------

/**
 * Документ приёмки (`PurchaseReceipt`) не найден. Бросается из
 * `PurchaseReceiptsService.get/cancel`.
 */
export class PurchaseReceiptNotFoundException extends BusinessException {
  constructor() {
    super(
      'PURCHASE_RECEIPT_NOT_FOUND',
      'Документ приёмки не найден',
      HttpStatus.NOT_FOUND,
    );
  }
}

/**
 * `POST /api/purchase-receipts/from-purchase-order` пришёл с пустым
 * массивом `lines`. Без строк создавать документ нечего.
 */
export class PurchaseReceiptLinesRequiredException extends BusinessException {
  constructor() {
    super(
      'PURCHASE_RECEIPT_LINES_REQUIRED',
      'Нужна хотя бы одна строка приёмки.',
      HttpStatus.BAD_REQUEST,
    );
  }
}

/**
 * Принимать можно только PO в `SENT`/`CONFIRMED`/`PARTIALLY_RECEIVED`
 * (см. `PURCHASE_ORDER_RECEIVABLE_STATUSES`). DRAFT, RECEIVED
 * (полностью закрытый), CANCELLED — отдают эту 409.
 */
export class PurchaseReceiptInvalidPurchaseOrderStatusException extends BusinessException {
  constructor(status: string) {
    super(
      'PURCHASE_RECEIPT_INVALID_PURCHASE_ORDER_STATUS',
      `Принимать можно только заказ поставщику в статусе SENT, CONFIRMED или PARTIALLY_RECEIVED. Текущий статус: ${status}.`,
      HttpStatus.CONFLICT,
    );
  }
}

/**
 * `purchaseOrderLineId` из тела запроса не принадлежит указанному
 * `purchaseOrderId` (или строка не существует, или относится к
 * другому PO).
 */
export class PurchaseReceiptLineNotInOrderException extends BusinessException {
  constructor() {
    super(
      'PURCHASE_RECEIPT_LINE_NOT_IN_ORDER',
      'Строка не относится к этому заказу поставщику.',
      HttpStatus.BAD_REQUEST,
    );
  }
}

/**
 * `receivedQty` строки ≤ 0. Zod-схема ловит это на уровне DTO, но
 * отдельный код полезен, если в будущем добавятся пути в обход
 * `ZodValidationPipe` (например, server-to-server).
 */
export class PurchaseReceiptQtyRequiredException extends BusinessException {
  constructor() {
    super(
      'PURCHASE_RECEIPT_QTY_REQUIRED',
      'У всех строк приёмки должно быть указано количество > 0.',
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
}

/**
 * Указанная `cellId` не существует. Активность ячейки на MVP не
 * блокируем — приёмка в неактивную ячейку не считается ошибкой
 * (закупщик мог оформить документ задним числом).
 */
export class PurchaseReceiptCellNotFoundException extends BusinessException {
  constructor() {
    super(
      'PURCHASE_RECEIPT_CELL_NOT_FOUND',
      'Указанная ячейка не найдена.',
      HttpStatus.NOT_FOUND,
    );
  }
}

/**
 * Суммарное `Σ receivedQty` по строке PO (включая эту приёмку)
 * превысило целевой `confirmedQty ?? qty`. Защита от переприёмки:
 * нельзя принять больше, чем заказано/подтверждено и ещё не принято.
 */
export class PurchaseReceiptOverReceiptException extends BusinessException {
  constructor(itemName: string, remaining: string, unit: string) {
    super(
      'PURCHASE_RECEIPT_OVER_RECEIPT',
      `Нельзя принять больше, чем осталось по заказу. «${itemName}»: к приёмке доступно ${remaining} ${unit}.`,
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
}

/**
 * Попытка отредактировать строку приёмки в недопустимом состоянии:
 *   - документ `CANCELLED` (правка отменённой приёмки запрещена);
 *   - документ `POSTED`, а правится складское поле (`receivedQty`/
 *     `cellId`) — это рассинхронит `StockMovement`. У проведённого
 *     документа меняем только нескладские метаданные; чтобы
 *     поправить количество/ячейку — отмените приёмку и оформите заново.
 */
export class PurchaseReceiptNotEditableException extends BusinessException {
  constructor(message: string) {
    super(
      'PURCHASE_RECEIPT_NOT_EDITABLE',
      message,
      HttpStatus.CONFLICT,
    );
  }
}

/**
 * Провести (`POST /api/purchase-receipts/:id/post`) можно только
 * документ в статусе `DRAFT`. POSTED/CANCELLED отдают эту 409.
 */
export class PurchaseReceiptNotDraftException extends BusinessException {
  constructor(status: string) {
    super(
      'PURCHASE_RECEIPT_NOT_DRAFT',
      `Провести можно только черновик приёмки. Текущий статус: ${status}.`,
      HttpStatus.CONFLICT,
    );
  }
}

// ---------------------------------------------------------------------------
// Company settings & divisions (управленческий справочник «Настройки
// компании», см. `apps/api/src/modules/company-settings/*`,
// `prisma/schema.prisma::CompanySettings` / `CompanyDivision`).
// ---------------------------------------------------------------------------

/**
 * Подразделение компании не найдено. Бросается из
 * `CompanyDivisionsService.get/update`.
 */
export class CompanyDivisionNotFoundException extends BusinessException {
  constructor() {
    super(
      'COMPANY_DIVISION_NOT_FOUND',
      'Подразделение не найдено',
      HttpStatus.NOT_FOUND,
    );
  }
}

/**
 * Дубликат `CompanyDivision.code`. Уникальность гарантирована БД, но
 * перехватываем P2002 в `CompanyDivisionsService` и отдаём бизнес-
 * ошибку с понятным текстом и стабильным `code`, чтобы UI мог
 * подсветить именно поле «Код».
 */
export class CompanyDivisionCodeTakenException extends BusinessException {
  constructor() {
    super(
      'COMPANY_DIVISION_CODE_TAKEN',
      'Подразделение с таким кодом уже существует',
      HttpStatus.CONFLICT,
    );
  }
}

/**
 * Попытка привязать карточку (например, `Employee` в PHASE 2 STEP 2)
 * к soft-deleted (`isActive = false`) подразделению.
 *
 * Менеджер увидит сообщение и сможет либо включить подразделение
 * обратно через `/admin/company-settings`, либо выбрать активное.
 */
export class CompanyDivisionInactiveException extends BusinessException {
  constructor() {
    super(
      'COMPANY_DIVISION_INACTIVE',
      'Подразделение отключено — выберите активное или включите его обратно',
      HttpStatus.CONFLICT,
    );
  }
}

// ---------------------------------------------------------------------------
// Payroll payouts (PHASE 3, см.
// `apps/api/src/modules/payroll-payouts/*`,
// `prisma/schema.prisma::PayrollPayout` / `PayrollPayoutLine`,
// `packages/shared/src/payroll-payouts.ts`).
// ---------------------------------------------------------------------------

/**
 * Карточка выплаты `PayrollPayout` не найдена. Бросается из
 * `PayrollPayoutsService.get/recompute/issue/ack/cancel`. Тот же код
 * сервис возвращает обычному сотруднику, который пытается прочитать
 * чужую выплату — UI этой роли «чужой документ не существует»,
 * 403 нарочно не отдаём, чтобы не утекали id.
 */
export class PayrollPayoutNotFoundException extends BusinessException {
  constructor() {
    super(
      'PAYROLL_PAYOUT_NOT_FOUND',
      'Выплата не найдена',
      HttpStatus.NOT_FOUND,
    );
  }
}

/**
 * Недопустимый переход статуса выплаты. На MVP допустимы:
 *   DRAFT → ISSUED (recompute + issue),
 *   DRAFT → CANCELLED,
 *   ISSUED → ACKNOWLEDGED,
 *   ISSUED → CANCELLED.
 * Любой другой переход (например, попытка `recompute` после ISSUED,
 * `cancel` после ACKNOWLEDGED, повторный `issue` или `ack` от
 * другого сотрудника) отдаёт эту 409 с конкретным сообщением.
 */
export class PayrollPayoutInvalidTransitionException extends BusinessException {
  constructor(message: string) {
    super(
      'PAYROLL_PAYOUT_INVALID_TRANSITION',
      message,
      HttpStatus.CONFLICT,
    );
  }
}

/**
 * Подтверждать получение выплаты (`POST /api/payroll/payouts/:id/ack`)
 * имеет право только сам сотрудник-получатель. Если запрос пришёл
 * от любой другой роли (включая `SHOP_MANAGER`/`ADMIN`) и
 * `viewer.employeeId !== payout.employeeId` — отдаём 403, чтобы
 * менеджер случайно не «расписался» за работника.
 */
export class PayrollPayoutForbiddenAckException extends BusinessException {
  constructor() {
    super(
      'PAYROLL_PAYOUT_FORBIDDEN_ACK',
      'Подтвердить получение выплаты может только сам сотрудник-получатель.',
      HttpStatus.FORBIDDEN,
    );
  }
}

/**
 * Активный инвариант PHASE 3: одна и та же `OperationEntry` /
 * `SalaryEntry` не может попасть сразу в две не-`CANCELLED`
 * выплаты (`DRAFT` / `ISSUED` / `ACKNOWLEDGED`). На уровне БД
 * `@@unique` на `operationEntryId` / `salaryEntryId` сознательно
 * НЕ ставится — после `CANCELLED` строка снова доступна. Сервис
 * `PayrollPayoutsService.collectLines` проверяет конфликт перед
 * созданием/обновлением `PayrollPayoutLine` и бросает эту 422.
 */
export class PayrollPayoutLineAlreadyIncludedException extends BusinessException {
  constructor(message: string) {
    super(
      'PAYROLL_PAYOUT_LINE_ALREADY_INCLUDED',
      message,
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
}

/**
 * PHASE 3 STEP 3 — lock-by-line. Начисление (`SalaryEntry` или
 * `OperationEntry`) уже включено в `PayrollPayoutLine` выплаты со
 * статусом `ISSUED` или `ACKNOWLEDGED`. Менять такое начисление
 * нельзя — изменение «уехавшей» в выплату суммы сломало бы snapshot
 * `PayrollPayout` и доверие сотрудника к расчётному листу
 * («сумма после подтверждения вдруг другая»).
 *
 * Что блокирует:
 *   - `PATCH /api/salary/:id` (включая `reset = true`): если
 *     `SalaryEntry` есть в выплате со статусом `ISSUED`/`ACKNOWLEDGED`.
 *
 * Что НЕ блокирует:
 *   - выплаты в `DRAFT` (черновик): пересборка строк ещё допустима,
 *     никаких обязательств перед сотрудником ещё не зафиксировано;
 *   - выплаты в `CANCELLED`: snapshot сознательно снят, строка снова
 *     свободна (тот же контракт, что и для активной уникальности —
 *     см. `PAYROLL_PAYOUT_LINE_ALREADY_INCLUDED`);
 *   - автоматический `SalaryService.syncDailySalary` (`start/stop
 *     shift`): обнаружив locked-запись, делает silent skip, чтобы не
 *     ломать сменный flow ради «правильного» оклада за уже выплаченный
 *     день — менеджер увидит расхождение в audit и решит сам.
 *
 * `OperationEntry` на MVP write-once + approve-only: единственный
 * post-create write в коде — `EarningsService.approvePendingForPassport`
 * (PENDING_RELEASE → APPROVED при `PackingService.close`), а pending
 * сдельщина в payout snapshot не входит. Поэтому отдельный guard для
 * операций пока не нужен; класс зарезервирован и будет использован,
 * как только появится ручная правка/отмена `OperationEntry`.
 */
export class PayrollLockedException extends BusinessException {
  constructor(
    message = 'Начисление уже включено в выплату и не может быть изменено.',
  ) {
    super('PAYROLL_LOCKED', message, HttpStatus.CONFLICT);
  }
}

// ---------------------------------------------------------------------------
// PayrollAccrualDocument (PHASE 3 STEP 6)
// ---------------------------------------------------------------------------

/**
 * Документ начисления зарплаты (`PayrollAccrualDocument`) не найден.
 * `GET /api/payroll/accrual-documents/:id` при отсутствующем id.
 */
export class PayrollAccrualDocumentNotFoundException extends BusinessException {
  constructor() {
    super(
      'PAYROLL_ACCRUAL_DOCUMENT_NOT_FOUND',
      'Документ начисления зарплаты не найден.',
      HttpStatus.NOT_FOUND,
    );
  }
}

/**
 * Операция недопустима в текущем статусе `PayrollAccrualDocument`.
 * Например, `recompute`/`pay`/`cancel` на уже `PAID`/`CANCELLED`
 * документе.
 */
export class PayrollAccrualDocumentInvalidStateException extends BusinessException {
  constructor(message: string) {
    super(
      'PAYROLL_ACCRUAL_DOCUMENT_INVALID_STATE',
      message,
      HttpStatus.CONFLICT,
    );
  }
}

/**
 * Строка документа начисления (`PayrollAccrualDocumentLine`) не найдена
 * в указанном документе.
 * `PATCH /api/payroll/accrual-documents/:id/lines/:lineId`.
 */
export class PayrollAccrualDocumentLineNotFoundException extends BusinessException {
  constructor() {
    super(
      'PAYROLL_ACCRUAL_DOCUMENT_LINE_NOT_FOUND',
      'Строка документа начисления зарплаты не найдена.',
      HttpStatus.NOT_FOUND,
    );
  }
}

/**
 * При проводке документа (`pay`) одна или несколько строк
 * `OperationEntry`/`SalaryEntry` из snapshot уже входят в активную
 * выплату (`DRAFT`/`ISSUED`/`ACKNOWLEDGED`).
 */
export class PayrollAccrualLineAlreadyPaidException extends BusinessException {
  constructor(message: string) {
    super(
      'PAYROLL_ACCRUAL_LINE_ALREADY_PAID',
      message,
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
}

/**
 * Документ содержит строки с `manualAdjustRub != 0`, но
 * `PayrollPayoutLineKind` не содержит значения `ADJUSTMENT`.
 * Проводка заблокирована до расширения enum в STEP 6.3/6.4.
 */
export class PayrollAccrualManualAdjustNotSupportedException extends BusinessException {
  constructor() {
    super(
      'PAYROLL_ACCRUAL_MANUAL_ADJUST_NOT_SUPPORTED',
      'Ручные корректировки (manualAdjustRub ≠ 0) не могут быть перенесены ' +
        'в выплату: PayrollPayoutLineKind не содержит ADJUSTMENT. ' +
        'Обнулите корректировки или дождитесь STEP 6.3/6.4.',
      HttpStatus.CONFLICT,
    );
  }
}

/**
 * Снимок накопительного документа устарел: живые суммы начислений
 * (`OperationEntry`/`SalaryEntry`) разошлись с замороженными суммами строки —
 * например, брак / корректировка количества снизили сдельное начисление ПОСЛЕ
 * пересчёта документа. Проводка заблокирована (409), чтобы менеджер пересчитал
 * документ и перепроверил, а не выплатил устаревшую (обычно завышенную) сумму.
 */
export class PayrollAccrualDocumentStaleSnapshotException extends BusinessException {
  constructor(message: string) {
    super(
      'PAYROLL_ACCRUAL_DOCUMENT_STALE_SNAPSHOT',
      message,
      HttpStatus.CONFLICT,
    );
  }
}

// ---------------------------------------------------------------------------
// Material issues (Этап «Фактический расход материалов по заказу», см.
// `apps/api/src/modules/material-issues/*`,
// `prisma/schema.prisma::MaterialIssue` / `MaterialIssueLine`).
//
// MVP-итерация ограничена ручной фиксацией: НЕТ складских остатков,
// НЕТ движений (`StockMovement`), НЕТ FIFO/LIFO, НЕТ автосписания при
// выдаче кроя. POSTED-документ отменить нельзя.
// ---------------------------------------------------------------------------

/**
 * Документ фактического расхода (`MaterialIssue`) не найден.
 * Бросается из `MaterialIssuesService.getById/post/cancel`.
 */
export class MaterialIssueNotFoundException extends BusinessException {
  constructor() {
    super(
      'MATERIAL_ISSUE_NOT_FOUND',
      'Документ расхода материалов не найден',
      HttpStatus.NOT_FOUND,
    );
  }
}

/**
 * `passportId`, переданный в `CreateMaterialIssueDto`, существует, но
 * принадлежит другому заказу. На MVP мы запрещаем такие документы —
 * иначе аналитический slice «расход × заказ» становится бессмысленным
 * (паспорт уже привязан к своему заказу).
 */
export class MaterialIssuePassportNotInOrderException extends BusinessException {
  constructor() {
    super(
      'MATERIAL_ISSUE_PASSPORT_NOT_IN_ORDER',
      'Паспорт не относится к этому заказу',
      HttpStatus.BAD_REQUEST,
    );
  }
}

/**
 * Строка содержит `workshopNeedId`, но эта потребность принадлежит
 * другому заказу. По тем же соображениям, что
 * `MaterialIssuePassportNotInOrderException`.
 */
export class MaterialIssueWorkshopNeedNotInOrderException extends BusinessException {
  constructor() {
    super(
      'MATERIAL_ISSUE_WORKSHOP_NEED_NOT_IN_ORDER',
      'Потребность не относится к этому заказу',
      HttpStatus.BAD_REQUEST,
    );
  }
}

/**
 * `POST /api/material-issues` пришёл без строк (или с пустым массивом).
 * Создавать пустой документ нельзя — `totalCost` всегда суммируется
 * по строкам, а `lines` со стороны клиента — единственный источник
 * расхода.
 *
 * Zod-схема (`CreateMaterialIssueSchema`) ловит это первым на уровне
 * `min(1)`, но отдельный код полезен для server-to-server вызовов и
 * для адресного UI-сообщения.
 */
export class MaterialIssueLinesRequiredException extends BusinessException {
  constructor() {
    super(
      'MATERIAL_ISSUE_LINES_REQUIRED',
      'Нужна хотя бы одна строка расхода',
      HttpStatus.BAD_REQUEST,
    );
  }
}

/**
 * `issuedQty` строки <= 0. Zod-схема валидирует это первым, но
 * отдельный класс остаётся как server-side guard и для понятного
 * сообщения в UI.
 */
export class MaterialIssueQtyRequiredException extends BusinessException {
  constructor() {
    super(
      'MATERIAL_ISSUE_QTY_REQUIRED',
      'Количество расхода должно быть больше нуля',
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
}

/**
 * `unitCost` строки < 0. На MVP цена может быть нулевой (передача
 * списанной партии), но не отрицательной.
 */
export class MaterialIssueUnitCostInvalidException extends BusinessException {
  constructor() {
    super(
      'MATERIAL_ISSUE_UNIT_COST_INVALID',
      'Цена за единицу не может быть отрицательной',
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
}

/**
 * Строка не содержит `workshopNeedId` и не передаёт `description`
 * явно. Без описания строка теряет смысл — что списывали?
 */
export class MaterialIssueLineDescriptionRequiredException extends BusinessException {
  constructor() {
    super(
      'MATERIAL_ISSUE_LINE_DESCRIPTION_REQUIRED',
      'Укажите описание материала или выберите потребность из заказа',
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
}

/**
 * Строка не содержит `workshopNeedId` и не передаёт `unit` явно.
 * Без единицы измерения количество расхода неинтерпретируемо.
 */
export class MaterialIssueLineUnitRequiredException extends BusinessException {
  constructor() {
    super(
      'MATERIAL_ISSUE_LINE_UNIT_REQUIRED',
      'Укажите единицу измерения или выберите потребность из заказа',
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
}

/**
 * Попытка `POST /:id/post` для документа не в `DRAFT`. Повторное
 * проведение проведённого, отменённого или уже-проведённого
 * документа бессмысленно.
 */
export class MaterialIssueNotDraftForPostException extends BusinessException {
  constructor() {
    super(
      'MATERIAL_ISSUE_NOT_DRAFT_FOR_POST',
      'Провести можно только документ в статусе «Черновик»',
      HttpStatus.CONFLICT,
    );
  }
}

/**
 * Попытка `POST /:id/cancel` для документа в `CANCELLED`. Повторная
 * отмена бессмысленна. Для `POSTED` отдельная семантика —
 * `MaterialIssuePostedCannotCancelException` (см. ниже).
 */
export class MaterialIssueNotDraftForCancelException extends BusinessException {
  constructor() {
    super(
      'MATERIAL_ISSUE_NOT_DRAFT_FOR_CANCEL',
      'Отменить можно только документ в статусе «Черновик»',
      HttpStatus.CONFLICT,
    );
  }
}

/**
 * Попытка `POST /:id/cancel` для документа в `POSTED`. На MVP
 * проведённый документ нельзя отменить — это сознательное
 * ограничение (no `StockMovement` для отката). Если действительно
 * нужно «откатить» расход, в следующей итерации появится сторнирующий
 * документ.
 */
export class MaterialIssuePostedCannotCancelException extends BusinessException {
  constructor() {
    super(
      'MATERIAL_ISSUE_POSTED_CANNOT_CANCEL',
      'Проведённый документ расхода нельзя отменить в MVP',
      HttpStatus.CONFLICT,
    );
  }
}

/**
 * Попытка `POST /api/material-issues/:id/return` для документа,
 * не находящегося в `POSTED` (DRAFT / CANCELLED). Возврат имеет
 * смысл только для уже проведённого расхода — `DRAFT` отменяется
 * штатным `cancel`-ом, `CANCELLED` уже не повлиял на склад.
 *
 * Бросается `MaterialIssuesService.returnPostedIssue` (см.
 * `apps/api/src/modules/material-issues/material-issues.service.ts`).
 */
export class MaterialIssueReturnOnlyPostedException extends BusinessException {
  constructor() {
    super(
      'MATERIAL_ISSUE_RETURN_ONLY_POSTED',
      'Сторнировать можно только проведённый документ расхода',
      HttpStatus.CONFLICT,
    );
  }
}

/**
 * Попытка возврата проведённого документа, у которого все строки уже
 * полностью возвращены предыдущими `MaterialIssueReturn`. На MVP
 * полное сторно идемпотентно по `sourceKey`, но если клиент попробует
 * вызвать `POST /:id/return` с НОВЫМ `clientRequestId` после того, как
 * предыдущий полный возврат уже прошёл — мы возвращаем 409 с этим
 * кодом, а не пишем «пустой» документ возврата.
 */
export class MaterialIssueAlreadyReturnedException extends BusinessException {
  constructor() {
    super(
      'MATERIAL_ISSUE_ALREADY_RETURNED',
      'Документ расхода уже полностью сторнирован',
      HttpStatus.CONFLICT,
    );
  }
}

/**
 * Запрос частичного возврата с `materialIssueLineId`, который не
 * принадлежит указанному `MaterialIssue` (другая строка / опечатка
 * клиента / параллельный refresh после удаления). 409, чтобы UI
 * мог перезагрузить форму.
 *
 * Используется `MaterialIssuesService.returnPostedIssue` при
 * non-empty `dto.lines` (см. также DTO
 * `apps/api/src/modules/material-issues/dto/return-material-issue.dto.ts`).
 */
export class MaterialIssueReturnLineNotFoundException extends BusinessException {
  constructor(materialIssueLineId: string) {
    super(
      'MATERIAL_ISSUE_RETURN_LINE_NOT_FOUND',
      `Строка расхода ${materialIssueLineId} не принадлежит этому документу`,
      HttpStatus.CONFLICT,
    );
  }
}

/**
 * Запрос частичного возврата с `returnedQty`, превышающим остаток к
 * возврату (`issuedQty − Σ ранее возвращённое`). 409 с контекстом в
 * `details`, чтобы UI мог показать актуальный `availableQty`
 * пользователю и попросить уменьшить значение.
 *
 * Тот же паттерн с `details`, что у
 * `MaterialStockInsufficientException` ниже — наследуется от
 * `HttpException` напрямую, чтобы прокинуть произвольный объект в
 * exception-фильтр API.
 */
export class MaterialIssueReturnQtyExceedsAvailableException extends HttpException {
  constructor(
    public readonly details: {
      materialIssueLineId: string;
      description?: string;
      unit?: string;
      requestedQty: string;
      availableQty: string;
    },
  ) {
    // Показываем название материала (не сырой ID строки) и единицу —
    // числа уже объясняют суть, ID был бесполезен пользователю.
    const what = details.description?.trim() || 'материал';
    const unit = details.unit?.trim() ? ` ${details.unit.trim()}` : '';
    super(
      {
        statusCode: HttpStatus.CONFLICT,
        message: `Нельзя вернуть «${what}»: запрошено ${details.requestedQty}${unit}, а доступно к возврату только ${details.availableQty}${unit}.`,
        code: 'MATERIAL_ISSUE_RETURN_QTY_EXCEEDS_AVAILABLE',
        details,
      },
      HttpStatus.CONFLICT,
    );
  }
}

/**
 * Запрос частичного возврата с одним и тем же `materialIssueLineId`,
 * упомянутым более одного раза. 409 — мы не суммируем `returnedQty`
 * за клиента, чтобы случайные повторения формы не создавали
 * скрытое удвоение.
 */
export class MaterialIssueReturnDuplicateLineException extends BusinessException {
  constructor(materialIssueLineId: string) {
    super(
      'MATERIAL_ISSUE_RETURN_DUPLICATE_LINE',
      `Строка расхода ${materialIssueLineId} указана в запросе несколько раз`,
      HttpStatus.CONFLICT,
    );
  }
}

/**
 * После фильтрации (`returnedQty > 0`, остаток > 0) к возврату не
 * осталось ни одной строки. На практике покрывает два сценария:
 *   - частичный возврат: все переданные `returnedQty` обнулились
 *     (UI уже должен был отфильтровать, но защищаемся);
 *   - полное сторно по уже-полностью-возвращённому документу с
 *     НОВЫМ `clientRequestId` (старый код кидал
 *     `MATERIAL_ISSUE_ALREADY_RETURNED`; на этой итерации оба кейса
 *     обслуживает один эндпоинт, и для `lines`-режима имя
 *     `nothing_to_return` точнее).
 */
export class MaterialIssueNothingToReturnException extends BusinessException {
  constructor() {
    super(
      'MATERIAL_ISSUE_NOTHING_TO_RETURN',
      'По указанным строкам нечего возвращать',
      HttpStatus.CONFLICT,
    );
  }
}

/**
 * Hardening-итерация «Запрет отрицательных остатков материалов»:
 * `MaterialIssue.post` / `AUTO_CUT_ISSUE` пытается списать больше,
 * чем лежит на выбранном `StockBalance`, при включённой настройке
 * `CompanySettings.allowNegativeMaterialStock = false`
 * (см. `prisma/schema.prisma::CompanySettings.allowNegativeMaterialStock`,
 * `apps/api/src/modules/stock/stock.service.ts::applyMovementInTx`,
 * `apps/api/src/modules/material-issues/material-issues.service.ts`,
 * `docs/current-state.md §«Material issue → StockMovement OUT»`).
 *
 * Контракт ответа:
 *   - 409 Conflict;
 *   - `code = MATERIAL_STOCK_INSUFFICIENT`;
 *   - `details` содержит контекст для UI / клиента: `workshopNeedId`,
 *     `warehouseId`, `cellId`, `requestedQty`, `availableQty`, `unit`,
 *     `description`. Все числовые величины — строки (Decimal),
 *     чтобы не терять точность при JSON-сериализации.
 *
 * Сообщение формируется сервисом, потому что зависит от описания
 * материала и единицы измерения. Класс наследует `BusinessException`,
 * чтобы попасть в общий exception-фильтр API и держать тот же
 * формат ответа `{ statusCode, message, code, details? }`, что и
 * остальные доменные ошибки модуля (см. `MaterialIssue*Exception`
 * выше).
 *
 * Бросается ТОЛЬКО при `allowNegativeMaterialStock = false`. Если
 * флаг `true`, сервис не падает — балансы могут уйти в минус, как и
 * до hardening-итерации.
 */
/**
 * Фича «Параметры техкарт»: в заказе есть обязательные слоты без значения.
 *
 * 400, как и соседи по этому переходу (`ORDER_PATTERN_REQUIRED`,
 * `ORDER_TECH_CARD_REQUIRED`, `ORDER_ITEMS_REQUIRED`) — форма заказа уже умеет
 * их ловить. `BusinessException` не годится: он не пропускает произвольный
 * payload, а UI должен подсветить КОНКРЕТНЫЕ расцветки и поля.
 */
export class OrderSpecIncompleteException extends HttpException {
  constructor(
    public readonly details: {
      variants: Array<{
        orderVariantId: string | null;
        color: string | null;
        parameters: Array<{ key: string; label: string; unit: string | null }>;
      }>;
    },
  ) {
    const summary = details.variants
      .map(
        (v) =>
          `${v.color ?? 'заказ'}: ${v.parameters.map((p) => p.label).join(', ')}`,
      )
      .join('; ');
    super(
      {
        statusCode: HttpStatus.BAD_REQUEST,
        message: `Заполните параметры техкарты — ${summary}.`,
        code: 'ORDER_SPEC_INCOMPLETE',
        details,
      },
      HttpStatus.BAD_REQUEST,
    );
  }
}

export class MaterialStockInsufficientException extends HttpException {
  constructor(
    message: string,
    public readonly details: {
      workshopNeedId: string;
      warehouseId: string | null;
      cellId: string | null;
      requestedQty: string;
      availableQty: string;
      unit: string;
      description: string;
    },
  ) {
    super(
      {
        statusCode: HttpStatus.CONFLICT,
        message,
        code: 'MATERIAL_STOCK_INSUFFICIENT',
        details,
      },
      HttpStatus.CONFLICT,
    );
  }
}

// ---------------------------------------------------------------------------
// Сигнальный образец (см. `apps/api/src/modules/order-samples/*`,
// `docs/order-signal-sample-flow.md`,
// `packages/shared/src/order-samples.ts`).
// ---------------------------------------------------------------------------

export class OrderSampleNotFoundException extends BusinessException {
  constructor() {
    super(
      'ORDER_SAMPLE_NOT_FOUND',
      'Сигнальный образец не найден',
      HttpStatus.NOT_FOUND,
    );
  }
}

export class OrderSampleAlreadyActiveException extends BusinessException {
  constructor() {
    super(
      'ORDER_SAMPLE_ALREADY_ACTIVE',
      'По этой паре изделия и размера уже есть активный образец. Закройте его (Approve / Reject / Cancel) перед запуском нового.',
      HttpStatus.CONFLICT,
    );
  }
}

export class OrderSampleInvalidStatusException extends BusinessException {
  constructor(currentStatus: string, action: string) {
    super(
      'ORDER_SAMPLE_INVALID_STATUS',
      `Действие "${action}" недоступно для образца в статусе ${currentStatus}.`,
      HttpStatus.CONFLICT,
    );
  }
}

export class OrderSampleSizeNotInOrderException extends BusinessException {
  constructor() {
    super(
      'ORDER_SAMPLE_SIZE_NOT_IN_ORDER',
      'Выбранный размер отсутствует в заказе.',
      HttpStatus.BAD_REQUEST,
    );
  }
}

export class OrderSampleOrderInvalidStatusException extends BusinessException {
  constructor(currentStatus: string) {
    super(
      'ORDER_SAMPLE_ORDER_INVALID_STATUS',
      `Нельзя запустить образец у заказа в статусе ${currentStatus}.`,
      HttpStatus.CONFLICT,
    );
  }
}

export class OrderSampleQtyExceedsOrderSizeQtyException extends BusinessException {
  constructor(qty: number, orderSizeQty: number) {
    super(
      'ORDER_SAMPLE_QTY_EXCEEDS_ORDER_SIZE_QTY',
      `Количество образца (${qty}) превышает план по размеру (${orderSizeQty}). При включении образца в тираж это невозможно.`,
      HttpStatus.BAD_REQUEST,
    );
  }
}

export class OrderSampleRejectionReasonRequiredException extends BusinessException {
  constructor() {
    super(
      'ORDER_SAMPLE_REJECTION_REASON_REQUIRED',
      'Укажите причину отклонения образца.',
      HttpStatus.BAD_REQUEST,
    );
  }
}

// ---------------------------------------------------------------------------
// Кабинет раскройщика (`CuttingTask`, роль CUTTER)
// ---------------------------------------------------------------------------

export class CuttingTaskNotFoundException extends BusinessException {
  constructor() {
    super(
      'CUTTING_TASK_NOT_FOUND',
      'Задача на раскрой не найдена',
      HttpStatus.NOT_FOUND,
    );
  }
}

export class CuttingTaskInvalidTransitionException extends BusinessException {
  constructor(message: string) {
    super('CUTTING_TASK_INVALID_TRANSITION', message, HttpStatus.CONFLICT);
  }
}

export class CuttingTaskNotInProgressException extends BusinessException {
  constructor() {
    super(
      'CUTTING_TASK_NOT_IN_PROGRESS',
      'Задача должна быть в работе — сначала примите задание',
      HttpStatus.CONFLICT,
    );
  }
}

export class CuttingTaskPayloadInvalidException extends BusinessException {
  constructor(message: string) {
    super('CUTTING_TASK_PAYLOAD_INVALID', message, HttpStatus.BAD_REQUEST);
  }
}

/**
 * «Раскрой завершён» с незаполненным настилом: нет раскладов, у выбранных
 * размеров «на настиле» = 0 или рулоны без слоёв (правила — в
 * `@sewing/shared/cutting-tasks::listCuttingCompletionProblems`). Иначе
 * задача уйдёт на доску помощника раскройщика пустой — выпускать паспорта
 * не из чего (прецедент: O-20260716-0001, откат
 * `scripts/migrations/20260716_reset_cutting_task_o20260716-0001_to_new.sql`).
 */
export class CuttingTaskCompletionIncompleteException extends BusinessException {
  constructor(problems: string[]) {
    super(
      'CUTTING_TASK_COMPLETION_INCOMPLETE',
      `Нельзя завершить раскрой: ${problems.join('; ')}. Заполните настил или удалите лишнее.`,
      HttpStatus.BAD_REQUEST,
    );
  }
}

// ---------------------------------------------------------------------------
// Частичное завершение раскроя по раскладу («Расклад готов»)
// ---------------------------------------------------------------------------

/** Расклада с таким `ordinal` в задаче нет. */
export class CuttingLayNotFoundException extends BusinessException {
  constructor(ordinal: number) {
    super(
      'CUTTING_LAY_NOT_FOUND',
      `Расклад №${ordinal} не относится к этой задаче раскроя`,
      HttpStatus.NOT_FOUND,
    );
  }
}

/**
 * Попытка изменить (или удалить) уже закрытый расклад. Закрытый расклад —
 * источник количеств в выпущенных паспортах (`qtyCut = слои × «на
 * настиле»`), поэтому он read-only: сначала «Открыть расклад».
 */
export class CuttingLayLockedException extends BusinessException {
  constructor(ordinal: number) {
    super(
      'CUTTING_LAY_LOCKED',
      `Расклад №${ordinal} закрыт — правки недоступны. Откройте расклад, если нужно изменить настил.`,
      HttpStatus.CONFLICT,
    );
  }
}

/**
 * «Расклад готов» с незаполненным настилом. Правила те же, что у
 * завершения всего раскроя, но по одному раскладу — см.
 * `@sewing/shared/cutting-tasks::listLayCompletionProblems`.
 */
export class CuttingLayCompletionIncompleteException extends BusinessException {
  constructor(ordinal: number, problems: string[]) {
    super(
      'CUTTING_LAY_COMPLETION_INCOMPLETE',
      `Нельзя закрыть расклад №${ordinal}: ${problems.join('; ')}. Заполните настил или удалите лишнее.`,
      HttpStatus.BAD_REQUEST,
    );
  }
}

/**
 * Переоткрытие расклада, по которому паспорта УЖЕ УШЛИ В РАБОТУ
 * (размещены в ячейке / сканированы / упакованы).
 *
 * Свежие паспорта (`CREATED`, без ячейки, без событий кроме `CREATED`)
 * открытию расклада не мешают — их снимает сам `reopenLay`, иначе
 * бумага разошлась бы с новым настилом. А вот двинувшийся паспорт
 * удалять нельзя: за ним уже стоят движения склада, выдача и, возможно,
 * сдельные начисления. Такой расклад правится только через мастера
 * (отмена паспортов), поэтому отдаём номера — их надо искать глазами.
 */
export class CuttingLayHasPassportsException extends BusinessException {
  constructor(ordinal: number, numbers: string[], total: number) {
    const shown = numbers.join(', ');
    const tail = total > numbers.length ? ` и ещё ${total - numbers.length}` : '';
    const many = total > 1;
    super(
      'CUTTING_LAY_HAS_PASSPORTS',
      `Расклад №${ordinal} не открыть: ${many ? 'паспорта' : 'паспорт'} ${shown}${tail} ` +
        `уже в работе (размещены в ячейке или пошли по операциям). ` +
        `${many ? 'Отмените их' : 'Отмените его'} через мастера, потом открывайте расклад.`,
      HttpStatus.CONFLICT,
    );
  }
}

/**
 * Выпуск паспортов по раскладу, который ещё настилается. Заменил
 * `CUTTING_TASK_NOT_DONE` в рулонном выпуске: теперь готовность считается
 * по раскладу, а не по всей задаче.
 */
export class CuttingLayNotDoneException extends BusinessException {
  constructor(ordinal: number) {
    super(
      'CUTTING_LAY_NOT_DONE',
      `Расклад №${ordinal} ещё не закрыт — выпуск паспортов по нему недоступен.`,
      HttpStatus.BAD_REQUEST,
    );
  }
}

// ---------------------------------------------------------------------------
// Подкрой (`RecutSession`, роль CUTTER)
// ---------------------------------------------------------------------------

/**
 * Раскройщик пытается начать подкрой без открытой смены. Подкрой —
 * активность в рамках смены (часы смены = почасовая оплата, доска
 * `/cutter` и так закрыта за сменой); без смены запускать нельзя.
 */
export class RecutNoActiveShiftException extends BusinessException {
  constructor() {
    super(
      'RECUT_NO_ACTIVE_SHIFT',
      'Смена не начата — отсканируйте QR раскройного стола, затем начните подкрой.',
      HttpStatus.CONFLICT,
    );
  }
}

/**
 * У раскройщика уже идёт другой подкрой. Одновременно активен только
 * один (partial-unique индекс `recut_session_active_employee_uniq` +
 * явная проверка). Сначала завершите текущий.
 */
export class RecutAlreadyActiveException extends BusinessException {
  constructor() {
    super(
      'RECUT_ALREADY_ACTIVE',
      'У вас уже идёт подкрой — сначала завершите его.',
      HttpStatus.CONFLICT,
    );
  }
}

export class RecutNotFoundException extends BusinessException {
  constructor() {
    super('RECUT_NOT_FOUND', 'Подкрой не найден', HttpStatus.NOT_FOUND);
  }
}

/**
 * Завершить/отменить можно только идущий (`ACTIVE`) подкрой. Если он
 * уже `DONE`/`CANCELLED` — повторное действие отклоняется.
 */
export class RecutNotActiveException extends BusinessException {
  constructor() {
    super(
      'RECUT_NOT_ACTIVE',
      'Подкрой уже завершён или отменён.',
      HttpStatus.CONFLICT,
    );
  }
}

export class RecutOrderNotFoundException extends BusinessException {
  constructor() {
    super('RECUT_ORDER_NOT_FOUND', 'Заказ не найден', HttpStatus.NOT_FOUND);
  }
}

// ---------------------------------------------------------------------------
// Hard-delete (этап «Удалить архивную запись навсегда»)
//
// Архивирование — soft (status/isActive). Hard-delete = физическое
// удаление строки. Политика «блокировать, если используется»: удалять
// можно только запись, которая (а) уже в архивном/терминальном
// состоянии и (б) ни на что не завязана (нет заказов / паспортов /
// snapshot-ссылок). Иначе — адресная 409 с количеством блокирующих
// ссылок, чтобы менеджер понял, что именно мешает.
// ---------------------------------------------------------------------------

export class OrderDeleteForbiddenException extends BusinessException {
  constructor(message: string) {
    super('ORDER_DELETE_FORBIDDEN', message, HttpStatus.CONFLICT);
  }
}

export class PatternDeleteForbiddenException extends BusinessException {
  constructor(message: string) {
    super('PATTERN_DELETE_FORBIDDEN', message, HttpStatus.CONFLICT);
  }
}

export class PatternCategoryDeleteForbiddenException extends BusinessException {
  constructor(message: string) {
    super('PATTERN_CATEGORY_DELETE_FORBIDDEN', message, HttpStatus.CONFLICT);
  }
}

export class TechCardDeleteForbiddenException extends BusinessException {
  constructor(message: string) {
    super('TECH_CARD_DELETE_FORBIDDEN', message, HttpStatus.CONFLICT);
  }
}

/**
 * Этап «Архив справочников»: безвозвратно удалить шаблон маршрута
 * можно только из архива и только если на него не ссылаются заказы /
 * пробники (FK `RESTRICT` — раньше такое удаление падало сырой
 * ошибкой БД). См. `RoutesService.remove`.
 */
export class RouteTemplateDeleteForbiddenException extends BusinessException {
  constructor(message: string) {
    super('ROUTE_TEMPLATE_DELETE_FORBIDDEN', message, HttpStatus.CONFLICT);
  }
}

/**
 * Тот же контур для цехового монитора (`DisplayScreenConfig`) и
 * принтеров: удаление навсегда — только из архива.
 */
export class DisplayScreenDeleteForbiddenException extends BusinessException {
  constructor(message: string) {
    super('DISPLAY_SCREEN_DELETE_FORBIDDEN', message, HttpStatus.CONFLICT);
  }
}

export class PrinterDeleteForbiddenException extends BusinessException {
  constructor(message: string) {
    super('PRINTER_DELETE_FORBIDDEN', message, HttpStatus.CONFLICT);
  }
}

export class CutReleasePolicyNotFoundException extends BusinessException {
  constructor() {
    super(
      'CUT_RELEASE_POLICY_NOT_FOUND',
      'Правило выпуска кроя не найдено — возможно, его уже удалили. Обновите страницу.',
      HttpStatus.NOT_FOUND,
    );
  }
}

export class PrintPublicApiUrlNotConfiguredException extends BusinessException {
  constructor() {
    super(
      'PRINT_PUBLIC_API_URL_NOT_CONFIGURED',
      'Печать недоступна: на сервере не настроен публичный адрес API (PUBLIC_API_URL / APP_URL). Обратитесь к администратору.',
      HttpStatus.SERVICE_UNAVAILABLE,
    );
  }
}

// ===========================================================================
// Казначейство (Фаза 0 — журнал ДДС)
// ===========================================================================

export class CashAccountNotFoundException extends BusinessException {
  constructor() {
    super(
      'CASH_ACCOUNT_NOT_FOUND',
      'Счёт ДС не найден — возможно, его удалили. Обновите страницу.',
      HttpStatus.NOT_FOUND,
    );
  }
}

export class CashAccountInactiveException extends BusinessException {
  constructor() {
    super(
      'CASH_ACCOUNT_INACTIVE',
      'Счёт ДС неактивен — проводки по нему запрещены.',
      HttpStatus.CONFLICT,
    );
  }
}

export class CashFlowItemNotFoundException extends BusinessException {
  constructor() {
    super(
      'CASH_FLOW_ITEM_NOT_FOUND',
      'Статья ДДС не найдена — возможно, её удалили. Обновите страницу.',
      HttpStatus.NOT_FOUND,
    );
  }
}

export class CashFlowItemInactiveException extends BusinessException {
  constructor() {
    super(
      'CASH_FLOW_ITEM_INACTIVE',
      'Статья ДДС неактивна — выберите другую.',
      HttpStatus.CONFLICT,
    );
  }
}

export class CashFlowEntryNotFoundException extends BusinessException {
  constructor() {
    super(
      'CASH_FLOW_ENTRY_NOT_FOUND',
      'Проводка журнала ДДС не найдена.',
      HttpStatus.NOT_FOUND,
    );
  }
}

export class CashFlowEntryAlreadyReversedException extends BusinessException {
  constructor() {
    super(
      'CASH_FLOW_ENTRY_ALREADY_REVERSED',
      'Проводка уже сторнирована — повторное сторно запрещено.',
      HttpStatus.CONFLICT,
    );
  }
}

export class CashFlowEntryStornoNotAllowedException extends BusinessException {
  constructor(message = 'Сторнировать можно только обычную проводку, не сторно.') {
    super('CASH_FLOW_ENTRY_STORNO_NOT_ALLOWED', message, HttpStatus.CONFLICT);
  }
}

// ===========================================================================
// Казначейство, Фаза 1 — оплата поставщику (SupplierPayment)
// ===========================================================================

export class SupplierPaymentNotFoundException extends BusinessException {
  constructor() {
    super(
      'SUPPLIER_PAYMENT_NOT_FOUND',
      'Оплата поставщику не найдена — возможно, её удалили. Обновите страницу.',
      HttpStatus.NOT_FOUND,
    );
  }
}

export class SupplierPaymentInvalidStatusException extends BusinessException {
  constructor(message: string) {
    super('SUPPLIER_PAYMENT_INVALID_STATUS', message, HttpStatus.CONFLICT);
  }
}

export class SupplierPaymentAlreadyPaidException extends BusinessException {
  constructor() {
    super(
      'SUPPLIER_PAYMENT_ALREADY_PAID',
      'Оплата уже проведена — повторное проведение запрещено. Для отмены сторнируйте проводку в журнале.',
      HttpStatus.CONFLICT,
    );
  }
}
