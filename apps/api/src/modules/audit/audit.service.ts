import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service.js';
import { currentActor } from '../auth/actor-context.js';

/**
 * Тип агрегата, к которому относится событие аудита (см.
 * `prisma/schema.prisma` модель `AuditLog` и `docs/domain.md
 * §«Audit log»`). Свободная строка нужна, чтобы в один и тот же
 * `entityType = PASSPORT` могли писать события из нескольких модулей
 * (passports / qc / wto / packing) — общая ось «история по объекту»
 * остаётся единой.
 */
export type AuditEntityType =
  /**
   * Статьи базы знаний (`apps/api/src/modules/knowledge/*`,
   * `prisma/schema.prisma::KnowledgeArticle`). События —
   * `KNOWLEDGE_ARTICLE_CREATED/UPDATED/REVIEWED/ARCHIVED/RESTORED/PURGED`.
   * `entityId` — `KnowledgeArticle.id`. Аудит здесь не формальность:
   * статья — это инструкция для цеха, и «кто и когда это написал»
   * спрашивают ровно тогда, когда по ней сделали неправильно.
   */
  | 'KNOWLEDGE_ARTICLE'
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
  /**
   * Расписание начисления зарплаты (singleton
   * `prisma/schema.prisma::PayrollAccrualSchedule`). Событие —
   * `PAYROLL_SCHEDULE_UPDATED`, `entityId` — всегда `'default'`.
   * Настройка решает, попадут ли деньги человека в ближайшую выплату
   * (день начисления + отсечка по закрытым заказам), поэтому «кто и
   * когда сдвинул правило» — первый вопрос при разборе недоплаты.
   */
  | 'PayrollAccrualSchedule'
  | 'CUT_RELEASE_POLICY'
  /**
   * Очередь выдачи кроя по размерам (см.
   * `apps/api/src/modules/order-cut-issue-rules/*`,
   * `prisma/schema.prisma::OrderCutIssueRule`,
   * `docs/domain.md §«Очередь выдачи кроя»`). События:
   *   - `ORDER_CUT_ISSUE_RULE_UPSERT` — менеджер сохранил bulk-форму
   *     очереди (заведено/обновлено/деактивировано N строк),
   *     `entityId = orderId`;
   *   - `ORDER_CUT_ISSUE_RULE_DISABLED` — менеджер отключил всю
   *     очередь по заказу (`isActive = false` для всех строк),
   *     `entityId = orderId`;
   *   - `ORDER_CUT_ISSUE_RULE_CONSUMED` — атомарный инкремент
   *     `issuedQty` в той же транзакции, что и
   *     `PassportsService.issueToEmployee`. `entityId = OrderCutIssueRule.id`,
   *     payload содержит `passportId` / `qty` / `beforeIssued` /
   *     `afterIssued`;
   *   - `ORDER_CUT_ISSUE_RULE_VIOLATION_BLOCKED` — необязательное
   *     событие (логируется при отказе issue из-за нарушения
   *     очереди), `entityId = orderId`. На MVP пишется через
   *     fail-soft (без `tx`) — даже если запись упадёт, бизнес-операция
   *     не пострадает.
   */
  | 'ORDER_CUT_ISSUE_RULE'
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
   *     `entityId = PatternItem.id`;
   *   - `PATTERNS_ARCHIVED` / `PATTERNS_RESTORED` — массовые операции
   *     архива со списка `/admin/patterns` (`POST /api/patterns/archive`
   *     `…/restore`). Одно событие на пачку: `entityId` — первая
   *     карточка, полный список id — в payload;
   *   - `PATTERN_DELETED` — безвозвратное удаление архивной карточки
   *     (`DELETE /api/patterns/:id/permanent` либо bulk
   *     `POST /api/patterns/purge`, тогда в payload `bulk: true`);
   *     одно событие на карточку, `entityId = PatternItem.id`.
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
   * Справочник ролей (см. `apps/api/src/modules/app-roles/*`,
   * `prisma/schema.prisma::AppRole`). События:
   *   - `APP_ROLE_CREATE` / `APP_ROLE_UPDATE` — заведение и правка
   *     роли, `entityId = AppRole.id` (код и наследование в payload);
   *   - `APP_ROLE_ARCHIVE` / `APP_ROLE_RESTORE` / `APP_ROLE_PURGE` —
   *     массовые операции архива, одно событие на пачку,
   *     `entityId` — id через запятую.
   *
   * Пишем в аудит все операции: правка наследования роли меняет права
   * сразу всем её носителям, и «кто и когда это сделал» — первый
   * вопрос при разборе инцидента с доступом.
   */
  | 'APP_ROLE'
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
   * Заявки на оплату поставщику (см.
   * `apps/api/src/modules/supplier-payment-requests/*`,
   * `prisma/schema.prisma::SupplierPaymentRequest`). События:
   *   - `SUPPLIER_PAYMENT_REQUEST_CREATED` — заявка выписана по PO,
   *     `entityId = SupplierPaymentRequest.id` (детали в payload:
   *     purchaseOrderId, amount, stagesCount, filesCount).
   */
  | 'SUPPLIER_PAYMENT_REQUEST'
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
   * Прочие / непредвиденные расходы заказа (этап «Корректировка
   * материалов после просчёта», см.
   * `apps/api/src/modules/order-extra-costs/*`,
   * `prisma/schema.prisma::OrderExtraCost`). События:
   *   - `ORDER_EXTRA_COST_CREATED` / `ORDER_EXTRA_COST_UPDATED` /
   *     `ORDER_EXTRA_COST_DELETED` — CRUD строки расхода,
   *     `entityId = OrderExtraCost.id` (детали — orderId / amount /
   *     currency / includeInCostPrice).
   */
  | 'ORDER_EXTRA_COST'
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
   * Настройки интеграции с внешним ERP upgifts (singleton, см.
   * `apps/api/src/modules/integrations/*`,
   * `prisma/schema.prisma::IntegrationSettings`,
   * `docs/upgifts-integration.md`). Событие:
   *   - `INTEGRATION_SETTINGS_UPDATED` — менеджер сохранил настройки
   *     подключения к upgifts. `entityId` всегда `"default"`; payload
   *     содержит список изменённых полей (без секретов — пароль в
   *     audit не пишется).
   */
  | 'INTEGRATION_SETTINGS'
  /**
   * Диалоги с ассистентом (ИИ) — см. `apps/api/src/modules/assistant/*`,
   * `prisma/schema.prisma::AssistantThread`. Событие:
   *   - `ASSISTANT_QUESTION_ANSWERED` — ассистент ответил на вопрос.
   *     `entityId` — `AssistantThread.id`; payload содержит модель,
   *     список вызванных инструментов и стоимость обращения. Текст
   *     вопроса в audit НЕ пишется: он уже лежит в `AssistantMessage`,
   *     дублировать пользовательский ввод в журнал незачем.
   */
  | 'ASSISTANT_THREAD'
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
  | 'COMPANY_DIVISION'
  /**
   * Окладные начисления (PHASE 2 STEP 4 «audit manual salary edits»,
   * см. `apps/api/src/modules/salary/salary.service.ts::updateManually`,
   * `prisma/schema.prisma::SalaryEntry`,
   * `docs/domain.md §«Audit log»`). События только для **ручных**
   * правок менеджером — автоматический `syncDailySalary` (срабатывает
   * на `start/stop shift`) аудит не пишет, чтобы не зашумлять журнал.
   *
   * События:
   *   - `SALARY_ENTRY_UPDATED` — менеджер изменил `amount` и/или
   *     `managerComment` через `PATCH /api/salary/:id` (без флага
   *     `reset`). Запись приобретает `editedManually = true`,
   *     `editedByEmployeeId = viewer`. Payload — `{ salaryEntryId,
   *     employeeId, date, before:{amount,managerComment,editedManually},
   *     after:{amount,managerComment,editedManually}, reset: false,
   *     editedByEmployeeId }`.
   *   - `SALARY_ENTRY_RESET` — менеджер прислал `reset = true`. Запись
   *     возвращается под автоматический sync: `editedManually = false`,
   *     `managerComment = null`, `editedByEmployeeId = null`,
   *     `amount` пересчитан по почасовой ставке (закрытые смены ×
   *     `salaryPerHour`). Payload — тот же набор
   *     полей, что у `SALARY_ENTRY_UPDATED`, но с `reset: true` и
   *     `after.editedManually = false` / `after.managerComment = null`.
   *
   * `entityId = SalaryEntry.id`. Никаких новых таблиц / полей в
   * `SalaryEntry` для истории не заводим — это сознательно (см. ТЗ
   * STEP 4 «Не создавать новую таблицу истории»).
   */
  | 'SALARY_ENTRY'
  /**
   * Производственный календарь — норма дней/часов на месяц (см.
   * `apps/api/src/modules/payroll-calendar/*`,
   * `prisma/schema.prisma::PayrollCalendarMonth`). События —
   * `PAYROLL_CALENDAR_MONTH_UPSERTED`, `PAYROLL_CALENDAR_MONTH_DELETED`,
   * `entityId = PayrollCalendarMonth.id`.
   *
   * Норма попала в аудит не как справочная величина: через неё
   * считается производная ставка ₽/час месячного окладника
   * (`salaryPerMonth / normHours`), то есть правка нормы двигает
   * реальные деньги в доплате за подкрой и в себестоимости.
   */
  | 'PAYROLL_CALENDAR_MONTH'
  /**
   * Выплаты зарплаты (PHASE 3, см.
   * `apps/api/src/modules/payroll-payouts/*`,
   * `prisma/schema.prisma::PayrollPayout` / `PayrollPayoutLine`,
   * `packages/shared/src/payroll-payouts.ts`,
   * `docs/erd.md §2.9`). События пишутся в той же транзакции, что и
   * соответствующая мутация в `PayrollPayoutsService`:
   *
   *   - `PAYROLL_PAYOUT_CREATED` — менеджер создал черновик через
   *     `POST /api/payroll/payouts` (статус `DRAFT`); payload —
   *     `{ employeeId, periodFrom, periodTo, amountPieceworkRub,
   *     amountSalaryRub, amountTotalRub, lineCount }`.
   *   - `PAYROLL_PAYOUT_LINES_RECOMPUTED` — менеджер пересобрал
   *     строки `DRAFT`-выплаты (`POST /…/recompute`); payload —
   *     `{ employeeId, periodFrom, periodTo,
   *     before:{ amountTotalRub, lineCount },
   *     after:{ amountTotalRub, lineCount } }`.
   *   - `PAYROLL_PAYOUT_ISSUED` — менеджер выдал выплату
   *     (`POST /…/issue`, переход `DRAFT → ISSUED`); payload —
   *     `{ employeeId, periodFrom, periodTo, amountTotalRub,
   *     issuedById }`.
   *   - `PAYROLL_PAYOUT_ACKNOWLEDGED` — сотрудник подтвердил
   *     получение (`POST /…/ack`, переход `ISSUED → ACKNOWLEDGED`);
   *     payload — `{ employeeId, acknowledgedByEmployeeId,
   *     amountTotalRub }`.
   *   - `PAYROLL_PAYOUT_CANCELLED` — менеджер отменил выплату
   *     (`POST /…/cancel`, переход `DRAFT|ISSUED → CANCELLED`);
   *     payload — `{ employeeId, fromStatus, cancelledById,
   *     cancelReason }`.
   *
   * `entityId = PayrollPayout.id`. `employeeId` события (см.
   * `AuditLogInput`) — это `viewer.employeeId`, то есть «кто
   * нажал кнопку»; `payload.employeeId` — это сотрудник-получатель
   * выплаты. Это разные люди для CREATE/RECOMPUTE/ISSUE/CANCEL и
   * один и тот же — для ACKNOWLEDGED.
   */
  | 'PAYROLL_PAYOUT'
  /**
   * Документ начисления зарплаты (PHASE 3 STEP 6, см.
   * `apps/api/src/modules/payroll-accrual-documents/*`,
   * `prisma/schema.prisma::PayrollAccrualDocument` /
   * `PayrollAccrualDocumentLine`,
   * `docs/erd.md §2.9`). Аудит пишется в той же транзакции,
   * что и соответствующая мутация:
   *
   *   - `PAYROLL_ACCRUAL_DOCUMENT_CREATED` — менеджер создал
   *     DRAFT через `POST /api/payroll/accrual-documents`;
   *     payload — `{ accrualDate, linesCount, totalToPayRub, createdById }`.
   *   - `PAYROLL_ACCRUAL_DOCUMENT_RECOMPUTED` — менеджер пересчитал
   *     строки `POST /…/:id/recompute`;
   *     payload — `{ accrualDate, before:{linesCount,totalToPayRub}, after:{linesCount,totalToPayRub} }`.
   *   - `PAYROLL_ACCRUAL_DOCUMENT_LINE_UPDATED` — менеджер
   *     скорректировал строку `PATCH /…/:id/lines/:lineId`;
   *     payload — `{ lineId, employeeId, before:{manualAdjustRub,amountToPayRub}, after:{manualAdjustRub,amountToPayRub} }`.
   *   - `PAYROLL_ACCRUAL_DOCUMENT_PAID` — менеджер провёл документ
   *     `POST /…/:id/pay`; создаются `PayrollPayout` ISSUED;
   *     payload — `{ accrualDate, payoutsCreated, totalToPayRub, paidById }`.
   *   - `PAYROLL_ACCRUAL_DOCUMENT_CANCELLED` — менеджер отменил
   *     DRAFT `POST /…/:id/cancel`;
   *     payload — `{ accrualDate, cancelReason, cancelledById }`.
   *
   * `entityId = PayrollAccrualDocument.id`.
   */
  | 'PAYROLL_ACCRUAL_DOCUMENT'
  /**
   * Документы фактического расхода материалов по заказу (см.
   * `apps/api/src/modules/material-issues/*`,
   * `prisma/schema.prisma::MaterialIssue` / `MaterialIssueLine`,
   * `docs/api.md §«Material issues»`). MVP-итерация: ручная
   * фиксация расхода, БЕЗ `StockBalance` / `StockMovement` /
   * FIFO/LIFO / автосписания при выдаче кроя.
   *
   * События пишутся в той же транзакции, что и соответствующая
   * мутация в `MaterialIssuesService`. `entityId = MaterialIssue.id`,
   * `payload.lines` — snapshot строк документа.
   *
   *   - `MATERIAL_ISSUE_CREATED` — менеджер создал документ через
   *     `POST /api/material-issues` (статус сразу `DRAFT`); payload —
   *     `{ materialIssueId, orderId, passportId, status: 'DRAFT',
   *     totalCost, lines, employeeId, timestamp }`.
   *   - `MATERIAL_ISSUE_POSTED` — менеджер провёл документ
   *     (`POST /:id/post`, переход `DRAFT → POSTED`); payload — тот
   *     же набор полей плюс `previousStatus: 'DRAFT'`.
   *   - `MATERIAL_ISSUE_CANCELLED` — менеджер отменил документ в
   *     `DRAFT` (`POST /:id/cancel`, переход `DRAFT → CANCELLED`);
   *     payload включает `cancelReason` (если передан).
   *
   * Cancel для `POSTED` в MVP запрещён (см.
   * `MaterialIssuePostedCannotCancelException`), отдельного аудит-
   * события «отказали в отмене» нет — проверка возвращает 409 без
   * записи в `AuditLog`.
   */
  | 'MATERIAL_ISSUE'
  /**
   * Документы возврата / сторно проведённого `MaterialIssue` (см.
   * `apps/api/src/modules/material-issues/material-issues.service.ts::returnPostedIssue`,
   * `prisma/schema.prisma::MaterialIssueReturn`,
   * `docs/events.md §«Material issues»`).
   *
   *   - `MATERIAL_ISSUE_RETURNED` — менеджер сторнировал
   *     проведённый документ через
   *     `POST /api/material-issues/:id/return`. Пишется в той же
   *     транзакции, что и сам `MaterialIssueReturn` + строки + IN-
   *     движения склада. Payload — `{ materialIssueId,
   *     materialIssueReturnId, orderId, passportId, reason,
   *     totalCost, lines[], employeeId, timestamp }`. `entityId =
   *     MaterialIssueReturn.id`.
   *
   * Удаление / отмена возврата на MVP не реализованы.
   */
  | 'MATERIAL_ISSUE_RETURN'
  /**
   * Движения склада (см. `apps/api/src/modules/stock/*`,
   * `prisma/schema.prisma::StockMovement`,
   * `docs/api.md §«26a. Stock»`,
   * `docs/events.md §«StockMovement»`). На MVP-итерации два
   * аудит-события под `entityType = STOCK_MOVEMENT`:
   *
   *   - `STOCK_ADJUSTMENT_CREATED` — менеджер сохранил корректировку
   *     через UI `/admin/warehouses?tab=balances`. Пишется в той же
   *     транзакции, что и сама запись `StockMovement` ADJUSTMENT и
   *     апдейт `StockBalance`. Payload — `{ stockMovementId,
   *     stockBalanceId, workshopNeedId, warehouseId, cellId, direction,
   *     qty, unit, unitCost, totalCost, balanceBeforeQty,
   *     balanceAfterQty, comment, employeeId, sourceKey, timestamp }`.
   *     `entityId = StockMovement.id`.
   *   - `STOCK_TRANSFER_CREATED` — менеджер сохранил перемещение
   *     остатка через UI `/admin/warehouses?tab=balances`, кнопка
   *     «Переместить». Пишется в той же транзакции, что и пара
   *     `StockMovement` TRANSFER (`OUT` + `IN`). Один event на один
   *     transfer (`entityId = outMovement.id`). Payload —
   *     `{ sourceType, transferId, fromStockBalanceId, toStockBalanceId,
   *     outMovementId, inMovementId, workshopNeedId, qty, unit, from,
   *     to, comment, employeeId, timestamp }`.
   *
   * Автоматические движения (`PURCHASE_RECEIPT` / `MATERIAL_ISSUE` /
   * `REVERSAL`) собственного аудит-события под этим `entityType` не
   * пишут — они уже атрибутированы под `PURCHASE_RECEIPT` /
   * `MATERIAL_ISSUE` соответственно.
   */
  | 'STOCK_MOVEMENT'
  /**
   * Движения готовой продукции (см.
   * `apps/api/src/modules/finished-goods/*`,
   * `prisma/schema.prisma::FinishedGoodsMovement`,
   * `docs/events.md §«Finished goods»`,
   * `docs/current-state.md §«Готовая продукция»`).
   *
   * **Отдельный контур от материалов** — не путать с `STOCK_MOVEMENT`,
   * который покрывает движения материалов (`StockBalance` /
   * `StockMovement`).
   *
   * На MVP-итерации одно автоматическое событие:
   *   - `FINISHED_GOODS_PRODUCTION_RECEIPT_CREATED` —
   *     `FinishedGoodsService.recordPackedPassportInTx` зафиксировал
   *     выпуск готовой продукции в момент `Passport.status = PACKED`.
   *     Пишется в той же транзакции, что и сам перевод паспорта в
   *     `PACKED` (см. `PackingService.addPassport`). Payload —
   *     `{ finishedGoodsMovementId, finishedGoodsBalanceId, orderId,
   *     passportId, boxId, productId, sizeId, color, warehouseId,
   *     cellId, qty, balanceBeforeQty, balanceAfterQty, employeeId,
   *     timestamp }`. `entityId = FinishedGoodsMovement.id`.
   *
   * Идемпотентно: повторный вызов `recordPackedPassportInTx` для уже
   * обработанного паспорта не пишет ни движение, ни audit (защита по
   * `FinishedGoodsMovement.sourceKey @unique` =
   * `PACKED_PASSPORT:<passportId>`).
   */
  | 'FINISHED_GOODS_MOVEMENT'
  /**
   * Документ отгрузки готовой продукции из карточки заказа (см.
   * `apps/api/src/modules/finished-goods/finished-goods.service.ts::createShipmentForOrder`,
   * `prisma/schema.prisma::FinishedGoodsShipment` /
   * `FinishedGoodsShipmentLine`,
   * `docs/events.md §«Finished goods»`,
   * `docs/current-state.md §«Отгрузка готовой продукции»`).
   *
   * **Отдельный контур от материалов.** Не путать с `STOCK_MOVEMENT`
   * и `FINISHED_GOODS_MOVEMENT`: один shipment-документ создаёт N
   * `FinishedGoodsMovement` `type = SHIPMENT, direction = OUT`, но в
   * `AuditLog` пишется ровно одна строка верхнеуровневого события.
   *
   * События:
   *   - `FINISHED_GOODS_SHIPMENT_CREATED` — менеджер создал документ
   *     отгрузки (`POST /api/orders/:orderId/finished-goods-shipments`).
   *     `entityId = FinishedGoodsShipment.id`. Payload —
   *     `{ finishedGoodsShipmentId, number, orderId, shippedAt,
   *     comment, lines: [{ finishedGoodsShipmentLineId,
   *     finishedGoodsBalanceId, productId, sizeId, color,
   *     warehouseId, cellId, qty }], employeeId, timestamp }`.
   *     Пишется в той же транзакции, что и сам документ + N
   *     `FinishedGoodsMovement` SHIPMENT OUT;
   *   - `FINISHED_GOODS_SHIPMENT_CANCELLED` — менеджер отменил ранее
   *     проведённый документ (`POST /api/finished-goods/shipments/:id/cancel`).
   *     `entityId = FinishedGoodsShipment.id`. Payload —
   *     `{ finishedGoodsShipmentId, number, orderId, cancelledAt,
   *     cancelReason, lines: [{ finishedGoodsShipmentLineId,
   *     finishedGoodsBalanceId, productId, sizeId, color, warehouseId,
   *     cellId, qty }], employeeId, timestamp }`. Пишется в той же
   *     транзакции, что и `status → CANCELLED` + N
   *     `FinishedGoodsMovement` REVERSAL IN.
   *
   * Идемпотентно: повторный submit с тем же `clientRequestId`
   * возвращает существующий документ и audit заново НЕ пишет
   * (защита по `FinishedGoodsShipment.sourceKey @unique` =
   * `FINISHED_GOODS_SHIPMENT:<orderId>:<clientRequestId>`). Повторный
   * cancel-вызов на уже отменённом документе тоже идемпотентен —
   * сервис возвращает existing detail и event заново НЕ пишет.
   */
  | 'FINISHED_GOODS_SHIPMENT'
  /**
   * Сигнальный образец (`OrderSample`, MVP, см.
   * `apps/api/src/modules/order-samples/*`,
   * `prisma/schema.prisma::OrderSample`,
   * `docs/order-signal-sample-flow.md`).
   *
   * События:
   *   - `ORDER_SAMPLE_STARTED` — менеджер / помощник раскройщика
   *     запустил образец, `entityId = OrderSample.id`, payload —
   *     `{ orderId, productId, sizeId, qty, materialMode,
   *        countsTowardOrderQty, passportId, passportNumber,
   *        employeeId, timestamp }`. Пишется в той же транзакции,
   *     что и `OrderSample.create` + `PassportsService.create`.
   *   - `ORDER_SAMPLE_APPROVED` — менеджер согласовал. Payload —
   *     `{ orderId, sizeId, qty, countsTowardOrderQty, employeeId,
   *        timestamp }`. `OrderItem.qtyPlan` не мутируется
   *     (см. RECON §10).
   *   - `ORDER_SAMPLE_REJECTED` — менеджер отклонил. Payload —
   *     `{ orderId, rejectionReason, employeeId, timestamp }`.
   *   - `ORDER_SAMPLE_CANCELLED` — менеджер отменил. Payload —
   *     `{ orderId, comment, employeeId, timestamp }`.
   */
  | 'ORDER_SAMPLE'
  /**
   * Карточки сотрудников (`Employee`, см.
   * `apps/api/src/modules/employees/*`,
   * `prisma/schema.prisma::Employee`,
   * `docs/employee-deletion-recon.md`). События архивирования /
   * восстановления / физического удаления:
   *
   *   - `EMPLOYEE_ARCHIVED` — менеджер отправил карточку в архив
   *     (`POST /api/employees/:id/archive`, переход
   *     `active = true → false`). Payload — `{ targetId,
   *     targetSnapshot: { fullName, login, role } }`.
   *   - `EMPLOYEE_RESTORED` — менеджер снял архив
   *     (`POST /api/employees/:id/restore`,
   *     `active = false → true`). Payload — `{ targetId }`.
   *   - `EMPLOYEE_DELETED` — администратор физически удалил карточку
   *     (`DELETE /api/employees/:id`). Карточка пропадает из БД, в
   *     payload сохраняется снимок: `{ targetSnapshot: { fullName,
   *     login, role, createdAt }, hadActiveDisplayConfig?: boolean }`.
   *
   * `entityId` — `Employee.id`. Для `EMPLOYEE_DELETED` id ссылается
   * на уже удалённую строку — это сознательно, чтобы расследование
   * «куда делась учётка X» могло искать по тому же id, что был у
   * сотрудника при жизни.
   */
  | 'EMPLOYEE'
  /**
   * Управленческий справочник операций (см.
   * `apps/api/src/modules/operations/*`, `prisma/schema.prisma::Operation`).
   * Событие — `OPERATION_DELETED` (физическое удаление пустой,
   * нигде не использованной операции; в `payload.targetSnapshot`
   * хранится `{ code, name, category }`). `entityId` — `Operation.id`
   * уже удалённой строки, по тому же принципу, что и `EMPLOYEE_DELETED`.
   * Мягкое «удаление» (`active = false`) идёт через обычный `update`
   * и отдельного аудит-события не имеет.
   *
   * Массовые операции архива со списка `/admin/operations` пишут
   * `OPERATIONS_ARCHIVED` / `OPERATIONS_RESTORED` (одно событие на
   * пачку, список id — в payload) и `OPERATION_DELETED` на каждую
   * удалённую строку (`payload.bulk = true`).
   */
  | 'OPERATION'
  /**
   * Справочники админки с контуром «архив → удалить навсегда» (см.
   * `@sewing/shared/archive`, `common/bulk-archive.ts`). У всех один
   * набор событий:
   *   - `<X>S_ARCHIVED` / `<X>S_RESTORED` — массовая мягкая
   *     архивация/возврат со списка. Одно событие на пачку:
   *     `entityId` — первая запись, полный список id — в payload;
   *   - `<X>_DELETED` — безвозвратное удаление, по событию на запись,
   *     в payload снимок ключевых полей (+ `bulk: true`, если пришло
   *     из массовой операции).
   *
   * `TECH_CARD` — `TechCardTemplate.id` (архив = `isActive = false`);
   * `ROUTE_TEMPLATE` — `RouteTemplate.id` (`isActive`);
   * `CONSTRUCTOR_TASK` — `ConstructorTask.id` (`archivedAt`);
   * `DISPLAY_SCREEN` — `DisplayScreenConfig.id` (`isActive`);
   * `EQUIPMENT` — `Equipment.id` (`active`);
   * `PRINTER` — `Printer.id` (`isActive`).
   */
  | 'TECH_CARD'
  | 'ROUTE_TEMPLATE'
  | 'CONSTRUCTOR_TASK'
  | 'DISPLAY_SCREEN'
  | 'EQUIPMENT'
  | 'PRINTER'
  /**
   * Смены сотрудников (`prisma/schema.prisma::ShiftSession`). Событие —
   * `MASTER_SHIFT_FORCE_CLOSED`: мастер принудительно завершил чужую
   * смену из режима «Активные» вкладки «Сотрудники» кабинета `/master`
   * (см. `apps/api/src/modules/master-employee-stats/*`). `entityId` —
   * `ShiftSession.id`; `employeeId` — мастер-актор, закрываемый
   * сотрудник — в `payload.targetEmployeeId`.
   */
  | 'SHIFT_SESSION'
  /**
   * Значение справочника «Характеристика» строки материала техкарты
   * (см. `apps/api/src/modules/material-characteristic-options/*`,
   * `prisma/schema.prisma::MaterialCharacteristicOption`). События —
   * `MATERIAL_CHARACTERISTIC_OPTION_CREATED` (менеджер пополнил список из
   * комбобокса) и `MATERIAL_CHARACTERISTIC_OPTION_DELETED` (убрал своё
   * значение из подсказок). `entityId` — `MaterialCharacteristicOption.id`.
   * Значения в самих техкартах при удалении не меняются — справочник
   * подсказывает, а не владеет значением строки.
   */
  | 'MATERIAL_CHARACTERISTIC_OPTION';

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
  ): Promise<{ id: string } | null> {
    // Действие через машинный токен ERP: `employeeId` — служебный сотрудник «Интеграция ERP»,
    // а КТО из людей ERP нажал — здесь, в payload. Без этого журнал показывал бы «Интеграция»
    // на каждой строке и восстановить автора было бы нечем (правило §0.1, actor-context.ts).
    const actor = currentActor();
    const payload: Prisma.InputJsonValue =
      actor && input.payload && typeof input.payload === 'object' && !Array.isArray(input.payload)
        ? { ...(input.payload as Prisma.JsonObject), actor: { ...actor } }
        : input.payload;
    const data: Prisma.AuditLogUncheckedCreateInput = {
      event: input.event,
      entityType: input.entityType,
      entityId: input.entityId,
      payload,
      employeeId: input.employeeId ?? null,
    };

    if (tx) {
      // Внутри транзакции: пробрасываем ошибку, чтобы операция и аудит
      // жили атомарно. Если запись в `AuditLog` падает (например, при
      // несовместимой миграции на пилоте) — это структурная проблема,
      // которую лучше увидеть на уровне 500, чем потерять.
      const created = await tx.auditLog.create({
        data,
        select: { id: true },
      });
      return { id: created.id };
    }

    try {
      const created = await this.prisma.auditLog.create({
        data,
        select: { id: true },
      });
      return { id: created.id };
    } catch (err) {
      // Без транзакции: fail-soft. Аудит не должен валить
      // бизнес-операцию, особенно в legacy-сервисах, которые ещё не
      // обернули свой `passportEvent.create` в `$transaction`.
      this.logger.warn(
        `audit.log failed event=${input.event} entityType=${input.entityType} entityId=${input.entityId}: ${(err as Error).message}`,
      );
      return null;
    }
  }
}
