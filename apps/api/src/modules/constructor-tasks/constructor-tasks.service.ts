import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  CONSTRUCTOR_TASK_FILE_MAX_COUNT,
  COMPLETE_CONSTRUCTOR_TASK_FILE_FIELD_PREFIX,
  generateDraftPatternArticle,
  generateDraftPatternName,
  type CompleteConstructorTaskDto,
  type ConstructorTaskDetailDto,
  type ConstructorTaskFileDirection,
  type ConstructorTaskFileDto,
  type ConstructorTaskListScope,
  type ConstructorTaskSizeRowDto,
  type ConstructorTaskSummaryDto,
  type CreateConstructorTaskForPatternDto,
  type SaveConstructorDraftDto,
  type SaveConstructorDraftResultDto,
} from '@sewing/shared/constructor-tasks';

import type { BulkArchiveResultDto } from '@sewing/shared/archive';

import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { indexById, runBulkArchive } from '../../common/bulk-archive.js';
import {
  ConstructorTaskAcceptInvalidException,
  ConstructorTaskAlreadyExistsException,
  ConstructorTaskAssignedToOtherException,
  ConstructorTaskCompleteFilesMismatchException,
  ConstructorTaskFileInvalidException,
  ConstructorTaskInvalidTransitionException,
  ConstructorTaskNotFoundException,
  ConstructorTaskNotInProgressException,
  ConstructorTaskReworkInvalidException,
  ConstructorTaskSizeNotFoundException,
  ClientInactiveException,
  ClientNotFoundException,
  PatternNotFoundException,
} from '../../common/errors.js';
import { ConstructorTasksStorageService } from './constructor-tasks-storage.service.js';
import { mapConstructorTaskSummary } from './constructor-task-mappers.js';
import { OrderNumberService } from '../orders/order-number.service.js';
import {
  PatternsStorageService,
  type UploadedFileLike,
} from '../patterns/patterns-storage.service.js';

/**
 * Сервис «Заявка конструктору».
 *
 * Главное публичное действие — `saveDraft(...)` — создаёт за одну
 * Prisma-транзакцию:
 *   - `PatternItem` со `status='DRAFT'` (автогенерация name/article);
 *   - `PatternMaterialArea[]` для каждой строки таблицы (по конверсии
 *     `areaM2 = linearMeters × CONSTRUCTOR_TASK_DEFAULT_FABRIC_WIDTH_M`);
 *   - `ConstructorTask` со `status='NEW'`;
 *   - `ConstructorTaskSizeRow[]`;
 *   - `ConstructorTaskFile[]`.
 *
 * Файлы кладёт на диск ПЕРЕД транзакцией (storage не транзакционен).
 * Если транзакция падает — файлы остаются как orphan-ы (cleanup-job
 * подберёт их потом). Это стандартная практика в проекте, см.
 * `TechCardsStorageService`.
 */
@Injectable()
export class ConstructorTasksService {
  private readonly logger = new Logger(ConstructorTasksService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: ConstructorTasksStorageService,
    private readonly patternsStorage: PatternsStorageService,
    private readonly orderNumbers: OrderNumberService,
    private readonly audit: AuditService,
  ) {}

  // ---------------------------------------------------------------------------
  // АРХИВ ЗАЯВОК — bulk archive / restore / purge
  // ---------------------------------------------------------------------------
  //
  // Общий контур справочников админки (`@sewing/shared/archive`).
  // Признак архива — `ConstructorTask.archivedAt` (отдельное поле, а не
  // статус: `status` описывает ход работы КБ и переписывать его ради
  // «убрать с глаз» нельзя — см. комментарий в schema.prisma).
  //
  // purge удаляет саму заявку; строки размеров и вложения уходят
  // каскадом. DRAFT-лекало (`PatternItem`), из-за которого заявка и
  // появилась, НЕ трогаем — оно живёт своей жизнью в номенклатуре и
  // может быть привязано к заказу. Файлы на диске остаются (как и в
  // остальных разделах — физический GC out-of-scope).

  async archiveMany(
    ids: string[],
    actorEmployeeId?: string | null,
  ): Promise<BulkArchiveResultDto> {
    const res = await runBulkArchive({
      ids,
      load: async (want) =>
        indexById(
          await this.prisma.constructorTask.findMany({
            where: { id: { in: want } },
            select: { id: true, archivedAt: true },
          }),
        ),
      alreadyDone: (row) => row.archivedAt !== null,
      gate: () => null,
      apply: async (_rows, targetIds) => {
        const now = new Date();
        await this.prisma.$transaction(async (tx) => {
          await tx.constructorTask.updateMany({
            where: { id: { in: targetIds } },
            data: { archivedAt: now },
          });
          await this.audit.log(
            {
              event: 'CONSTRUCTOR_TASKS_ARCHIVED',
              entityType: 'CONSTRUCTOR_TASK',
              entityId: targetIds[0],
              employeeId: actorEmployeeId ?? null,
              payload: { taskIds: targetIds },
            },
            tx,
          );
        });
      },
    });
    this.logger.log(
      `event=constructor_task.archive processed=${res.processed.length} skipped=${res.skipped.length}`,
    );
    return res;
  }

  async restoreMany(
    ids: string[],
    actorEmployeeId?: string | null,
  ): Promise<BulkArchiveResultDto> {
    const res = await runBulkArchive({
      ids,
      load: async (want) =>
        indexById(
          await this.prisma.constructorTask.findMany({
            where: { id: { in: want } },
            select: { id: true, archivedAt: true },
          }),
        ),
      alreadyDone: (row) => row.archivedAt === null,
      gate: () => null,
      apply: async (_rows, targetIds) => {
        await this.prisma.$transaction(async (tx) => {
          await tx.constructorTask.updateMany({
            where: { id: { in: targetIds } },
            data: { archivedAt: null },
          });
          await this.audit.log(
            {
              event: 'CONSTRUCTOR_TASKS_RESTORED',
              entityType: 'CONSTRUCTOR_TASK',
              entityId: targetIds[0],
              employeeId: actorEmployeeId ?? null,
              payload: { taskIds: targetIds },
            },
            tx,
          );
        });
      },
    });
    this.logger.log(
      `event=constructor_task.restore processed=${res.processed.length} skipped=${res.skipped.length}`,
    );
    return res;
  }

  async purgeMany(
    ids: string[],
    actorEmployeeId?: string | null,
  ): Promise<BulkArchiveResultDto> {
    const res = await runBulkArchive({
      ids,
      load: async (want) =>
        indexById(
          await this.prisma.constructorTask.findMany({
            where: { id: { in: want } },
            select: {
              id: true,
              status: true,
              archivedAt: true,
              patternItem: { select: { name: true, article: true } },
            },
          }),
        ),
      gate: (row) =>
        row.archivedAt === null ? { reason: 'NOT_ARCHIVED' as const } : null,
      apply: async (rows) => {
        for (const row of rows) {
          await this.prisma.$transaction(async (tx) => {
            await tx.constructorTask.delete({ where: { id: row.id } });
            await this.audit.log(
              {
                event: 'CONSTRUCTOR_TASK_DELETED',
                entityType: 'CONSTRUCTOR_TASK',
                entityId: row.id,
                employeeId: actorEmployeeId ?? null,
                payload: {
                  status: row.status,
                  patternName: row.patternItem?.name ?? null,
                  patternArticle: row.patternItem?.article ?? null,
                  bulk: true,
                },
              },
              tx,
            );
          });
        }
      },
    });
    this.logger.log(
      `event=constructor_task.purge processed=${res.processed.length} skipped=${res.skipped.length}`,
    );
    return res;
  }

  // ---------------------------------------------------------------------------
  // CREATE / SAVE DRAFT
  // ---------------------------------------------------------------------------

  /**
   * Создать DRAFT-PatternItem + ConstructorTask + материальные area
   * + строки таблицы + файлы. Возвращает результат, который
   * `saveConstructorDraftAction` отдаёт в parent-форму заказа.
   *
   * @param dto      — провалидированный payload (zod).
   * @param files    — массив multipart-файлов; может быть пуст.
   * @param actorEmployeeId — id сотрудника-инициатора (для createdById).
   */
  async saveDraft(
    dto: SaveConstructorDraftDto,
    files: UploadedFileLike[],
    actorEmployeeId: string | null,
    createDraftOrder: boolean = false,
  ): Promise<SaveConstructorDraftResultDto> {
    if (files.length > CONSTRUCTOR_TASK_FILE_MAX_COUNT) {
      throw new ConstructorTaskFileInvalidException(
        `Слишком много файлов: лимит ${CONSTRUCTOR_TASK_FILE_MAX_COUNT}.`,
      );
    }

    // 1) Резолвим категорию (для name) и валидируем все sizeId.
    //    Sizes в task-таблице (м пог.) и в calcPayload.sizes (м²)
    //    приходят из одного и того же набора размеров заказа, но
    //    мы валидируем оба множества — защита от рассинхрона UI.
    const allSizeIds = Array.from(
      new Set([
        ...dto.sizeRows.map((r) => r.sizeId),
        ...dto.calcPayload.sizes.map((s) => s.sizeId),
      ]),
    );
    const [category, foundSizes] = await Promise.all([
      dto.calcPayload.categoryId
        ? this.prisma.patternCategory.findUnique({
            where: { id: dto.calcPayload.categoryId },
            select: { id: true, name: true },
          })
        : Promise.resolve(null),
      this.prisma.size.findMany({
        where: { id: { in: allSizeIds } },
        select: { id: true, code: true },
      }),
    ]);
    const sizeById = new Map(foundSizes.map((s) => [s.id, s]));
    for (const id of allSizeIds) {
      if (!sizeById.has(id)) {
        throw new ConstructorTaskSizeNotFoundException(id);
      }
    }

    // Этап «Клиент — обязательный атрибут заказа»: клиент из блока
    // «Основное» формы создания заказа долетает сюда, только когда мы
    // заводим DRAFT-заказ (`createDraftOrder`). Валидируем до открытия
    // транзакции — адресная ошибка вместо FK-сбоя, как в
    // `OrdersService.assertClientUsable`.
    if (createDraftOrder && dto.clientId) {
      const client = await this.prisma.client.findUnique({
        where: { id: dto.clientId },
        select: { id: true, isActive: true },
      });
      if (!client) throw new ClientNotFoundException();
      if (!client.isActive) throw new ClientInactiveException();
    }

    const draftName = generateDraftPatternName(category?.name ?? null);
    const draftArticle = generateDraftPatternArticle();

    // 2) Phase 1: создаём PatternItem (DRAFT) + Task + sizeRows
    //    + PatternMaterialArea[] из calc-payload в одной транзакции.
    //    Файлы добавим вторым шагом (они не транзакционные).
    const created = await this.prisma.$transaction(async (tx) => {
      const pattern = await tx.patternItem.create({
        data: {
          name: draftName,
          article: draftArticle,
          status: 'DRAFT',
          categoryId: dto.calcPayload.categoryId ?? null,
        },
        select: { id: true, name: true, article: true },
      });

      const task = await tx.constructorTask.create({
        data: {
          patternItemId: pattern.id,
          status: 'NEW',
          comment: dto.comment,
          createdById: actorEmployeeId,
          submittedAt: new Date(),
          sizeRows: {
            createMany: {
              data: dto.sizeRows.map((row, idx) => ({
                sortOrder: (idx + 1) * 10,
                sizeId: row.sizeId,
                sizeCodeSnapshot: row.sizeCodeSnapshot,
                kulirkaMeters:
                  row.kulirkaMeters == null
                    ? null
                    : new Prisma.Decimal(row.kulirkaMeters),
                kashkorseMeters:
                  row.kashkorseMeters == null
                    ? null
                    : new Prisma.Decimal(row.kashkorseMeters),
              })),
            },
          },
        },
        select: { id: true },
      });

      // PatternMaterialArea[] — берём ТОЛЬКО из calc-payload (м²).
      // Это ровно те же значения, что менеджер вводил во вкладке
      // «Сделать расчёт» — никакой конверсии м пог → м² не делаем
      // (см. ТЗ: «Отправить тянет данные из сохранённого изделия»).
      // Сами м пог (Кулирка/Кашкорсе) хранятся в ConstructorTaskSizeRow
      // и при возврате лекала от конструктора попадут в
      // PatternItemSizeParameterValue.
      const areaRows: Prisma.PatternMaterialAreaCreateManyInput[] = [];
      for (const row of dto.calcPayload.sizes) {
        for (const area of row.areas) {
          areaRows.push({
            patternItemId: pattern.id,
            sizeId: row.sizeId,
            materialRole: area.roleKey,
            areaM2: new Prisma.Decimal(area.areaM2),
          });
        }
      }
      if (areaRows.length > 0) {
        await tx.patternMaterialArea.createMany({ data: areaRows });
      }

      // Опциональный шаг: создать DRAFT-Order и привязать к нему
      // только что созданный pattern. Используется при «Отправить
      // конструктору» из формы создания заказа `/admin/orders/new` —
      // без этого мы получаем orphan-task без связки с заказом.
      // Заказ создаётся минимально:
      //   - `number` через `OrderNumberService.nextNumber(tx)`;
      //   - `orderDate = now`, всё остальное опционально (DRAFT можно
      //     дозаполнить на edit-странице);
      //   - `items` строятся из `dto.calcPayload.sizes` — там у каждого
      //     размера уже есть `qtyPlan`, ровно тот, что менеджер ввёл
      //     на вкладке «Сделать расчёт» в той же модалке;
      //   - `productCreationMode = 'SEND_TO_CONSTRUCTOR'` — UI карточки
      //     заказа знает, что лекало пока в разработке.
      //
      // Inline создаём legacy `Product` (`PatternItem.legacyProductId`).
      // НЕ переиспользуем `OrdersService.ensureLegacyProductForPattern`,
      // потому что тот валидирует `status === 'ACTIVE'`, а у нас
      // pattern как раз DRAFT — это сознательное состояние. Логика
      // создания Product повторяет ensure-helper минимально.
      let createdOrderId: string | null = null;
      if (createDraftOrder) {
        const product = await tx.product.create({
          data: {
            name: pattern.name,
            color: '',
            active: true,
          },
          select: { id: true },
        });
        await tx.patternItem.update({
          where: { id: pattern.id },
          data: { legacyProductId: product.id },
        });
        const number = await this.orderNumbers.nextNumber(tx);
        const order = await tx.order.create({
          data: {
            number,
            orderDate: new Date(),
            status: 'DRAFT',
            patternItemId: pattern.id,
            // Этап «Клиент — обязательный атрибут заказа»: клиент
            // выбран в блоке
            // «Основное» той же формы, и если его здесь потерять, заказ
            // упрётся в `ORDER_CLIENT_REQUIRED` на «Перевести в расчёт».
            clientId: dto.clientId ?? null,
            productCreationMode: 'SEND_TO_CONSTRUCTOR',
            // Стоимость разработки лекала + чекбокс «входит в
            // себестоимость» протягиваем из calc-вкладки так же, как
            // CREATE_FOR_CALCULATION (`OrdersService.create`). Без
            // этого заказ из flow КБ не получал строку «Разработка
            // лекала» в `OrderCostEstimate`.
            patternDevelopmentCostRub:
              dto.calcPayload.patternDevelopmentCostRub == null
                ? null
                : new Prisma.Decimal(
                    dto.calcPayload.patternDevelopmentCostRub,
                  ),
            patternDevelopmentCostInCostPrice:
              dto.calcPayload.patternDevelopmentCostInCostPrice ?? true,
            items: {
              createMany: {
                data: dto.calcPayload.sizes.map((s) => ({
                  productId: product.id,
                  sizeId: s.sizeId,
                  qtyPlan: s.qtyPlan,
                })),
              },
            },
          },
          select: { id: true },
        });
        createdOrderId = order.id;
      }

      return {
        taskId: task.id,
        patternItemId: pattern.id,
        patternName: pattern.name,
        patternArticle: pattern.article,
        orderId: createdOrderId,
      };
    });

    // 4) Phase 2: грузим файлы на диск и добавляем записи о них.
    //    Если на этом этапе что-то падает — задача и pattern уже
    //    созданы; файлы недогружены — менеджер увидит частичный
    //    результат и сможет дозагрузить позднее (через UI редактирования
    //    задачи, который появится в следующих PR). Для MVP считаем
    //    это допустимым.
    let filesCount = 0;
    if (files.length > 0) {
      const savedFiles: Array<{
        publicUrl: string;
        originalFileName: string;
        contentType: string;
        sizeBytes: number;
      }> = [];
      for (const file of files) {
        const saved = await this.storage.saveTaskFile(created.taskId, file);
        savedFiles.push(saved);
      }
      await this.prisma.constructorTaskFile.createMany({
        data: savedFiles.map((s) => ({
          taskId: created.taskId,
          fileUrl: s.publicUrl,
          originalFileName: s.originalFileName,
          contentType: s.contentType,
          sizeBytes: s.sizeBytes,
        })),
      });
      filesCount = savedFiles.length;
    }

    return {
      taskId: created.taskId,
      patternItemId: created.patternItemId,
      patternName: created.patternName,
      patternArticle: created.patternArticle,
      sizeRowsCount: dto.sizeRows.length,
      filesCount,
      orderId: created.orderId,
    };
  }

  /**
   * Создать `ConstructorTask` (status=NEW) для УЖЕ существующего
   * лекала (`PatternItem`). В отличие от {@link saveDraft}, НЕ создаёт
   * новое лекало и НЕ трогает `PatternMaterialArea` (площади уже у
   * лекала). Используется, когда менеджер отправляет конструктору
   * номенклатуру, заведённую через «Сохранить изделие» (она ACTIVE в
   * БД, но реального файла лекала нет) — из карточки заказа
   * `/admin/orders/[id]/edit` или карточки номенклатуры
   * `/admin/patterns/[id]`.
   *
   * Статус лекала намеренно НЕ меняем: `accept`/`complete` всё равно
   * нормализуют его в `ACTIVE`, а до готовности файла крой и так
   * блокируется (нет `PatternSizeFile.fileUrl`). `ConstructorTask`
   * 1:1 с лекалом (`@unique`), поэтому при наличии уже созданной
   * задачи возвращаем 409 `CONSTRUCTOR_TASK_ALREADY_EXISTS`.
   *
   * @param dto      — провалидированный payload (zod): patternItemId,
   *                   comment, sizeRows.
   * @param files    — массив multipart-файлов; может быть пуст.
   * @param actorEmployeeId — id сотрудника-инициатора (createdById).
   */
  async createForExistingPattern(
    dto: CreateConstructorTaskForPatternDto,
    files: UploadedFileLike[],
    actorEmployeeId: string | null,
  ): Promise<SaveConstructorDraftResultDto> {
    if (files.length > CONSTRUCTOR_TASK_FILE_MAX_COUNT) {
      throw new ConstructorTaskFileInvalidException(
        `Слишком много файлов: лимит ${CONSTRUCTOR_TASK_FILE_MAX_COUNT}.`,
      );
    }

    // 1) Лекало должно существовать; задачи у него ещё быть не должно
    //    (1:1). Параллельно валидируем все sizeId таблицы.
    const [pattern, existingTask, foundSizes] = await Promise.all([
      this.prisma.patternItem.findUnique({
        where: { id: dto.patternItemId },
        select: { id: true, name: true, article: true },
      }),
      this.prisma.constructorTask.findUnique({
        where: { patternItemId: dto.patternItemId },
        select: { id: true },
      }),
      this.prisma.size.findMany({
        where: { id: { in: dto.sizeRows.map((r) => r.sizeId) } },
        select: { id: true },
      }),
    ]);
    if (!pattern) throw new PatternNotFoundException();
    if (existingTask) throw new ConstructorTaskAlreadyExistsException();
    const foundSizeIds = new Set(foundSizes.map((s) => s.id));
    for (const row of dto.sizeRows) {
      if (!foundSizeIds.has(row.sizeId)) {
        throw new ConstructorTaskSizeNotFoundException(row.sizeId);
      }
    }

    // 2) Создаём задачу + строки размеров (площади НЕ трогаем —
    //    они уже у лекала). Транзакция не обязательна (одна запись с
    //    nested create), но оставляем для атомарности sizeRows.
    const task = await this.prisma.constructorTask.create({
      data: {
        patternItemId: pattern.id,
        status: 'NEW',
        comment: dto.comment,
        createdById: actorEmployeeId,
        submittedAt: new Date(),
        sizeRows: {
          createMany: {
            data: dto.sizeRows.map((row, idx) => ({
              sortOrder: (idx + 1) * 10,
              sizeId: row.sizeId,
              sizeCodeSnapshot: row.sizeCodeSnapshot,
              kulirkaMeters:
                row.kulirkaMeters == null
                  ? null
                  : new Prisma.Decimal(row.kulirkaMeters),
              kashkorseMeters:
                row.kashkorseMeters == null
                  ? null
                  : new Prisma.Decimal(row.kashkorseMeters),
            })),
          },
        },
      },
      select: { id: true },
    });

    // 3) Файлы — вторым шагом (storage не транзакционен), идентично
    //    `saveDraft`.
    let filesCount = 0;
    if (files.length > 0) {
      const savedFiles: Array<{
        publicUrl: string;
        originalFileName: string;
        contentType: string;
        sizeBytes: number;
      }> = [];
      for (const file of files) {
        const saved = await this.storage.saveTaskFile(task.id, file);
        savedFiles.push(saved);
      }
      await this.prisma.constructorTaskFile.createMany({
        data: savedFiles.map((s) => ({
          taskId: task.id,
          fileUrl: s.publicUrl,
          originalFileName: s.originalFileName,
          contentType: s.contentType,
          sizeBytes: s.sizeBytes,
        })),
      });
      filesCount = savedFiles.length;
    }

    return {
      taskId: task.id,
      patternItemId: pattern.id,
      patternName: pattern.name,
      patternArticle: pattern.article,
      sizeRowsCount: dto.sizeRows.length,
      filesCount,
      orderId: null,
    };
  }

  // ---------------------------------------------------------------------------
  // READ (admin pages)
  // ---------------------------------------------------------------------------

  async list(search?: string): Promise<ConstructorTaskSummaryDto[]> {
    // Поиск по заявке КБ — регистронезависимый частичный матч по
    // изделию (имя/артикул лекала) и автору заявки. Сами эти поля лежат
    // на связях (`patternItem`, `createdBy`), поэтому фильтруем через них.
    const q = search?.trim();
    const where: Prisma.ConstructorTaskWhereInput =
      q && q.length > 0
        ? {
            OR: [
              { patternItem: { is: { name: { contains: q, mode: 'insensitive' } } } },
              { patternItem: { is: { article: { contains: q, mode: 'insensitive' } } } },
              { createdBy: { is: { fullName: { contains: q, mode: 'insensitive' } } } },
            ],
          }
        : {};
    const tasks = await this.prisma.constructorTask.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: {
        patternItem: { select: { name: true, article: true } },
        createdBy: { select: { fullName: true } },
        assignedTo: { select: { fullName: true } },
        _count: { select: { files: true, sizeRows: true } },
      },
    });
    return tasks.map((t) => this.toSummary(t));
  }

  /**
   * Отмена заявки конструктору. Статус переводится в `CANCELLED`,
   * сама запись остаётся для аудита/истории. DRAFT-pattern мы НЕ
   * трогаем — он может быть привязан к уже созданному заказу
   * (Order.patternItemId), и удаление сломает заказ. Менеджер
   * архивирует pattern отдельно на `/admin/patterns/<id>` (см. UI
   * номенклатуры).
   *
   * Идемпотентен: повторный cancel в `CANCELLED`-задаче — no-op.
   * Cancel задачи в `DONE` — отдельная ошибка (лекало уже готово,
   * отменять нечего).
   */
  async cancel(id: string): Promise<ConstructorTaskDetailDto> {
    const existing = await this.prisma.constructorTask.findUnique({
      where: { id },
      select: { id: true, status: true },
    });
    if (!existing) throw new ConstructorTaskNotFoundException();
    if (existing.status === 'DONE') {
      throw new ConstructorTaskInvalidTransitionException(
        'Нельзя отменить завершённую заявку — лекало уже передано',
      );
    }
    if (existing.status !== 'CANCELLED') {
      await this.prisma.constructorTask.update({
        where: { id },
        data: { status: 'CANCELLED' },
      });
    }
    return this.getOne(id);
  }

  async getOne(id: string): Promise<ConstructorTaskDetailDto> {
    const task = await this.prisma.constructorTask.findUnique({
      where: { id },
      include: {
        patternItem: { select: { name: true, article: true } },
        createdBy: { select: { fullName: true } },
        assignedTo: { select: { fullName: true } },
        sizeRows: { orderBy: { sortOrder: 'asc' } },
        files: { orderBy: { createdAt: 'asc' } },
      },
    });
    if (!task) throw new ConstructorTaskNotFoundException();
    return {
      ...this.toSummary({
        ...task,
        _count: {
          files: task.files.length,
          sizeRows: task.sizeRows.length,
        },
      }),
      sizeRows: task.sizeRows.map((r): ConstructorTaskSizeRowDto => ({
        id: r.id,
        sortOrder: r.sortOrder,
        sizeId: r.sizeId,
        sizeCodeSnapshot: r.sizeCodeSnapshot,
        kulirkaMeters: r.kulirkaMeters == null ? null : r.kulirkaMeters.toFixed(4),
        kashkorseMeters:
          r.kashkorseMeters == null ? null : r.kashkorseMeters.toFixed(4),
      })),
      files: task.files.map((f): ConstructorTaskFileDto => ({
        id: f.id,
        fileUrl: f.fileUrl,
        originalFileName: f.originalFileName,
        contentType: f.contentType,
        sizeBytes: f.sizeBytes,
        createdAt: f.createdAt.toISOString(),
        direction: this.normalizeDirection(f.direction),
      })),
    };
  }

  /**
   * Старые `ConstructorTaskFile`-записи (до введения поля
   * `direction`) лежат с `null`. UI трактует их как `INITIAL`
   * (бриф от менеджера) — это исторически правильно. Здесь нормализуем
   * unknown-string значения тоже к union-типу.
   */
  private normalizeDirection(raw: string | null): ConstructorTaskFileDirection {
    if (raw === 'REWORK') return 'REWORK';
    if (raw === 'INITIAL') return 'INITIAL';
    return null;
  }

  // ---------------------------------------------------------------------------
  // CONSTRUCTOR CABINET (`apps/web/app/constructor/`)
  // ---------------------------------------------------------------------------

  /**
   * Список задач для кабинета конструктора. См.
   * `ConstructorTaskListScope`:
   *   - `mine` — назначенные на текущего конструктора (NEW + IN_PROGRESS);
   *   - `pool` — общий пул свободных (assignedToId IS NULL и status NEW);
   *   - `all`  — `mine ∪ pool` (default экрана списка).
   *
   * `DONE` и `CANCELLED` сейчас не показываем — для конструктора задача
   * после завершения «уходит из кабинета», менеджер видит её в
   * `/admin/constructor-tasks`. История завершённых конструктором задач
   * — отдельный срез на будущее (см. ТЗ кабинета: scope MVP).
   */
  async listForConstructor(
    employeeId: string,
    scope: ConstructorTaskListScope,
  ): Promise<ConstructorTaskSummaryDto[]> {
    // Активные для конструктора статусы — все, кроме DONE/CANCELLED.
    // REWORK и PENDING_ACCEPT тоже его касаются: REWORK — нужно
    // продолжать работу; PENDING_ACCEPT — ждёт приёмки, но конструктор
    // должен видеть «висящие» задачи.
    const ACTIVE_STATUSES = ['NEW', 'IN_PROGRESS', 'REWORK', 'PENDING_ACCEPT'];
    const where: Prisma.ConstructorTaskWhereInput = (() => {
      if (scope === 'mine') {
        return {
          assignedToId: employeeId,
          status: { in: ACTIVE_STATUSES },
        };
      }
      if (scope === 'pool') {
        return { assignedToId: null, status: 'NEW' };
      }
      // `all`
      return {
        OR: [
          {
            assignedToId: employeeId,
            status: { in: ACTIVE_STATUSES },
          },
          { assignedToId: null, status: 'NEW' },
        ],
      };
    })();

    const tasks = await this.prisma.constructorTask.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: {
        patternItem: { select: { name: true, article: true } },
        createdBy: { select: { fullName: true } },
        assignedTo: { select: { fullName: true } },
        _count: { select: { files: true, sizeRows: true } },
      },
    });
    return tasks.map((t) => this.toSummary(t));
  }

  /**
   * «Взять задачу в работу» из кабинета конструктора.
   *
   * Идемпотентен:
   *   - если задача уже принадлежит этому же конструктору и в
   *     `IN_PROGRESS` — просто возвращаем актуальную карточку;
   *   - если в `NEW` и не назначена никому — назначаем текущего и
   *     переводим в `IN_PROGRESS`;
   *   - если назначена другому — `ConstructorTaskAssignedToOtherException`
   *     (только когда `enforceOwnership = true`; для ADMIN/SHOP_MANAGER
   *     ручка работает как «забрать на себя»);
   *   - если уже `DONE`/`CANCELLED` — `ConstructorTaskInvalidTransitionException`.
   *
   * Поле `submittedAt` не меняем: это фиксированный момент
   * «менеджер нажал Сохранить изделие», конструктор assign-ом его не
   * переоткрывает.
   */
  async assignSelf(
    taskId: string,
    employeeId: string,
    enforceOwnership: boolean,
  ): Promise<ConstructorTaskDetailDto> {
    const existing = await this.prisma.constructorTask.findUnique({
      where: { id: taskId },
      select: { id: true, status: true, assignedToId: true },
    });
    if (!existing) throw new ConstructorTaskNotFoundException();

    if (existing.status === 'DONE' || existing.status === 'CANCELLED') {
      throw new ConstructorTaskInvalidTransitionException(
        existing.status === 'DONE'
          ? 'Задача уже завершена'
          : 'Задача отменена менеджером',
      );
    }
    if (existing.status === 'PENDING_ACCEPT') {
      throw new ConstructorTaskInvalidTransitionException(
        'Задача уже отправлена на приёмку — дождитесь решения менеджера',
      );
    }

    if (
      enforceOwnership &&
      existing.assignedToId &&
      existing.assignedToId !== employeeId
    ) {
      throw new ConstructorTaskAssignedToOtherException();
    }

    // Допустимые исходные статусы:
    //   - NEW    — задача из общего пула;
    //   - REWORK — менеджер вернул на доработку (своя или unassigned).
    // В обоих случаях приводим к IN_PROGRESS и фиксируем владельца.
    const alreadyMineAndInProgress =
      existing.assignedToId === employeeId && existing.status === 'IN_PROGRESS';
    if (!alreadyMineAndInProgress) {
      await this.prisma.constructorTask.update({
        where: { id: taskId },
        data: { assignedToId: employeeId, status: 'IN_PROGRESS' },
      });
    }
    return this.getOne(taskId);
  }

  /**
   * Обновить `comment` задачи. На MVP комментарий — единое поле для
   * менеджера и конструктора (не diff, не append): новое значение
   * перезаписывает прежнее. Если конструктору важно сохранить
   * исходный текст менеджера, он копирует его сам. Это сознательно
   * простая модель — комментарии-история отдельным потоком на будущее.
   *
   * `enforceOwnership = true` гарантирует, что обычный CONSTRUCTOR
   * меняет только то, что назначено лично ему. ADMIN/SHOP_MANAGER
   * этот guard пропускает.
   */
  async updateComment(
    taskId: string,
    employeeId: string,
    comment: string,
    enforceOwnership: boolean,
  ): Promise<ConstructorTaskDetailDto> {
    const existing = await this.prisma.constructorTask.findUnique({
      where: { id: taskId },
      select: { id: true, status: true, assignedToId: true },
    });
    if (!existing) throw new ConstructorTaskNotFoundException();
    if (existing.status === 'DONE' || existing.status === 'CANCELLED') {
      throw new ConstructorTaskInvalidTransitionException(
        'Нельзя править комментарий завершённой/отменённой задачи',
      );
    }
    if (
      enforceOwnership &&
      existing.assignedToId &&
      existing.assignedToId !== employeeId
    ) {
      throw new ConstructorTaskAssignedToOtherException();
    }
    await this.prisma.constructorTask.update({
      where: { id: taskId },
      data: { comment },
    });
    return this.getOne(taskId);
  }

  /**
   * Завершить задачу: загрузить готовые DXF-лекала (по одному на каждый
   * размер из `task.sizeRows`), записать `PatternSizeFile` для каждого,
   * перевести `ConstructorTask.status` IN_PROGRESS → **PENDING_ACCEPT**.
   *
   * **PatternItem.status НЕ меняется здесь** — лекало активирует
   * менеджер через `accept()`. Это сознательный гейт качества: до
   * приёмки заказ не уйдёт в производство (`OrdersService.assertPatternUsable`
   * требует `status='ACTIVE'`).
   *
   * Гарантии:
   *   - задача обязана быть `IN_PROGRESS` (`assignSelf` сначала; для
   *     REWORK конструктор тоже делает `assignSelf` → IN_PROGRESS);
   *   - задача обязана принадлежать текущему конструктору, если
   *     `enforceOwnership = true`;
   *   - `payload.sizeFiles` может ссылаться ТОЛЬКО на размеры задачи
   *     (лишние отвергаем); «недогруженные» размеры допустимы;
   *   - все `Size` существуют (защита от подделки);
   *   - если для размера указан `fileFieldName` — файл обязан быть в
   *     multipart `files`.
   *
   * Файл лекала НЕобязателен: завершаем по всем размерам задачи, и для
   * размера без файла создаётся строка-заглушка (`fileUrl = null`).
   * Файл (PDF/PLT/DXF/PLO) догрузят позже — в т.ч. после запуска заказа.
   *
   * Phase 1 (вне транзакции): валидируем, грузим присланные файлы через
   * `PatternsStorageService.saveSizeFile` (он сам валидирует
   * расширение PDF/PLT/DXF/PLO и размер).
   *
   * Phase 2 (одна транзакция):
   *   - читаем актуальную `version` для каждого `(patternItemId, sizeId)`
   *     (`max(version) + 1`, или `1` если записей не было);
   *   - createMany(PatternSizeFile) с `status='ACTIVE'`,
   *     `uploadedById = employeeId`;
   *   - update(ConstructorTask.status = 'PENDING_ACCEPT', acceptedAt = null).
   *
   * Если Phase 2 падает — файлы остаются orphan-ами на диске
   * (стандартный паттерн проекта). UI повторно не загрузит — операция
   * считается провалившейся целиком.
   */
  async complete(
    taskId: string,
    employeeId: string,
    payload: CompleteConstructorTaskDto,
    files: UploadedFileLike[],
    enforceOwnership: boolean,
  ): Promise<ConstructorTaskDetailDto> {
    const existing = await this.prisma.constructorTask.findUnique({
      where: { id: taskId },
      select: {
        id: true,
        status: true,
        assignedToId: true,
        patternItemId: true,
        sizeRows: { select: { sizeId: true, sizeCodeSnapshot: true } },
      },
    });
    // (комментарий ниже про допустимые статусы)
    if (!existing) throw new ConstructorTaskNotFoundException();
    // Допускаем complete для IN_PROGRESS и REWORK: REWORK — это «возврат
    // в работу», конструктор может сразу приложить новую версию DXF без
    // отдельного нажатия «Взять в работу». Phase 2 transactionally
    // зафиксирует владельца, если REWORK был unassigned.
    if (
      existing.status !== 'IN_PROGRESS' &&
      existing.status !== 'REWORK'
    ) {
      throw new ConstructorTaskNotInProgressException();
    }
    if (
      enforceOwnership &&
      existing.assignedToId &&
      existing.assignedToId !== employeeId
    ) {
      throw new ConstructorTaskAssignedToOtherException();
    }

    // 1) Набор размеров задачи. Завершаем по ВСЕМ размерам задачи —
    //    для каждого создадим строку PatternSizeFile (с файлом или
    //    заглушкой). Файл лекала необязателен: его можно догрузить позже.
    const taskSizeIds = new Set(
      existing.sizeRows
        .map((r) => r.sizeId)
        .filter((id): id is string => id != null),
    );
    const payloadSizeIds = new Set(payload.sizeFiles.map((sf) => sf.sizeId));

    // payload может ссылаться ТОЛЬКО на размеры задачи (защита от
    // подделки). «Недогруженные» размеры теперь допустимы — они
    // зарегистрируются как заглушки.
    const extra = [...payloadSizeIds].filter((sid) => !taskSizeIds.has(sid));
    if (extra.length > 0) {
      throw new ConstructorTaskCompleteFilesMismatchException(
        `лишние размеры в payload: ${extra.join(', ')}`,
      );
    }

    // 2) Маппим multipart-файлы по fieldname и связываем sizeId → файл.
    const filesByFieldName = new Map<string, UploadedFileLike>();
    for (const file of files) {
      filesByFieldName.set(file.fieldname, file);
    }
    const expectedPrefix = COMPLETE_CONSTRUCTOR_TASK_FILE_FIELD_PREFIX;
    const fileBySizeId = new Map<string, UploadedFileLike>();
    for (const sf of payload.sizeFiles) {
      if (!sf.fileFieldName.startsWith(expectedPrefix)) {
        throw new ConstructorTaskCompleteFilesMismatchException(
          `Поле ${sf.fileFieldName} не имеет обязательного префикса ${expectedPrefix}`,
        );
      }
      const file = filesByFieldName.get(sf.fileFieldName);
      if (!file) {
        throw new ConstructorTaskCompleteFilesMismatchException(
          `В multipart-запросе нет файла с полем ${sf.fileFieldName}`,
        );
      }
      fileBySizeId.set(sf.sizeId, file);
    }

    // 3) Доп. проверка: все Size живы. Защита от подделки sizeId.
    const sizes = await this.prisma.size.findMany({
      where: { id: { in: [...taskSizeIds] } },
      select: { id: true },
    });
    const sizeIdsAlive = new Set(sizes.map((s) => s.id));
    for (const sid of taskSizeIds) {
      if (!sizeIdsAlive.has(sid)) {
        throw new ConstructorTaskSizeNotFoundException(sid);
      }
    }

    // 4) Phase 1: по каждому размеру задачи готовим запись. Если для
    //    размера пришёл файл — грузим на диск (PatternsStorageService
    //    валидирует расширение PDF/PLT/DXF/PLO и размер); иначе — заглушка
    //    (fileUrl/originalFileName = null), файл догрузят позже.
    const savedFiles: Array<{
      sizeId: string;
      publicUrl: string | null;
      originalFileName: string | null;
    }> = [];
    for (const sizeId of taskSizeIds) {
      const file = fileBySizeId.get(sizeId);
      if (!file) {
        savedFiles.push({ sizeId, publicUrl: null, originalFileName: null });
        continue;
      }
      const saved = await this.patternsStorage.saveSizeFile(
        existing.patternItemId,
        sizeId,
        file,
      );
      savedFiles.push({
        sizeId,
        publicUrl: saved.publicUrl,
        originalFileName: file.originalname,
      });
    }

    // 5) Phase 2: транзакция БД.
    await this.prisma.$transaction(async (tx) => {
      // Резервируем версии (max+1) для каждой пары (pattern, size).
      const existingMaxByPair = await tx.patternSizeFile.groupBy({
        by: ['sizeId'],
        where: {
          patternItemId: existing.patternItemId,
          sizeId: { in: [...taskSizeIds] },
        },
        _max: { version: true },
      });
      const maxBySize = new Map<string, number>();
      for (const row of existingMaxByPair) {
        maxBySize.set(row.sizeId, row._max.version ?? 0);
      }

      await tx.patternSizeFile.createMany({
        data: savedFiles.map((sf) => ({
          patternItemId: existing.patternItemId,
          sizeId: sf.sizeId,
          fileUrl: sf.publicUrl,
          originalFileName: sf.originalFileName,
          version: (maxBySize.get(sf.sizeId) ?? 0) + 1,
          status: 'ACTIVE',
          uploadedById: employeeId,
        })),
      });

      // Опциональная корректировка Кулирка/Кашкорсе конструктором.
      // payload.sizeRows[] — те же sizeId-ы, что в task.sizeRows
      // (валидируется по whitelist `taskSizeIds`). Применяем ДО
      // `syncSizeParameterValuesFromTask`, чтобы в номенклатуру
      // попали уже скорректированные числа.
      if (payload.sizeRows && payload.sizeRows.length > 0) {
        for (const sr of payload.sizeRows) {
          if (!taskSizeIds.has(sr.sizeId)) {
            throw new ConstructorTaskCompleteFilesMismatchException(
              `sizeRows ссылается на размер ${sr.sizeId}, которого нет в задаче`,
            );
          }
          await tx.constructorTaskSizeRow.updateMany({
            where: { taskId, sizeId: sr.sizeId },
            data: {
              kulirkaMeters:
                sr.kulirkaMeters == null
                  ? null
                  : new Prisma.Decimal(sr.kulirkaMeters),
              kashkorseMeters:
                sr.kashkorseMeters == null
                  ? null
                  : new Prisma.Decimal(sr.kashkorseMeters),
            },
          });
        }
      }

      // Автоматически переносим Кулирка/Кашкорсе из строк задачи
      // (`ConstructorTaskSizeRow`) в `PatternItemSizeParameterValue`
      // лекала — раньше менеджер вручную заполнял блок «Погонные метры»
      // на /admin/patterns/[id]. Маппинг по `roleKey` активных
      // параметров категории с `inputType = LINEAR_M_BY_SIZE`:
      //   - `MAIN_FABRIC` ← kulirkaMeters (Кулирка / основное полотно);
      //   - `RIB`         ← kashkorseMeters (Кашкорсе / рибана).
      // Параметров с другими `roleKey` маппинг не покрывает — те поля
      // менеджер продолжит править руками. Если у лекала нет категории
      // или подходящих активных параметров — секция остаётся пустой.
      // Для REWORK сценария (повторный complete) делаем full-replace
      // только в «допустимом окне» (`categoryParameterId IN allowed`),
      // чтобы не задеть значения по другим параметрам, заданные
      // вручную.
      await this.syncSizeParameterValuesFromTask(tx, taskId, existing.patternItemId);

      await tx.constructorTask.update({
        where: { id: taskId },
        data: {
          status: 'PENDING_ACCEPT',
          acceptedAt: null,
          // Если задача была REWORK без `assignedToId` (мог сбросить
          // менеджер) — фиксируем владельца текущим конструктором.
          // Иначе оставляем существующего.
          assignedToId: existing.assignedToId ?? employeeId,
        },
      });
    });

    return this.getOne(taskId);
  }

  /**
   * Переносит Кулирка/Кашкорсе из `ConstructorTaskSizeRow` в
   * `PatternItemSizeParameterValue` лекала. Вызывается из `complete`
   * внутри транзакции. Безопасно вызывать повторно (full-replace в
   * рамках «допустимого окна» категорийных параметров — см. logging).
   */
  private async syncSizeParameterValuesFromTask(
    tx: Prisma.TransactionClient,
    taskId: string,
    patternItemId: string,
  ): Promise<void> {
    const pattern = await tx.patternItem.findUnique({
      where: { id: patternItemId },
      select: { categoryId: true },
    });
    if (!pattern?.categoryId) return;

    const allowedParams = await tx.patternCategoryParameter.findMany({
      where: {
        categoryId: pattern.categoryId,
        status: 'ACTIVE',
        inputType: 'LINEAR_M_BY_SIZE',
        roleKey: { in: ['MAIN_FABRIC', 'RIB'] },
      },
      select: {
        id: true,
        roleKey: true,
        label: true,
        inputType: true,
        unit: true,
      },
    });
    if (allowedParams.length === 0) return;

    const sizeRows = await tx.constructorTaskSizeRow.findMany({
      where: { taskId },
      select: {
        sizeId: true,
        kulirkaMeters: true,
        kashkorseMeters: true,
      },
    });

    const valueRows: Prisma.PatternItemSizeParameterValueCreateManyInput[] = [];
    for (const param of allowedParams) {
      for (const row of sizeRows) {
        if (!row.sizeId) continue;
        const raw =
          param.roleKey === 'MAIN_FABRIC'
            ? row.kulirkaMeters
            : param.roleKey === 'RIB'
              ? row.kashkorseMeters
              : null;
        if (raw == null) continue;
        valueRows.push({
          patternItemId,
          categoryParameterId: param.id,
          sizeId: row.sizeId,
          roleKey: param.roleKey,
          labelSnapshot: param.label,
          inputTypeSnapshot: param.inputType,
          unit: param.unit,
          value: raw,
        });
      }
    }

    const allowedIds = allowedParams.map((p) => p.id);
    await tx.patternItemSizeParameterValue.deleteMany({
      where: { patternItemId, categoryParameterId: { in: allowedIds } },
    });
    if (valueRows.length > 0) {
      await tx.patternItemSizeParameterValue.createMany({ data: valueRows });
    }
    this.logger.log(
      `event=constructor-task.sync_size_param_values task=${taskId} ` +
        `pattern=${patternItemId} params=${allowedParams.length} ` +
        `values=${valueRows.length}`,
    );
  }

  /**
   * Менеджер «Принять»: `PENDING_ACCEPT` → `DONE`, `PatternItem.status`
   * DRAFT → `ACTIVE`. Обе записи обновляются в одной транзакции —
   * частичного состояния «task DONE, pattern всё ещё DRAFT» быть не
   * должно. RBAC выполняется в контроллере (`ADMIN`/`SHOP_MANAGER`).
   *
   * Идемпотентен в рамках смысла: повторный accept на DONE-задаче
   * отдаст `ConstructorTaskAcceptInvalidException` — намеренно, чтобы
   * UI заметил «уже принято» и обновился.
   */
  async accept(
    taskId: string,
    employeeId: string,
  ): Promise<ConstructorTaskDetailDto> {
    const existing = await this.prisma.constructorTask.findUnique({
      where: { id: taskId },
      select: { id: true, status: true, patternItemId: true },
    });
    if (!existing) throw new ConstructorTaskNotFoundException();
    if (existing.status !== 'PENDING_ACCEPT') {
      throw new ConstructorTaskAcceptInvalidException();
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.patternItem.update({
        where: { id: existing.patternItemId },
        data: { status: 'ACTIVE' },
      });
      await tx.constructorTask.update({
        where: { id: taskId },
        data: { status: 'DONE', acceptedAt: new Date() },
      });
    });

    this.logger.log(
      `event=constructor-task.accepted taskId=${taskId} acceptedBy=${employeeId}`,
    );
    return this.getOne(taskId);
  }

  /**
   * Менеджер «Вернуть на доработку»: `PENDING_ACCEPT` → `REWORK`.
   * Перезаписывает `comment` новым текстом замечаний и сохраняет
   * прикреплённые файлы как `ConstructorTaskFile` с `direction='REWORK'`.
   * `PatternItem` НЕ трогаем (он остаётся DRAFT).
   *
   * Phase 1: файлы пишем на диск через `ConstructorTasksStorageService`
   * (тот же storage, что initial brief). Этот storage не валидирует
   * расширение — менеджер может прислать любой формат (PDF/JPG/ZIP).
   *
   * Phase 2 (транзакция): обновить статус/комментарий, создать
   * `ConstructorTaskFile`-записи.
   */
  async requestRework(
    taskId: string,
    employeeId: string,
    comment: string,
    files: UploadedFileLike[],
  ): Promise<ConstructorTaskDetailDto> {
    const existing = await this.prisma.constructorTask.findUnique({
      where: { id: taskId },
      select: { id: true, status: true },
    });
    if (!existing) throw new ConstructorTaskNotFoundException();
    if (existing.status !== 'PENDING_ACCEPT') {
      throw new ConstructorTaskReworkInvalidException(
        'Вернуть на доработку можно только задачу в статусе «На приёмке»',
      );
    }
    if (files.length > CONSTRUCTOR_TASK_FILE_MAX_COUNT) {
      throw new ConstructorTaskFileInvalidException(
        `Слишком много файлов: лимит ${CONSTRUCTOR_TASK_FILE_MAX_COUNT}.`,
      );
    }

    // Phase 1: сохранить файлы на диск.
    const savedFiles: Array<{
      publicUrl: string;
      originalFileName: string;
      contentType: string;
      sizeBytes: number;
    }> = [];
    for (const file of files) {
      const saved = await this.storage.saveTaskFile(taskId, file);
      savedFiles.push(saved);
    }

    // Phase 2: одна транзакция — статус, комментарий, files.
    await this.prisma.$transaction(async (tx) => {
      await tx.constructorTask.update({
        where: { id: taskId },
        data: { status: 'REWORK', comment, acceptedAt: null },
      });
      if (savedFiles.length > 0) {
        await tx.constructorTaskFile.createMany({
          data: savedFiles.map((s) => ({
            taskId,
            fileUrl: s.publicUrl,
            originalFileName: s.originalFileName,
            contentType: s.contentType,
            sizeBytes: s.sizeBytes,
            direction: 'REWORK',
          })),
        });
      }
    });

    this.logger.log(
      `event=constructor-task.rework-requested taskId=${taskId} by=${employeeId} files=${savedFiles.length}`,
    );
    return this.getOne(taskId);
  }

  // ---------------------------------------------------------------------------
  // INTERNAL
  // ---------------------------------------------------------------------------

  /**
   * Маппинг делегирован чистой функции `mapConstructorTaskSummary`,
   * чтобы тот же DTO собирали `OrdersService.toDetailDto` и
   * `PatternsService.getOne` (через include `constructorTask`).
   */
  private toSummary(
    t: Parameters<typeof mapConstructorTaskSummary>[0],
  ): ConstructorTaskSummaryDto {
    return mapConstructorTaskSummary(t);
  }
}
