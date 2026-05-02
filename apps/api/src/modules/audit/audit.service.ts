import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service.js';

/**
 * Тип агрегата, к которому относится событие аудита (см.
 * `prisma/schema.prisma` модель `AuditLog` и `docs/domain.md
 * §«Audit log»`). Свободная строка нужна, чтобы в один и тот же
 * `entityType = PASSPORT` могли писать события из нескольких модулей
 * (passports / qc / wto / packing) — общая ось «история по объекту»
 * остаётся единой.
 */
export type AuditEntityType =
  | 'PASSPORT'
  | 'ORDER'
  | 'QC'
  | 'WTO'
  | 'PACKING'
  /**
   * Вызовы мастера цеха (MVP, см. `apps/api/src/modules/master-calls/*`,
   * `prisma/schema.prisma::MasterCall`). События — `MASTER_CALLED`,
   * `MASTER_CALL_RESOLVED`. `entityId` — `MasterCall.id`.
   */
  | 'MASTER_CALL'
  /**
   * Управленческое ограничение выдачи кроя (Stage 3 «Мастер цеха»).
   * См. `apps/api/src/modules/cut-release-policy/*`,
   * `prisma/schema.prisma::CutReleasePolicy`. События —
   * `CUT_RELEASE_POLICY_CREATED`, `CUT_RELEASE_POLICY_DISABLED`,
   * `CUT_RELEASE_POLICY_UPDATED`, `CUT_RELEASE_POLICY_CONSUMED`.
   * `entityId` — `CutReleasePolicy.id`.
   */
  | 'CUT_RELEASE_POLICY'
  /**
   * Карточки клиентов (управленческий справочник, см.
   * `apps/api/src/modules/clients/*`, `prisma/schema.prisma::Client`).
   * События — `CLIENT_CREATED`, `CLIENT_UPDATED`. `entityId` —
   * `Client.id`.
   */
  | 'CLIENT'
  /**
   * Лекала (изолированный модуль `Patterns` MVP-1, см.
   * `apps/api/src/modules/patterns/*`,
   * `prisma/schema.prisma::PatternItem`). События:
   *   - `PATTERN_CREATED` / `PATTERN_UPDATED` — создание/правка
   *     карточки, `entityId = PatternItem.id`;
   *   - `PATTERN_PREVIEW_UPLOADED` — загрузка превью,
   *     `entityId = PatternItem.id`;
   *   - `PATTERN_SIZE_FILE_UPLOADED` / `PATTERN_SIZE_FILE_ARCHIVED` —
   *     операции с DXF-файлами, `entityId = PatternItem.id`
   *     (id файла в payload);
   *   - `PATTERN_MATERIAL_AREAS_REPLACED` — bulk-replace площадей,
   *     `entityId = PatternItem.id`.
   */
  | 'PATTERN'
  /**
   * Категории номенклатуры (этап «Категории номенклатуры», см.
   * `apps/api/src/modules/pattern-categories/*`,
   * `prisma/schema.prisma::PatternCategory` /
   * `PatternCategoryParameter`). События:
   *   - `PATTERN_CATEGORY_CREATED` / `PATTERN_CATEGORY_UPDATED` —
   *     карточка категории, `entityId = PatternCategory.id`;
   *   - `PATTERN_CATEGORY_ARCHIVED` — soft-archive категории
   *     (`DELETE /api/pattern-categories/:id`);
   *   - `PATTERN_CATEGORY_PARAMETERS_REPLACED` — bulk-replace
   *     параметров категории, `entityId = PatternCategory.id`
   *     (детали в payload: count, roleKeys, inputTypes);
   *   - `PATTERN_CATEGORY_ICON_UPLOADED` — менеджер загрузил JPEG-иконку
   *     (этап «Загружаемая JPEG-иконка категории»),
   *     `entityId = PatternCategory.id` (payload: iconImageUrl,
   *     originalFileName, sizeBytes).
   */
  | 'PATTERN_CATEGORY'
  /**
   * Потребность цеха (Этап 4А, см.
   * `apps/api/src/modules/workshop-needs/*`,
   * `prisma/schema.prisma::WorkshopNeed`). События:
   *   - `WORKSHOP_NEEDS_CALCULATED` — bulk-расчёт по заказу,
   *     `entityId = orderId` (детали в payload: count/methods/warnings/force);
   *   - `WORKSHOP_NEED_UPDATED` — закупщик отредактировал строку,
   *     `entityId = WorkshopNeed.id`;
   *   - `WORKSHOP_NEED_CANCELLED` — закупщик отменил строку,
   *     `entityId = WorkshopNeed.id`.
   */
  | 'WORKSHOP_NEED'
  /**
   * Справочник поставщиков (Этап 5, см.
   * `apps/api/src/modules/suppliers/*`,
   * `prisma/schema.prisma::Supplier`). События:
   *   - `SUPPLIER_CREATED` / `SUPPLIER_UPDATED` — карточка поставщика,
   *     `entityId = Supplier.id`;
   *   - `SUPPLIER_CONTACT_CREATED` / `SUPPLIER_CONTACT_UPDATED` /
   *     `SUPPLIER_CONTACT_DELETED` — операции с контактами,
   *     `entityId = Supplier.id` (id контакта в payload);
   *   - `SUPPLIER_CATALOG_ITEM_CREATED` /
   *     `SUPPLIER_CATALOG_ITEM_UPDATED` /
   *     `SUPPLIER_CATALOG_ITEM_ARCHIVED` — операции с каталогом,
   *     `entityId = Supplier.id` (id позиции в payload).
   */
  | 'SUPPLIER'
  /**
   * Заказы поставщикам (Этап 6А, см.
   * `apps/api/src/modules/purchase-orders/*`,
   * `prisma/schema.prisma::PurchaseOrder`). События:
   *   - `PURCHASE_ORDER_CREATED` / `PURCHASE_ORDER_UPDATED` —
   *     заголовок PO, `entityId = PurchaseOrder.id`;
   *   - `PURCHASE_ORDER_LINE_UPDATED` — отдельная строка,
   *     `entityId = PurchaseOrder.id` (id строки в payload);
   *   - `PURCHASE_ORDER_SENT` / `PURCHASE_ORDER_CONFIRMED` /
   *     `PURCHASE_ORDER_CANCELLED` — переходы статуса,
   *     `entityId = PurchaseOrder.id`.
   */
  | 'PURCHASE_ORDER'
  /**
   * Документы приёмки (Этап 7А, см.
   * `apps/api/src/modules/purchase-receipts/*`,
   * `prisma/schema.prisma::PurchaseReceipt`). События:
   *   - `PURCHASE_RECEIPT_CREATED` — фактическая приёмка зарегистрирована,
   *     `entityId = PurchaseReceipt.id` (детали в payload: linesCount,
   *     cellIds, affectedWorkshopNeedIds);
   *   - `PURCHASE_RECEIPT_CANCELLED` — документ отменён,
   *     `entityId = PurchaseReceipt.id`.
   */
  | 'PURCHASE_RECEIPT'
  /**
   * Заказные нанесения (этап «Нанесение на заказе покупателя», см.
   * `apps/api/src/modules/order-applications/*`,
   * `prisma/schema.prisma::OrderApplication`). События:
   *   - `ORDER_APPLICATIONS_REPLACED` — менеджер сохранил список
   *     нанесений по заказу через PUT-replace, `entityId = orderId`
   *     (детали в payload: previousCount / nextCount / stages).
   */
  | 'ORDER_APPLICATION'
  /**
   * Документ «Себестоимость заказа» (этап «Себестоимость заказа», см.
   * `apps/api/src/modules/orders/order-cost-estimates.service.ts`,
   * `prisma/schema.prisma::OrderCostEstimate`). События:
   *   - `ORDER_COST_ESTIMATE_CREATED` — закупщик завершил расчёт,
   *     `entityId = OrderCostEstimate.id` (детали — orderId / version
   *     / totalCostRub / linesCount).
   *   - `ORDER_CALCULATION_COMPLETED` / `ORDER_CALCULATION_REOPENED`
   *     пишутся под `entityType = 'ORDER'` (это переходы статуса
   *     заказа), а не сюда.
   */
  | 'ORDER_COST_ESTIMATE'
  /**
   * Ручная отметка «Материал поступил» (этап «Ручная отметка
   * поступления материала», см.
   * `apps/api/src/modules/order-material-arrivals/*`,
   * `prisma/schema.prisma::OrderMaterialArrivalOverride`). События:
   *   - `ORDER_MATERIAL_ARRIVAL_OVERRIDE_CREATED` — менеджер нажал
   *     «Материал поступил» в карточке заказа,
   *     `entityId = orderId` (детали — workshopNeedIds /
   *     overridesCount / comment).
   *   - `ORDER_MATERIAL_ARRIVAL_OVERRIDE_REVOKED` — override отменён,
   *     `entityId = OrderMaterialArrivalOverride.id` (детали —
   *     orderId / workshopNeedId / reason).
   */
  | 'ORDER_MATERIAL_ARRIVAL_OVERRIDE'
  /**
   * Справочник размеров (`prisma/schema.prisma::Size`,
   * `apps/api/src/modules/sizes/*`). Этап «Создание пользовательского
   * размера»:
   *   - `SIZE_CREATED` — менеджер создал новый размер через
   *     `POST /api/sizes` (детали в payload: `code`, `sortOrder`).
   *     Idempotent-create без вставки новой строки аудит **не**
   *     пишет — мы фиксируем только реальные изменения справочника.
   * `entityId` — `Size.id`.
   */
  | 'SIZE'
  /**
   * Реквизиты организации (singleton-настройки, см.
   * `apps/api/src/modules/company-settings/*`,
   * `prisma/schema.prisma::CompanySettings`). События:
   *   - `COMPANY_SETTINGS_UPDATED` — менеджер сохранил блок реквизитов
   *     (юр. название / ИНН / адрес / банк / руководитель / …).
   *     `entityId` всегда `"default"` (singleton-id), payload содержит
   *     `before`/`after`-снимок изменённых полей.
   */
  | 'COMPANY_SETTINGS'
  /**
   * Подразделения компании (управленческий справочник, см.
   * `apps/api/src/modules/company-settings/company-divisions.*`,
   * `prisma/schema.prisma::CompanyDivision`). События:
   *   - `COMPANY_DIVISION_CREATED` — менеджер завёл новое
   *     подразделение, `entityId = CompanyDivision.id`;
   *   - `COMPANY_DIVISION_UPDATED` — правка карточки (включая мягкое
   *     отключение через `isActive = false`), `entityId = CompanyDivision.id`.
   *
   * **Не путать** с `entityType = ORDER`: события на самом заказе
   * (включая смену `companyDivisionId`) пишутся под `ORDER`, а
   * `COMPANY_DIVISION` — это события самой карточки справочника.
   */
  | 'COMPANY_DIVISION';

/**
 * Минимальный полезный ввод для одного события аудита. `payload` —
 * `Prisma.InputJsonValue`: позволяем класть произвольный JSON-срез
 * без жёсткой схемы. Сервис ничего не достраивает «магически» —
 * вызывающая сторона сама решает, какие ключи положить (минимально
 * полезный срез: ids, qty, fromStatus/toStatus, …).
 */
export interface AuditLogInput {
  event: string;
  entityType: AuditEntityType;
  entityId: string;
  payload: Prisma.InputJsonValue;
  /**
   * Кто инициировал действие. `null` — для системных событий, где
   * актора нет (например, фоновые синки). FK на `Employee` сознательно
   * не ставим: учётка может быть деактивирована/удалена, а строка
   * журнала должна уцелеть (см. schema.prisma).
   */
  employeeId?: string | null;
}

/**
 * Сервис записи универсальных событий аудита (`AuditLog`).
 *
 * Контракт (см. `docs/domain.md §«Audit log»`):
 *   - `log(...)` пишет ровно одну строку в `AuditLog`;
 *   - вызывающая сторона ОБЯЗАНА передавать активный
 *     `Prisma.TransactionClient`, если действие выполняется внутри
 *     `prisma.$transaction(...)` — это инвариант «либо и операция,
 *     и аудит, либо ничего» (см. `audit.module.ts`, ADR / domain.md);
 *   - если транзакции нет (например, исторический одиночный
 *     `passportEvent.create`), сервис допускает вызов без `tx` — и
 *     сам глушит ошибку записи в WARN, чтобы аудит никогда не валил
 *     бизнес-операцию (фоновая инфраструктура должна оставаться
 *     fail-soft).
 *
 * Сервис не делает enrichment, не нормализует payload и не
 * подгружает связанные сущности. Это сознательная простота — лог
 * должен оставаться дешёвым и предсказуемым.
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Записать одно событие в журнал.
   *
   * @param input  Полезный ввод (`event`, `entityType`, `entityId`,
   *               `payload`, `employeeId`). См. `AuditLogInput`.
   * @param tx     Опциональный `Prisma.TransactionClient` — должен
   *               передаваться, если вызов идёт внутри
   *               `prisma.$transaction(...)`, чтобы аудит и сама
   *               операция жили атомарно. Без `tx` запись идёт через
   *               глобальный `prisma` и любая ошибка глушится в WARN.
   */
  async log(
    input: AuditLogInput,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    const data: Prisma.AuditLogUncheckedCreateInput = {
      event: input.event,
      entityType: input.entityType,
      entityId: input.entityId,
      payload: input.payload,
      employeeId: input.employeeId ?? null,
    };

    if (tx) {
      // Внутри транзакции: пробрасываем ошибку, чтобы операция и аудит
      // жили атомарно. Если запись в `AuditLog` падает (например, при
      // несовместимой миграции на пилоте) — это структурная проблема,
      // которую лучше увидеть на уровне 500, чем потерять.
      await tx.auditLog.create({ data });
      return;
    }

    try {
      await this.prisma.auditLog.create({ data });
    } catch (err) {
      // Без транзакции: fail-soft. Аудит не должен валить
      // бизнес-операцию, особенно в legacy-сервисах, которые ещё не
      // обернули свой `passportEvent.create` в `$transaction`.
      this.logger.warn(
        `audit.log failed event=${input.event} entityType=${input.entityType} entityId=${input.entityId}: ${(err as Error).message}`,
      );
    }
  }
}
