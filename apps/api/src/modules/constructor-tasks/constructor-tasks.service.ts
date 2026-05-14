import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  CONSTRUCTOR_TASK_FILE_MAX_COUNT,
  generateDraftPatternArticle,
  generateDraftPatternName,
  type ConstructorTaskDetailDto,
  type ConstructorTaskFileDto,
  type ConstructorTaskSizeRowDto,
  type ConstructorTaskSummaryDto,
  type SaveConstructorDraftDto,
  type SaveConstructorDraftResultDto,
} from '@sewing/shared/constructor-tasks';

import { PrismaService } from '../../prisma/prisma.service.js';
import {
  ConstructorTaskFileInvalidException,
  ConstructorTaskInvalidTransitionException,
  ConstructorTaskNotFoundException,
  ConstructorTaskSizeNotFoundException,
} from '../../common/errors.js';
import { ConstructorTasksStorageService } from './constructor-tasks-storage.service.js';
import type { UploadedFileLike } from '../patterns/patterns-storage.service.js';

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
  ) {}

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

      return {
        taskId: task.id,
        patternItemId: pattern.id,
        patternName: pattern.name,
        patternArticle: pattern.article,
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
    };
  }

  // ---------------------------------------------------------------------------
  // READ (admin pages)
  // ---------------------------------------------------------------------------

  async list(): Promise<ConstructorTaskSummaryDto[]> {
    const tasks = await this.prisma.constructorTask.findMany({
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
      })),
    };
  }

  // ---------------------------------------------------------------------------
  // INTERNAL
  // ---------------------------------------------------------------------------

  private toSummary(t: {
    id: string;
    patternItemId: string;
    status: string;
    comment: string;
    createdAt: Date;
    updatedAt: Date;
    submittedAt: Date | null;
    patternItem: { name: string; article: string };
    createdBy: { fullName: string } | null;
    assignedTo: { fullName: string } | null;
    _count: { files: number; sizeRows: number };
  }): ConstructorTaskSummaryDto {
    return {
      id: t.id,
      patternItemId: t.patternItemId,
      patternName: t.patternItem.name,
      patternArticle: t.patternItem.article,
      status: t.status as ConstructorTaskSummaryDto['status'],
      comment: t.comment,
      createdAt: t.createdAt.toISOString(),
      updatedAt: t.updatedAt.toISOString(),
      submittedAt: t.submittedAt ? t.submittedAt.toISOString() : null,
      createdByName: t.createdBy?.fullName ?? null,
      assignedToName: t.assignedTo?.fullName ?? null,
      filesCount: t._count.files,
      sizeRowsCount: t._count.sizeRows,
    };
  }
}
