import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  MATERIAL_ROLES,
  type MaterialRole,
} from '@sewing/shared/material-roles';
import type {
  ClonePatternDto,
  CreatePatternDto,
  ListPatternsQuery,
  PatternArchiveSkipDto,
  PatternsArchiveResultDto,
  PatternDetailDto,
  PatternItemParameterNormDto,
  PatternItemSizeParameterValueDto,
  PatternListItemDto,
  PatternMaterialAreaDto,
  PatternSizeFileDto,
  PatternSizeRefDto,
  ReplacePatternItemParameterNormsDto,
  ReplacePatternItemSizeParameterValuesDto,
  ReplacePatternMaterialAreasDto,
  UpdatePatternDto,
} from '@sewing/shared/patterns';
import type {
  PatternCategoryDto,
  PatternCategoryParameterDto,
} from '@sewing/shared/pattern-categories';
import type {
  PatternItemMaterialLineDto,
  PatternItemSpecParameterDto,
  ReplacePatternItemMaterialSpecDto,
} from '@sewing/shared/pattern-item-spec';
import type { MaterialCharacteristics } from '@sewing/shared/material-characteristics';
import type { TechCardMaterialColorRule } from '@sewing/shared/tech-cards';
import type {
  TechCardParameterBindings,
  TechCardParameterInputType,
  TechCardParameterOwner,
} from '@sewing/shared/tech-card-parameters';
import { PrismaService } from '../../prisma/prisma.service.js';
import { mapConstructorTaskSummary } from '../constructor-tasks/constructor-task-mappers.js';
import {
  PatternArticleTakenException,
  PatternCategoryInactiveException,
  PatternCategoryNotFoundException,
  PatternMaterialRoleNotInCategoryException,
  PatternDeleteForbiddenException,
  PatternNotFoundException,
  PatternParameterNormNotAllowedException,
  PatternSizeFileNotFoundException,
  PatternSizeNotFoundException,
  PatternSizeParameterValueNotAllowedException,
  PatternUploadMissingFileException,
} from '../../common/errors.js';
import { AuditService } from '../audit/audit.service.js';
import {
  PatternsStorageService,
  type UploadedFileLike,
} from './patterns-storage.service.js';
import {
  patternMaterialLineCreateData,
  patternSpecParameterCreateData,
} from './pattern-material-spec.util.js';

/**
 * Сервис «Лекала» (изолированный модуль, MVP-1).
 *
 * Контракт по эндпоинтам — `patterns.controller.ts`, контракты DTO —
 * `@sewing/shared/patterns`. Аудит — события `PATTERN_*` через
 * `AuditService` (см. `audit.service.ts`).
 *
 * Дизайн:
 *   - на этом этапе никакого взаимодействия с заказами/техкартами/
 *     паспортами; модуль самодостаточен и может быть отключён без
 *     влияния на основной flow;
 *   - upload-эндпоинты сначала пишут файл на диск
 *     (`PatternsStorageService`), потом транзакционно создают/
 *     обновляют записи в БД и пишут аудит. Если вторая половина
 *     падает, физический файл остаётся «осиротевшим» — на MVP это
 *     приемлемо (фоновый GC отложен), и заметно дешевле, чем
 *     pre-allocate / temp-rename;
 *   - `PUT /api/patterns/:id/material-areas` — атомарный bulk-replace
 *     в одной транзакции (delete + createMany), как в
 *     `RoutesService.replaceSteps` / `TechCardsService.update`;
 *   - архивация DXF-файла НЕ удаляет его с диска: на MVP это
 *     сознательная гарантия «менеджер случайно архивирует — потом
 *     может восстановить». Физический GC и storage-rotation —
 *     out-of-scope.
 */
@Injectable()
export class PatternsService {
  private readonly logger = new Logger(PatternsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly storage: PatternsStorageService,
  ) {}

  // ===========================================================================
  // READ
  // ===========================================================================

  async list(query: ListPatternsQuery): Promise<PatternListItemDto[]> {
    const where: Prisma.PatternItemWhereInput = {};
    if (query.status) where.status = query.status;
    if (query.categoryId) where.categoryId = query.categoryId;
    if (query.search) {
      where.OR = [
        { name: { contains: query.search, mode: 'insensitive' } },
        { article: { contains: query.search, mode: 'insensitive' } },
        { categoryCode: { contains: query.search, mode: 'insensitive' } },
        {
          category: {
            name: { contains: query.search, mode: 'insensitive' },
          },
        },
      ];
    }
    const rows = await this.prisma.patternItem.findMany({
      where,
      orderBy: [{ updatedAt: 'desc' }],
      include: {
        sizeFiles: {
          where: { status: 'ACTIVE' },
          select: { sizeId: true, size: true },
        },
        category: {
          select: {
            id: true,
            name: true,
            slug: true,
            iconKey: true,
            iconImageUrl: true,
            status: true,
          },
        },
        _count: {
          select: { sizeFiles: true, materialAreas: true },
        },
      },
    });
    return rows.map((row) => {
      // Уникальный набор размеров с активным DXF (sortedAscBy(sortOrder)).
      // Используется в списке как мини-чип «по каким размерам уже есть
      // лекало», чтобы не открывать карточку.
      const sizeMap = new Map<string, PatternSizeRefDto>();
      for (const sf of row.sizeFiles) {
        if (!sizeMap.has(sf.size.id)) {
          sizeMap.set(sf.size.id, {
            id: sf.size.id,
            code: sf.size.code,
            sortOrder: sf.size.sortOrder,
          });
        }
      }
      const sizes = Array.from(sizeMap.values()).sort(
        (a, b) => a.sortOrder - b.sortOrder,
      );
      return {
        id: row.id,
        name: row.name,
        article: row.article,
        categoryCode: row.categoryCode,
        categoryId: row.categoryId,
        categoryName: row.category?.name ?? null,
        categorySlug: row.category?.slug ?? null,
        categoryIconKey: row.category?.iconKey ?? null,
        categoryIconImageUrl: row.category?.iconImageUrl ?? null,
        categoryStatus: row.category?.status ?? null,
        previewImageUrl: row.previewImageUrl,
        status: row.status,
        description: row.description,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
        sizeFilesCount: row._count.sizeFiles,
        materialAreasCount: row._count.materialAreas,
        sizes,
      };
    });
  }

  async getOne(id: string): Promise<PatternDetailDto> {
    const row = await this.prisma.patternItem.findUnique({
      where: { id },
      include: {
        sizeFiles: {
          orderBy: [
            { size: { sortOrder: 'asc' } },
            { version: 'desc' },
          ],
          include: { size: true },
        },
        materialAreas: {
          orderBy: [
            { size: { sortOrder: 'asc' } },
            { materialRole: 'asc' },
          ],
          include: { size: true },
        },
        // Этап «Фурнитура и нормы»: блок UI работает по
        // `category.parameters.filter(inputType === QTY_PER_ITEM)` +
        // массиву `parameterNorms`. Нормы возвращаем отсортированными
        // по `categoryParameter.sortOrder/label`, чтобы UI и без
        // дополнительной сортировки рисовал строки в стабильном
        // порядке.
        parameterNorms: {
          include: { categoryParameter: true },
          orderBy: [
            { categoryParameter: { sortOrder: 'asc' } },
            { categoryParameter: { label: 'asc' } },
          ],
        },
        // Этап «Погонные метры по размерам»: блок UI работает по
        // `category.parameters.filter(inputType === LINEAR_M_BY_SIZE)` +
        // массиву `sizeParameterValues`. Сортируем по
        // `categoryParameter.sortOrder/label/sizeId`, чтобы UI рисовал
        // ячейки в стабильном порядке без дополнительной сортировки.
        sizeParameterValues: {
          include: { size: true },
          orderBy: [
            { categoryParameter: { sortOrder: 'asc' } },
            { categoryParameter: { label: 'asc' } },
            { size: { sortOrder: 'asc' } },
          ],
        },
        // Этап 1 «Материалы в номенклатуре»: состав материалов + слоты
        // спецификации. Сортировка стабильная — как в `TechCardsService`.
        materialSpecLines: { orderBy: { sortOrder: 'asc' } },
        specParameters: {
          orderBy: [{ sortOrder: 'asc' }, { label: 'asc' }],
        },
        category: {
          include: {
            parameters: {
              orderBy: [{ sortOrder: 'asc' }, { label: 'asc' }],
            },
            _count: {
              select: { parameters: true, patterns: true },
            },
          },
        },
        // Этап «Конструкторское бюро»: связанная задача, если pattern
        // создан через flow «Отправить конструктору». UI на
        // `/admin/patterns/[id]` показывает карточку «Источник».
        constructorTask: {
          include: {
            createdBy: { select: { fullName: true } },
            assignedTo: { select: { fullName: true } },
            _count: { select: { files: true, sizeRows: true } },
          },
        },
      },
    });
    if (!row) throw new PatternNotFoundException();
    return this.toDetailDto(row);
  }

  // ===========================================================================
  // CREATE / UPDATE
  // ===========================================================================

  async create(
    dto: CreatePatternDto,
    actorEmployeeId?: string | null,
  ): Promise<PatternDetailDto> {
    if (dto.categoryId) {
      await this.assertCategoryUsable(dto.categoryId);
    }
    let createdId: string;
    try {
      const created = await this.prisma.patternItem.create({
        data: {
          name: dto.name,
          article: dto.article,
          categoryCode: dto.categoryCode ?? null,
          categoryId: dto.categoryId ?? null,
          description: dto.description ?? null,
          status: dto.status ?? 'ACTIVE',
        },
      });
      createdId = created.id;
    } catch (e) {
      this.translateUniqueError(e);
      throw e;
    }
    this.logger.log(
      `event=pattern.create id=${createdId} article="${dto.article}"` +
        (dto.categoryId ? ` categoryId=${dto.categoryId}` : ''),
    );
    await this.audit.log({
      event: 'PATTERN_CREATED',
      entityType: 'PATTERN',
      entityId: createdId,
      payload: {
        name: dto.name,
        article: dto.article,
        categoryCode: dto.categoryCode ?? null,
        categoryId: dto.categoryId ?? null,
        status: dto.status ?? 'ACTIVE',
      },
      employeeId: actorEmployeeId ?? null,
    });
    return this.getOne(createdId);
  }

  async update(
    id: string,
    dto: UpdatePatternDto,
    actorEmployeeId?: string | null,
  ): Promise<PatternDetailDto> {
    const current = await this.prisma.patternItem.findUnique({ where: { id } });
    if (!current) throw new PatternNotFoundException();

    if (dto.categoryId !== undefined && dto.categoryId !== null) {
      await this.assertCategoryUsable(dto.categoryId);
    }

    const data: Prisma.PatternItemUpdateInput = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.article !== undefined) data.article = dto.article;
    if (dto.categoryCode !== undefined) data.categoryCode = dto.categoryCode;
    if (dto.categoryId !== undefined) {
      // dto.categoryId может быть string или null — оба варианта валидны.
      data.category =
        dto.categoryId === null
          ? { disconnect: true }
          : { connect: { id: dto.categoryId } };
    }
    if (dto.description !== undefined) data.description = dto.description;
    if (dto.status !== undefined) data.status = dto.status;

    try {
      await this.prisma.patternItem.update({ where: { id }, data });
    } catch (e) {
      this.translateUniqueError(e);
      throw e;
    }
    this.logger.log(
      `event=pattern.update id=${id} fields=${Object.keys(dto).join(',')}`,
    );
    await this.audit.log({
      event: 'PATTERN_UPDATED',
      entityType: 'PATTERN',
      entityId: id,
      payload: {
        before: {
          name: current.name,
          article: current.article,
          categoryCode: current.categoryCode,
          categoryId: current.categoryId,
          status: current.status,
        },
        after: {
          name: dto.name ?? current.name,
          article: dto.article ?? current.article,
          categoryCode:
            dto.categoryCode === undefined
              ? current.categoryCode
              : dto.categoryCode,
          categoryId:
            dto.categoryId === undefined
              ? current.categoryId
              : dto.categoryId,
          status: dto.status ?? current.status,
        },
      },
      employeeId: actorEmployeeId ?? null,
    });
    return this.getOne(id);
  }

  /**
   * Hard-delete номенклатуры (этап «Удалить архивную запись навсегда»).
   *
   * Политика «блокировать, если используется»
   * (`PatternDeleteForbiddenException`):
   *   1) удалять можно ТОЛЬКО архивную номенклатуру (`status =
   *      ARCHIVED`) — это её soft-удалённое состояние;
   *   2) блокируем, если на лекало ссылается хотя бы один заказ
   *      (`Order.patternItemId`). FK — `SET NULL`, т.е. БД молча
   *      обнулила бы snapshot исторических заказов; мы этого не хотим.
   *
   * Owned-дети (`PatternSizeFile` / `PatternMaterialArea` /
   * `PatternItemParameterNorm` / `PatternItemSizeParameterValue` /
   * `ConstructorTask`) уходят каскадом (`onDelete: Cascade`) — это
   * части самой номенклатуры, не внешняя история.
   */
  async remove(id: string, actorEmployeeId?: string | null): Promise<void> {
    const current = await this.prisma.patternItem.findUnique({
      where: { id },
      select: { id: true, name: true, article: true, status: true },
    });
    if (!current) throw new PatternNotFoundException();
    if (current.status !== 'ARCHIVED') {
      throw new PatternDeleteForbiddenException(
        'Удалить навсегда можно только архивную номенклатуру. Как удалить: сначала нажмите «Архивировать номенклатуру», затем кнопку «Удалить навсегда».',
      );
    }

    const orderCount = await this.prisma.order.count({
      where: { patternItemId: id },
    });
    if (orderCount > 0) {
      throw new PatternDeleteForbiddenException(
        `Эту номенклатуру удалить навсегда нельзя: её используют заказы (${orderCount}). Заказы хранят историю по ней, поэтому удалить получится только после того, как все эти заказы будут удалены навсегда. Если заказы нужны — просто оставьте номенклатуру в архиве: в новые заказы архивные не предлагаются.`,
      );
    }

    await this.prisma.patternItem.delete({ where: { id } });

    this.logger.log(`event=pattern.delete id=${id} article=${current.article}`);
    await this.audit.log({
      event: 'PATTERN_DELETED',
      entityType: 'PATTERN',
      entityId: id,
      payload: {
        name: current.name,
        article: current.article,
        previousStatus: current.status,
      },
      employeeId: actorEmployeeId ?? null,
    });
  }

  // ===========================================================================
  // АРХИВ НОМЕНКЛАТУРЫ — bulk archive / restore / purge
  // ===========================================================================
  //
  // Тот же двухшаговый сценарий, что и в «Архиве расчётов цеха»
  // (`WorkshopNeedsService.archiveOrders/restoreOrders/purgeOrders`):
  // сначала мягкая архивация (обратимо), потом — безвозвратное удаление
  // из архива. Разница в носителе признака: у заказа это дата
  // `needsArchivedAt`, у номенклатуры — `status = ARCHIVED` (так уже
  // работает карточка `/admin/patterns/[id]`, отдельного поля в схеме
  // нет и заводить его ради списка не нужно).
  //
  // Все три операции — bulk с ЧАСТИЧНЫМ УСПЕХОМ: карточка, не прошедшая
  // гейт, попадает в `skipped` с причиной, остальные обрабатываются.
  // Точечная кнопка в строке = массив из одного id.
  //
  // Гейты `purgeMany` намеренно повторяют одиночный `remove()` (только
  // из архива; блок, если ссылаются заказы) — иначе массовая операция
  // стала бы обходным путём мимо политики «блокировать, если
  // используется».

  /**
   * Мягкая архивация: `status := ARCHIVED`. Обратимо (`restoreMany`),
   * данные не трогаются. Архивная номенклатура пропадает из активного
   * справочника и не предлагается в новых заказах/техкартах.
   *
   * Идемпотентно: уже архивная карточка считается обработанной.
   */
  async archiveMany(
    patternIds: string[],
    actorEmployeeId?: string | null,
  ): Promise<PatternsArchiveResultDto> {
    const ids = Array.from(new Set(patternIds));
    const rows = await this.prisma.patternItem.findMany({
      where: { id: { in: ids } },
      select: { id: true, status: true },
    });
    const byId = new Map(rows.map((r) => [r.id, r]));

    const processed: string[] = [];
    const skipped: PatternArchiveSkipDto[] = [];
    const toArchive: string[] = [];
    for (const id of ids) {
      const row = byId.get(id);
      if (!row) {
        skipped.push({ patternId: id, reason: 'NOT_FOUND' });
        continue;
      }
      if (row.status === 'ARCHIVED') {
        processed.push(id);
        continue;
      }
      toArchive.push(id);
    }

    if (toArchive.length > 0) {
      await this.prisma.$transaction(async (tx) => {
        await tx.patternItem.updateMany({
          where: { id: { in: toArchive } },
          data: { status: 'ARCHIVED' },
        });
        await this.audit.log(
          {
            event: 'PATTERNS_ARCHIVED',
            entityType: 'PATTERN',
            entityId: toArchive[0],
            employeeId: actorEmployeeId ?? null,
            payload: { patternIds: toArchive },
          },
          tx,
        );
      });
      processed.push(...toArchive);
    }

    this.logger.log(
      `event=pattern.archive processed=${processed.length} skipped=${skipped.length}`,
    );
    return { processed, skipped };
  }

  /**
   * Вернуть из архива. Куда именно возвращать, решаем по связанной
   * задаче конструктора: если она есть и ещё не закрыта
   * (`DONE`/`CANCELLED`), карточка была черновиком КБ — возвращаем в
   * `DRAFT`, чтобы недоделанное лекало не начало предлагаться в
   * заказах. Во всех остальных случаях — `ACTIVE`.
   *
   * Идемпотентно: не архивная карточка считается обработанной.
   */
  async restoreMany(
    patternIds: string[],
    actorEmployeeId?: string | null,
  ): Promise<PatternsArchiveResultDto> {
    const ids = Array.from(new Set(patternIds));
    const rows = await this.prisma.patternItem.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        status: true,
        constructorTask: { select: { status: true } },
      },
    });
    const byId = new Map(rows.map((r) => [r.id, r]));

    const processed: string[] = [];
    const skipped: PatternArchiveSkipDto[] = [];
    const toActive: string[] = [];
    const toDraft: string[] = [];
    for (const id of ids) {
      const row = byId.get(id);
      if (!row) {
        skipped.push({ patternId: id, reason: 'NOT_FOUND' });
        continue;
      }
      if (row.status !== 'ARCHIVED') {
        processed.push(id);
        continue;
      }
      const task = row.constructorTask;
      if (task && task.status !== 'DONE' && task.status !== 'CANCELLED') {
        toDraft.push(id);
      } else {
        toActive.push(id);
      }
    }

    if (toActive.length > 0 || toDraft.length > 0) {
      await this.prisma.$transaction(async (tx) => {
        if (toActive.length > 0) {
          await tx.patternItem.updateMany({
            where: { id: { in: toActive } },
            data: { status: 'ACTIVE' },
          });
        }
        if (toDraft.length > 0) {
          await tx.patternItem.updateMany({
            where: { id: { in: toDraft } },
            data: { status: 'DRAFT' },
          });
        }
        await this.audit.log(
          {
            event: 'PATTERNS_RESTORED',
            entityType: 'PATTERN',
            entityId: (toActive[0] ?? toDraft[0]) as string,
            employeeId: actorEmployeeId ?? null,
            payload: { restoredToActive: toActive, restoredToDraft: toDraft },
          },
          tx,
        );
      });
      processed.push(...toActive, ...toDraft);
    }

    this.logger.log(
      `event=pattern.restore processed=${processed.length} skipped=${skipped.length}`,
    );
    return { processed, skipped };
  }

  /**
   * Безвозвратное удаление архивной номенклатуры (bulk-версия
   * `remove()`): карточка + её owned-дети (размеры/файлы/площади/нормы/
   * задача конструктора) уходят каскадом.
   *
   * Гейты те же, что у одиночного удаления, только вместо 409 —
   * пропуск с причиной:
   *   - не в архиве                → `NOT_ARCHIVED`;
   *   - на карточку ссылается заказ → `USED_BY_ORDERS`.
   *
   * DXF/превью на диске не удаляем — как и в `remove()` (физический GC
   * out-of-scope, см. комментарий к классу).
   */
  async purgeMany(
    patternIds: string[],
    actorEmployeeId?: string | null,
  ): Promise<PatternsArchiveResultDto> {
    const ids = Array.from(new Set(patternIds));
    const rows = await this.prisma.patternItem.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true, article: true, status: true },
    });
    const byId = new Map(rows.map((r) => [r.id, r]));

    const processed: string[] = [];
    const skipped: PatternArchiveSkipDto[] = [];
    const toPurge: typeof rows = [];
    for (const id of ids) {
      const row = byId.get(id);
      if (!row) {
        skipped.push({ patternId: id, reason: 'NOT_FOUND' });
        continue;
      }
      if (row.status !== 'ARCHIVED') {
        skipped.push({ patternId: id, reason: 'NOT_ARCHIVED' });
        continue;
      }
      const orderCount = await this.prisma.order.count({
        where: { patternItemId: id },
      });
      if (orderCount > 0) {
        skipped.push({ patternId: id, reason: 'USED_BY_ORDERS' });
        continue;
      }
      toPurge.push(row);
    }

    for (const row of toPurge) {
      await this.prisma.$transaction(async (tx) => {
        await tx.patternItem.delete({ where: { id: row.id } });
        await this.audit.log(
          {
            event: 'PATTERN_DELETED',
            entityType: 'PATTERN',
            entityId: row.id,
            employeeId: actorEmployeeId ?? null,
            payload: {
              name: row.name,
              article: row.article,
              previousStatus: row.status,
              bulk: true,
            },
          },
          tx,
        );
      });
      processed.push(row.id);
    }

    this.logger.log(
      `event=pattern.purge processed=${processed.length} skipped=${skipped.length}`,
    );
    return { processed, skipped };
  }

  // ===========================================================================
  // CLONE — этап «Создать номенклатуру по готовому лекалу»
  // ===========================================================================

  /**
   * Клонировать существующую номенклатуру в новую (`POST /api/patterns/:id/clone`).
   *
   * Зачем: менеджер уже принял готовое лекало (через flow КБ или
   * руками) и хочет завести на его основе ещё одну номенклатуру —
   * например, вариант той же модели для другого артикула. Вместо
   * того чтобы заводить новую карточку и заново загружать DXF /
   * заполнять площади / погонные метры / нормы фурнитуры, мы
   * атомарно копируем всё содержимое исходного лекала.
   *
   * Что копируется:
   *   - `name` / `description` / `categoryCode` / `categoryId`;
   *   - активные `PatternSizeFile` (по одной свежей версии на
   *     `sizeId`) — DXF копируются ФИЗИЧЕСКИ под новый `storedFileName`,
   *     чтобы архивация / удаление одной номенклатуры не задевала другую;
   *   - все `PatternMaterialArea`;
   *   - все `PatternItemParameterNorm`;
   *   - все `PatternItemSizeParameterValue`.
   *
   * Что НЕ копируется:
   *   - `previewImageUrl` — превью у новой карточки пустое (менеджер
   *     загрузит своё, чтобы две номенклатуры не выглядели
   *     одинаково);
   *   - `legacyProductId` — UNIQUE, создастся `OrdersService`
   *     `ensureLegacyProductForPattern` по первой ссылке из заказа;
   *   - связанная `ConstructorTask` — она 1:1 с исходным pattern и не
   *     должна «уходить» в клон (иначе UI «Источник» на новой
   *     карточке покажет чужую задачу).
   *
   * Артикул:
   *   - если в payload пришёл `article`, используем его (упадёт с
   *     `PatternArticleTakenException`, если уже занят — менеджер
   *     поправит в модалке);
   *   - иначе генерим первый свободный `{src.article}-2 / -3 / …` через
   *     запрос-цикл по уникальному индексу (вне транзакции —
   *     `findUnique` дешевле, чем поймать P2002 в транзакции и
   *     развалить копирование DXF).
   *
   * Безопасность по диску: копирование DXF делается ВНЕ Prisma-транзакции
   * (Prisma-транзакции не охватывают filesystem), затем все DB-вставки
   * выполняются одной транзакцией. Если транзакция падает, остаются
   * «осиротевшие» файлы — на MVP это приемлемо (так же ведёт себя
   * `uploadSizeFile`, см. комментарий к классу).
   */
  async clone(
    sourceId: string,
    dto: ClonePatternDto,
    actorEmployeeId?: string | null,
  ): Promise<PatternDetailDto> {
    const source = await this.prisma.patternItem.findUnique({
      where: { id: sourceId },
      include: {
        sizeFiles: {
          where: { status: 'ACTIVE' },
          orderBy: [
            { sizeId: 'asc' },
            { version: 'desc' },
            { createdAt: 'desc' },
          ],
        },
        materialAreas: true,
        parameterNorms: true,
        sizeParameterValues: true,
        // Этап 1 «Материалы в номенклатуре»: спецификация клонируется
        // вместе с карточкой — иначе копия молча теряла бы состав.
        materialSpecLines: true,
        specParameters: true,
      },
    });
    if (!source) throw new PatternNotFoundException();

    const desiredName =
      dto.name && dto.name.trim() !== '' ? dto.name : `${source.name} (копия)`;
    const desiredArticle =
      dto.article && dto.article.trim() !== ''
        ? dto.article
        : await this.findNextFreeArticle(source.article);

    // По одному активному DXF на sizeId — самый свежий (orderBy выше:
    // сначала по version DESC, затем по createdAt DESC).
    const latestBySize = new Map<string, (typeof source.sizeFiles)[number]>();
    for (const sf of source.sizeFiles) {
      if (!latestBySize.has(sf.sizeId)) latestBySize.set(sf.sizeId, sf);
    }

    // Шаг 1. Создаём новую карточку — здесь же ловим P2002 на `article`,
    // чтобы не успеть скопировать DXF до выяснения конфликта.
    let createdId: string;
    try {
      const created = await this.prisma.patternItem.create({
        data: {
          name: desiredName,
          article: desiredArticle,
          categoryCode: source.categoryCode,
          categoryId: source.categoryId,
          description: source.description,
          status: 'ACTIVE',
        },
      });
      createdId = created.id;
    } catch (e) {
      this.translateUniqueError(e);
      throw e;
    }

    // Шаг 2. Физически копируем DXF в новую папку. Параллелим через
    // Promise.all — файлы независимые, и под крупный набор размеров
    // это заметно быстрее, чем sequential await.
    const copyJobs = await Promise.all(
      Array.from(latestBySize.values()).map(async (sf) => {
        // Размер-заглушка (без файла) — копировать нечего, переносим
        // как заглушку (fileUrl/originalFileName = null).
        if (!sf.fileUrl) {
          return {
            sizeId: sf.sizeId,
            fileUrl: null,
            originalFileName: null,
          };
        }
        const saved = await this.storage.copySizeFile(
          sf.fileUrl,
          createdId,
          sf.sizeId,
        );
        return {
          sizeId: sf.sizeId,
          fileUrl: saved.publicUrl,
          originalFileName: sf.originalFileName,
        };
      }),
    );

    // Шаг 3. Все DB-вставки в одну транзакцию. Если упадёт — карточка
    // и физические DXF остаются как «осиротевшие» (см. ADR в
    // patterns-storage.service.ts), но дублей в БД не будет.
    await this.prisma.$transaction(async (tx) => {
      if (copyJobs.length > 0) {
        await tx.patternSizeFile.createMany({
          data: copyJobs.map((c) => ({
            patternItemId: createdId,
            sizeId: c.sizeId,
            fileUrl: c.fileUrl,
            originalFileName: c.originalFileName,
            version: 1,
            status: 'ACTIVE',
            uploadedById: actorEmployeeId ?? null,
          })),
        });
      }
      if (source.materialAreas.length > 0) {
        await tx.patternMaterialArea.createMany({
          data: source.materialAreas.map((a) => ({
            patternItemId: createdId,
            sizeId: a.sizeId,
            materialRole: a.materialRole,
            areaM2: a.areaM2,
            comment: a.comment,
          })),
        });
      }
      if (source.parameterNorms.length > 0) {
        await tx.patternItemParameterNorm.createMany({
          data: source.parameterNorms.map((n) => ({
            patternItemId: createdId,
            categoryParameterId: n.categoryParameterId,
            roleKey: n.roleKey,
            labelSnapshot: n.labelSnapshot,
            inputTypeSnapshot: n.inputTypeSnapshot,
            unit: n.unit,
            qtyPerItem: n.qtyPerItem,
            comment: n.comment,
          })),
        });
      }
      if (source.sizeParameterValues.length > 0) {
        await tx.patternItemSizeParameterValue.createMany({
          data: source.sizeParameterValues.map((v) => ({
            patternItemId: createdId,
            categoryParameterId: v.categoryParameterId,
            sizeId: v.sizeId,
            roleKey: v.roleKey,
            labelSnapshot: v.labelSnapshot,
            inputTypeSnapshot: v.inputTypeSnapshot,
            unit: v.unit,
            value: v.value,
            comment: v.comment,
          })),
        });
      }
      // Этап 1 «Материалы в номенклатуре»: копия состава + слотов.
      // Копируем колонки как есть (без нормализации) — источник уже
      // прошёл её при своём сохранении.
      if (source.materialSpecLines.length > 0) {
        await tx.patternItemMaterialLine.createMany({
          data: source.materialSpecLines.map((l) => ({
            patternItemId: createdId,
            sortOrder: l.sortOrder,
            name: l.name,
            unit: l.unit,
            normUnit: l.normUnit,
            qtyPerUnit: l.qtyPerUnit,
            note: l.note,
            materialRole: l.materialRole,
            fabricType: l.fabricType,
            densityGsm: l.densityGsm,
            plannedWidthCm: l.plannedWidthCm,
            colorRule: l.colorRule,
            fixedColorText: l.fixedColorText,
            hardwareSizeText: l.hardwareSizeText,
            hardwareMaterialText: l.hardwareMaterialText,
            materialImageUrl: l.materialImageUrl,
            materialImageOriginalFileName: l.materialImageOriginalFileName,
            subtypeKey: l.subtypeKey,
            characteristics:
              l.characteristics === null
                ? Prisma.DbNull
                : (l.characteristics as Prisma.InputJsonValue),
            parameterBindings:
              l.parameterBindings === null
                ? Prisma.DbNull
                : (l.parameterBindings as Prisma.InputJsonValue),
          })),
        });
      }
      if (source.specParameters.length > 0) {
        await tx.patternItemSpecParameter.createMany({
          data: source.specParameters.map((p) => ({
            patternItemId: createdId,
            key: p.key,
            label: p.label,
            inputType: p.inputType,
            options:
              p.options === null
                ? Prisma.DbNull
                : (p.options as Prisma.InputJsonValue),
            unit: p.unit,
            isRequired: p.isRequired,
            defaultValue: p.defaultValue,
            owner: p.owner,
            sortOrder: p.sortOrder,
          })),
        });
      }
      await this.audit.log(
        {
          event: 'PATTERN_CLONED',
          entityType: 'PATTERN',
          entityId: createdId,
          payload: {
            sourceId,
            sourceArticle: source.article,
            sourceName: source.name,
            name: desiredName,
            article: desiredArticle,
            categoryId: source.categoryId,
            sizeFilesCount: copyJobs.length,
            materialAreasCount: source.materialAreas.length,
            parameterNormsCount: source.parameterNorms.length,
            sizeParameterValuesCount: source.sizeParameterValues.length,
            materialSpecLinesCount: source.materialSpecLines.length,
            specParametersCount: source.specParameters.length,
          },
          employeeId: actorEmployeeId ?? null,
        },
        tx,
      );
    });

    this.logger.log(
      `event=pattern.clone source=${sourceId} created=${createdId} ` +
        `article="${desiredArticle}" sizeFiles=${copyJobs.length} ` +
        `areas=${source.materialAreas.length} ` +
        `norms=${source.parameterNorms.length} ` +
        `sizeValues=${source.sizeParameterValues.length}`,
    );
    return this.getOne(createdId);
  }

  /**
   * Найти первый свободный артикул `{base}-2 / -3 / …`. Используется,
   * когда менеджер не задал артикул в модалке клонирования.
   *
   * Реализация: одной выборкой берём все `article LIKE '{base}-%'`,
   * парсим суффикс как целое, выбираем `max + 1` (или 2, если суффиксов
   * нет вовсе). Это дешевле, чем цикл `findUnique`, и при гонке
   * последующий `create` всё равно поймает P2002 и менеджер увидит
   * понятную 409.
   */
  private async findNextFreeArticle(baseArticle: string): Promise<string> {
    const rows = await this.prisma.patternItem.findMany({
      where: { article: { startsWith: `${baseArticle}-` } },
      select: { article: true },
    });
    let maxSuffix = 1;
    const prefixLen = baseArticle.length + 1;
    for (const r of rows) {
      const suffix = r.article.slice(prefixLen);
      if (!/^\d+$/.test(suffix)) continue;
      const n = Number.parseInt(suffix, 10);
      if (Number.isFinite(n) && n > maxSuffix) maxSuffix = n;
    }
    return `${baseArticle}-${maxSuffix + 1}`;
  }

  /**
   * Проверка «категорию можно использовать»: существует и не
   * архивирована. Используется в `create` и `update` перед записью —
   * UI скрывает архивные категории в селекте, но прямой POST/PATCH
   * блокируется отдельной 409-кой по аналогии с
   * `ClientInactiveException` / `SupplierInactiveException`.
   */
  private async assertCategoryUsable(categoryId: string): Promise<void> {
    const cat = await this.prisma.patternCategory.findUnique({
      where: { id: categoryId },
      select: { id: true, status: true },
    });
    if (!cat) throw new PatternCategoryNotFoundException();
    if (cat.status !== 'ACTIVE') throw new PatternCategoryInactiveException();
  }

  // ===========================================================================
  // PREVIEW UPLOAD
  // ===========================================================================

  async uploadPreview(
    id: string,
    file: UploadedFileLike | undefined,
    actorEmployeeId?: string | null,
  ): Promise<PatternDetailDto> {
    if (!file) throw new PatternUploadMissingFileException();
    const existing = await this.prisma.patternItem.findUnique({
      where: { id },
      select: { id: true, previewImageUrl: true },
    });
    if (!existing) throw new PatternNotFoundException();

    const saved = await this.storage.savePreview(id, file);
    await this.prisma.patternItem.update({
      where: { id },
      data: { previewImageUrl: saved.publicUrl },
    });
    this.logger.log(
      `event=pattern.preview_upload id=${id} url=${saved.publicUrl}`,
    );
    await this.audit.log({
      event: 'PATTERN_PREVIEW_UPLOADED',
      entityType: 'PATTERN',
      entityId: id,
      payload: {
        previousUrl: existing.previewImageUrl,
        newUrl: saved.publicUrl,
        originalFileName: file.originalname,
        size: file.size,
      },
      employeeId: actorEmployeeId ?? null,
    });
    return this.getOne(id);
  }

  // ===========================================================================
  // DXF UPLOAD / ARCHIVE
  // ===========================================================================

  async uploadSizeFile(
    patternItemId: string,
    sizeId: string,
    file: UploadedFileLike | undefined,
    actorEmployeeId?: string | null,
  ): Promise<PatternDetailDto> {
    // Файл необязателен: размер можно добавить БЕЗ файла (заглушка) —
    // файл (PDF/PLT/DXF/PLO) догрузят позже. Если file есть — сохраняем и
    // пишем fileUrl/originalFileName; если нет — создаём строку с null.
    const pattern = await this.prisma.patternItem.findUnique({
      where: { id: patternItemId },
      select: { id: true },
    });
    if (!pattern) throw new PatternNotFoundException();
    const size = await this.prisma.size.findUnique({
      where: { id: sizeId },
      select: { id: true },
    });
    if (!size) throw new PatternSizeNotFoundException();

    // Версия = max(version) + 1 для пары (patternItemId, sizeId).
    // Считаем ВСЕ версии (включая ARCHIVED), чтобы повторная загрузка
    // после архивации не дала коллизию по уникальному индексу
    // (patternItemId, sizeId, version).
    const top = await this.prisma.patternSizeFile.findFirst({
      where: { patternItemId, sizeId },
      orderBy: { version: 'desc' },
      select: { version: true },
    });
    const nextVersion = (top?.version ?? 0) + 1;

    const saved = file
      ? await this.storage.saveSizeFile(patternItemId, sizeId, file)
      : null;

    const created = await this.prisma.patternSizeFile.create({
      data: {
        patternItemId,
        sizeId,
        fileUrl: saved?.publicUrl ?? null,
        originalFileName: file?.originalname ?? null,
        version: nextVersion,
        status: 'ACTIVE',
        uploadedById: actorEmployeeId ?? null,
      },
    });
    this.logger.log(
      `event=pattern.size_file_upload pattern=${patternItemId} size=${sizeId} ` +
        `version=${nextVersion} url=${saved?.publicUrl ?? '(no-file)'}`,
    );
    await this.audit.log({
      event: 'PATTERN_SIZE_FILE_UPLOADED',
      entityType: 'PATTERN',
      entityId: patternItemId,
      payload: {
        fileId: created.id,
        sizeId,
        version: nextVersion,
        fileUrl: saved?.publicUrl ?? null,
        originalFileName: file?.originalname ?? null,
        size: file?.size ?? null,
      },
      employeeId: actorEmployeeId ?? null,
    });
    return this.getOne(patternItemId);
  }

  async archiveSizeFile(
    patternItemId: string,
    sizeId: string,
    fileId: string,
    actorEmployeeId?: string | null,
  ): Promise<PatternDetailDto> {
    const file = await this.prisma.patternSizeFile.findFirst({
      where: { id: fileId, patternItemId, sizeId },
    });
    if (!file) throw new PatternSizeFileNotFoundException();
    if (file.status !== 'ARCHIVED') {
      await this.prisma.patternSizeFile.update({
        where: { id: file.id },
        data: { status: 'ARCHIVED' },
      });
    }
    this.logger.log(
      `event=pattern.size_file_archive pattern=${patternItemId} ` +
        `size=${sizeId} file=${fileId}`,
    );
    await this.audit.log({
      event: 'PATTERN_SIZE_FILE_ARCHIVED',
      entityType: 'PATTERN',
      entityId: patternItemId,
      payload: {
        fileId: file.id,
        sizeId,
        version: file.version,
        previousStatus: file.status,
      },
      employeeId: actorEmployeeId ?? null,
    });
    return this.getOne(patternItemId);
  }

  /**
   * Восстановление архивного файла размера (`ARCHIVED → ACTIVE`).
   * Обратная операция к `archiveSizeFile`. Если у того же `sizeId`
   * уже есть другой активный файл — не трогаем его: размер просто
   * получит два активных файла, и «активным» в UI станет старший по
   * `version` (см. `computeActiveSizes` на фронте). Это сознательно
   * простой вариант (см. решение в обсуждении задачи).
   */
  async restoreSizeFile(
    patternItemId: string,
    sizeId: string,
    fileId: string,
    actorEmployeeId?: string | null,
  ): Promise<PatternDetailDto> {
    const file = await this.prisma.patternSizeFile.findFirst({
      where: { id: fileId, patternItemId, sizeId },
    });
    if (!file) throw new PatternSizeFileNotFoundException();
    if (file.status !== 'ACTIVE') {
      await this.prisma.patternSizeFile.update({
        where: { id: file.id },
        data: { status: 'ACTIVE' },
      });
    }
    this.logger.log(
      `event=pattern.size_file_restore pattern=${patternItemId} ` +
        `size=${sizeId} file=${fileId}`,
    );
    await this.audit.log({
      event: 'PATTERN_SIZE_FILE_RESTORED',
      entityType: 'PATTERN',
      entityId: patternItemId,
      payload: {
        fileId: file.id,
        sizeId,
        version: file.version,
        previousStatus: file.status,
      },
      employeeId: actorEmployeeId ?? null,
    });
    return this.getOne(patternItemId);
  }

  /**
   * Жёсткое удаление файла размера: удаляем запись `PatternSizeFile`
   * из БД и физический файл с диска. В отличие от архивации — это
   * безвозвратно. Разрешено для любого статуса (ACTIVE/ARCHIVED) по
   * решению задачи («корзина везде»).
   *
   * Заказы/паспорта ссылаются на снапшот лекала по `patternItemId`,
   * а не на конкретный `PatternSizeFile`, поэтому отдельной проверки
   * «файл используется заказом» тут нет (в отличие от hard-delete
   * самого лекала). Сначала удаляем строку БД, затем best-effort
   * чистим диск — если запись удалить не удалось, файл остаётся на
   * месте.
   */
  async deleteSizeFilePermanent(
    patternItemId: string,
    sizeId: string,
    fileId: string,
    actorEmployeeId?: string | null,
  ): Promise<PatternDetailDto> {
    const file = await this.prisma.patternSizeFile.findFirst({
      where: { id: fileId, patternItemId, sizeId },
    });
    if (!file) throw new PatternSizeFileNotFoundException();
    await this.prisma.patternSizeFile.delete({ where: { id: file.id } });
    await this.storage.deleteSizeFile(file.fileUrl);
    this.logger.log(
      `event=pattern.size_file_delete pattern=${patternItemId} ` +
        `size=${sizeId} file=${fileId}`,
    );
    await this.audit.log({
      event: 'PATTERN_SIZE_FILE_DELETED',
      entityType: 'PATTERN',
      entityId: patternItemId,
      payload: {
        fileId: file.id,
        sizeId,
        version: file.version,
        previousStatus: file.status,
        fileUrl: file.fileUrl,
      },
      employeeId: actorEmployeeId ?? null,
    });
    return this.getOne(patternItemId);
  }

  // ===========================================================================
  // MATERIAL AREAS (bulk replace)
  // ===========================================================================

  async replaceMaterialAreas(
    patternItemId: string,
    dto: ReplacePatternMaterialAreasDto,
    actorEmployeeId?: string | null,
  ): Promise<PatternDetailDto> {
    const pattern = await this.prisma.patternItem.findUnique({
      where: { id: patternItemId },
      select: { id: true, categoryId: true },
    });
    if (!pattern) throw new PatternNotFoundException();

    // Все размеры из payload должны существовать в справочнике.
    // Дополнительно ловим дубликаты `(sizeId, materialRole)` ещё до
    // транзакции — иначе createMany упадёт по уникальному индексу.
    const sizeIds = Array.from(new Set(dto.areas.map((a) => a.sizeId)));
    if (sizeIds.length > 0) {
      const found = await this.prisma.size.findMany({
        where: { id: { in: sizeIds } },
        select: { id: true },
      });
      if (found.length !== sizeIds.length) {
        throw new PatternSizeNotFoundException();
      }
    }
    const seen = new Set<string>();
    for (const a of dto.areas) {
      const key = `${a.sizeId}::${a.materialRole}`;
      if (seen.has(key)) {
        throw new PatternSizeNotFoundException();
      }
      seen.add(key);
    }

    // Этап «Категории номенклатуры»: если у лекала есть `categoryId`,
    // принимаем только те `materialRole`, которые описаны активными
    // параметрами категории с `inputType = AREA_M2_BY_SIZE`. Без
    // категории — fallback на глобальный `MATERIAL_ROLES` (старые
    // лекала продолжают работать). См. ТЗ §5 «Backend: PatternMaterialArea
    // validation».
    const allowedRoles = await this.computeAllowedMaterialRoles(
      pattern.categoryId,
    );
    const distinctRoles = Array.from(new Set(dto.areas.map((a) => a.materialRole)));
    const unknown = distinctRoles.filter((r) => !allowedRoles.has(r));
    if (unknown.length > 0) {
      const allowedList = Array.from(allowedRoles).join(', ') || '—';
      const message = pattern.categoryId
        ? `Роль(-и) "${unknown.join(', ')}" не входят в категорию лекала. Допустимы: ${allowedList}.`
        : `Роль(-и) "${unknown.join(', ')}" не входят в список MATERIAL_ROLES. Допустимы: ${allowedList}.`;
      throw new PatternMaterialRoleNotInCategoryException(message);
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.patternMaterialArea.deleteMany({ where: { patternItemId } });
      if (dto.areas.length > 0) {
        await tx.patternMaterialArea.createMany({
          data: dto.areas.map((a) => ({
            patternItemId,
            sizeId: a.sizeId,
            materialRole: a.materialRole,
            areaM2: new Prisma.Decimal(a.areaM2),
            comment: a.comment ?? null,
          })),
        });
      }
      await this.audit.log(
        {
          event: 'PATTERN_MATERIAL_AREAS_REPLACED',
          entityType: 'PATTERN',
          entityId: patternItemId,
          payload: {
            count: dto.areas.length,
            roles: Array.from(
              new Set(dto.areas.map((a) => a.materialRole)),
            ),
            sizeIds,
          },
          employeeId: actorEmployeeId ?? null,
        },
        tx,
      );
    });
    this.logger.log(
      `event=pattern.material_areas_replace pattern=${patternItemId} ` +
        `count=${dto.areas.length}`,
    );
    return this.getOne(patternItemId);
  }

  // ===========================================================================
  // PARAMETER NORMS (bulk replace) — этап «Фурнитура и нормы»
  // ===========================================================================

  /**
   * Bulk-replace «Фурнитуры и норм» лекала
   * (`PUT /api/patterns/:id/parameter-norms`).
   *
   * Логика (см. ТЗ §3 «Backend: PatternsService»):
   *   1. Найти `PatternItem` по `id`.
   *   2. Загрузить активные параметры категории
   *      (`status = ACTIVE`, `inputType = QTY_PER_ITEM`) — это
   *      whitelist допустимых `categoryParameterId`.
   *   3. Если в payload есть `categoryParameterId` не из whitelist
   *      (другой категории / другой inputType / архивный) — отбиваем
   *      `PatternParameterNormNotAllowedException`.
   *   4. В транзакции: удалить старые нормы по этим QTY_PER_ITEM
   *      параметрам и создать новые с `qtyPerItem > 0`. Нормы по
   *      параметрам категории, которые в payload не пришли,
   *      **удаляются** — это и есть «очистить норму».
   *   5. `roleKey`, `labelSnapshot`, `inputTypeSnapshot` всегда
   *      берутся из параметра категории (snapshot переживает
   *      переименование). `unit` тоже берём из параметра категории —
   *      опциональный `unit` из формы используется как override
   *      только если он непустой.
   *
   * Аудит: `PATTERN_PARAMETER_NORMS_REPLACED`.
   *
   * Ошибки:
   *   - `PATTERN_NOT_FOUND` — лекало не найдено;
   *   - `PATTERN_PARAMETER_NORM_NOT_ALLOWED` — параметр не подходит.
   */
  async replaceParameterNorms(
    patternItemId: string,
    dto: ReplacePatternItemParameterNormsDto,
    actorEmployeeId?: string | null,
  ): Promise<PatternDetailDto> {
    const pattern = await this.prisma.patternItem.findUnique({
      where: { id: patternItemId },
      select: { id: true, categoryId: true },
    });
    if (!pattern) throw new PatternNotFoundException();

    // Whitelist: активные QTY_PER_ITEM параметры категории лекала.
    // Если у лекала нет категории, никаких норм сохранить нельзя —
    // payload должен быть пустым (все incoming categoryParameterId
    // отвергаются).
    const allowedParams = pattern.categoryId
      ? await this.prisma.patternCategoryParameter.findMany({
          where: {
            categoryId: pattern.categoryId,
            status: 'ACTIVE',
            inputType: 'QTY_PER_ITEM',
          },
          select: {
            id: true,
            roleKey: true,
            label: true,
            inputType: true,
            unit: true,
          },
        })
      : [];
    const allowedById = new Map(allowedParams.map((p) => [p.id, p]));

    for (const item of dto.norms) {
      const param = allowedById.get(item.categoryParameterId);
      if (!param) {
        throw new PatternParameterNormNotAllowedException(
          `Параметр ${item.categoryParameterId} нельзя использовать как «Фурнитура и нормы»: ` +
            `он не найден среди активных параметров категории лекала с типом «Количество на изделие».`,
        );
      }
    }

    // Готовим строки для createMany. Snapshot полей — из параметра
    // категории (а не из payload), `unit` — параметр категории по
    // умолчанию, override из формы — если непуст.
    const data = dto.norms.map((item) => {
      const param = allowedById.get(item.categoryParameterId)!;
      const unit =
        item.unit !== null && item.unit !== undefined && item.unit !== ''
          ? item.unit
          : param.unit;
      return {
        patternItemId,
        categoryParameterId: param.id,
        roleKey: param.roleKey,
        labelSnapshot: param.label,
        inputTypeSnapshot: param.inputType,
        unit,
        qtyPerItem: new Prisma.Decimal(item.qtyPerItem),
        comment: item.comment ?? null,
      };
    });

    // ID-шники текущего «допустимого окна» — нормы по этим параметрам
    // мы стираем целиком и перезаписываем. Нормы по другим параметрам
    // (например, исторические записи под архивные параметры) НЕ
    // трогаем — backend не подчищает исторические данные, см.
    // соглашение из этапа «Категории номенклатуры».
    const allowedIds = Array.from(allowedById.keys());

    await this.prisma.$transaction(async (tx) => {
      if (allowedIds.length > 0) {
        await tx.patternItemParameterNorm.deleteMany({
          where: {
            patternItemId,
            categoryParameterId: { in: allowedIds },
          },
        });
      }
      if (data.length > 0) {
        await tx.patternItemParameterNorm.createMany({ data });
      }
      await this.audit.log(
        {
          event: 'PATTERN_PARAMETER_NORMS_REPLACED',
          entityType: 'PATTERN',
          entityId: patternItemId,
          payload: {
            categoryId: pattern.categoryId,
            count: data.length,
            categoryParameterIds: data.map((d) => d.categoryParameterId),
            roleKeys: Array.from(new Set(data.map((d) => d.roleKey))),
          },
          employeeId: actorEmployeeId ?? null,
        },
        tx,
      );
    });
    this.logger.log(
      `event=pattern.parameter_norms_replace pattern=${patternItemId} ` +
        `count=${data.length}`,
    );
    return this.getOne(patternItemId);
  }

  // ===========================================================================
  // SIZE PARAMETER VALUES (bulk replace) — этап «Погонные метры по размерам»
  // ===========================================================================

  /**
   * Bulk-replace значений «погонных метров по размерам»
   * (`PUT /api/patterns/:id/size-parameter-values`).
   *
   * Логика (см. ТЗ §7 «Backend PatternsService»):
   *   1. Найти `PatternItem` по `id`.
   *   2. Загрузить активные параметры категории
   *      (`status = ACTIVE`, `inputType = LINEAR_M_BY_SIZE`) — это
   *      whitelist допустимых `categoryParameterId`.
   *   3. Если в payload есть `categoryParameterId` не из whitelist —
   *      `PatternSizeParameterValueNotAllowedException` (422).
   *   4. Если sizeId не существует в справочнике — то же исключение
   *      с понятным сообщением.
   *   5. В транзакции: удалить старые значения по этим
   *      LINEAR_M_BY_SIZE параметрам и создать новые с `value > 0`.
   *      Параметры, для которых в payload значений нет, очищаются.
   *   6. `roleKey`, `labelSnapshot`, `inputTypeSnapshot`, `unit` —
   *      snapshot из параметра категории (override `unit` из формы
   *      применяется только если он непустой).
   *
   * Аудит: `PATTERN_SIZE_PARAMETER_VALUES_REPLACED`.
   *
   * Ошибки:
   *   - `PATTERN_NOT_FOUND` — лекало не найдено;
   *   - `PATTERN_SIZE_PARAMETER_VALUE_NOT_ALLOWED` — параметр / размер
   *     не подходит.
   */
  async replaceSizeParameterValues(
    patternItemId: string,
    dto: ReplacePatternItemSizeParameterValuesDto,
    actorEmployeeId?: string | null,
  ): Promise<PatternDetailDto> {
    const pattern = await this.prisma.patternItem.findUnique({
      where: { id: patternItemId },
      select: { id: true, categoryId: true },
    });
    if (!pattern) throw new PatternNotFoundException();

    // Whitelist: активные LINEAR_M_BY_SIZE параметры категории лекала.
    // Без категории сохранять значения нельзя — все incoming
    // categoryParameterId отвергаются.
    const allowedParams = pattern.categoryId
      ? await this.prisma.patternCategoryParameter.findMany({
          where: {
            categoryId: pattern.categoryId,
            status: 'ACTIVE',
            inputType: 'LINEAR_M_BY_SIZE',
          },
          select: {
            id: true,
            roleKey: true,
            label: true,
            inputType: true,
            unit: true,
          },
        })
      : [];
    const allowedById = new Map(allowedParams.map((p) => [p.id, p]));

    for (const item of dto.values) {
      const param = allowedById.get(item.categoryParameterId);
      if (!param) {
        throw new PatternSizeParameterValueNotAllowedException(
          `Параметр ${item.categoryParameterId} нельзя использовать как «Погонные метры по размерам»: ` +
            `он не найден среди активных параметров категории лекала с типом LINEAR_M_BY_SIZE.`,
        );
      }
    }

    // Размеры из payload должны существовать в справочнике.
    const sizeIds = Array.from(new Set(dto.values.map((v) => v.sizeId)));
    if (sizeIds.length > 0) {
      const found = await this.prisma.size.findMany({
        where: { id: { in: sizeIds } },
        select: { id: true },
      });
      if (found.length !== sizeIds.length) {
        const foundSet = new Set(found.map((f) => f.id));
        const missing = sizeIds.filter((id) => !foundSet.has(id));
        throw new PatternSizeParameterValueNotAllowedException(
          `Размер(ы) не найден(ы) в справочнике: ${missing.join(', ')}.`,
        );
      }
    }

    // Готовим строки для createMany. Snapshot полей — из параметра
    // категории (а не из payload), `unit` — параметр категории по
    // умолчанию, override из формы — если непуст.
    const data = dto.values.map((item) => {
      const param = allowedById.get(item.categoryParameterId)!;
      const unit =
        item.unit !== null && item.unit !== undefined && item.unit !== ''
          ? item.unit
          : param.unit;
      return {
        patternItemId,
        categoryParameterId: param.id,
        sizeId: item.sizeId,
        roleKey: param.roleKey,
        labelSnapshot: param.label,
        inputTypeSnapshot: param.inputType,
        unit,
        value: new Prisma.Decimal(item.value),
        comment: item.comment ?? null,
      };
    });

    // ID-шники текущего «допустимого окна» — значения по этим
    // параметрам мы стираем целиком и перезаписываем. Значения по
    // другим параметрам (исторические записи под архивные параметры)
    // НЕ трогаем — backend не подчищает исторические данные.
    const allowedIds = Array.from(allowedById.keys());

    await this.prisma.$transaction(async (tx) => {
      if (allowedIds.length > 0) {
        await tx.patternItemSizeParameterValue.deleteMany({
          where: {
            patternItemId,
            categoryParameterId: { in: allowedIds },
          },
        });
      }
      if (data.length > 0) {
        await tx.patternItemSizeParameterValue.createMany({ data });
      }
      await this.audit.log(
        {
          event: 'PATTERN_SIZE_PARAMETER_VALUES_REPLACED',
          entityType: 'PATTERN',
          entityId: patternItemId,
          payload: {
            categoryId: pattern.categoryId,
            count: data.length,
            categoryParameterIds: Array.from(
              new Set(data.map((d) => d.categoryParameterId)),
            ),
            sizeIds: Array.from(new Set(data.map((d) => d.sizeId))),
            roleKeys: Array.from(new Set(data.map((d) => d.roleKey))),
          },
          employeeId: actorEmployeeId ?? null,
        },
        tx,
      );
    });
    this.logger.log(
      `event=pattern.size_parameter_values_replace pattern=${patternItemId} ` +
        `count=${data.length}`,
    );
    return this.getOne(patternItemId);
  }

  // ===========================================================================
  // INTERNAL
  // ===========================================================================

  /**
   * Вернуть набор разрешённых `materialRole` для лекала. Если у
   * лекала есть `categoryId`, читаем активные параметры категории
   * с `inputType = AREA_M2_BY_SIZE` и возвращаем их `roleKey`. Если
   * нет — fallback на глобальный `MATERIAL_ROLES` (старые лекала
   * продолжают работать).
   */
  private async computeAllowedMaterialRoles(
    categoryId: string | null,
  ): Promise<Set<string>> {
    if (!categoryId) {
      return new Set<string>(MATERIAL_ROLES as readonly MaterialRole[]);
    }
    const params = await this.prisma.patternCategoryParameter.findMany({
      where: {
        categoryId,
        status: 'ACTIVE',
        inputType: 'AREA_M2_BY_SIZE',
      },
      select: { roleKey: true },
    });
    return new Set<string>(params.map((p) => p.roleKey));
  }

  /**
   * Этап 1 плана «техкарты → номенклатура»
   * (`PUT /api/patterns/:id/material-spec`): атомарный full-replace
   * состава материалов и слотов-параметров карточки — как
   * `TechCardsService.update` (deleteMany + createMany; id строк
   * пересоздаются при каждом сейве, поэтому привязка «ячейка → параметр»
   * живёт JSON-ом `parameterBindings` в самой строке).
   *
   * Кросс-проверка «биндинг ссылается на объявленный параметр» уже
   * выполнена схемой (`ReplacePatternItemMaterialSpecSchema`): в отличие
   * от PATCH техкарты запрос всегда несёт полное итоговое состояние
   * обеих частей.
   */
  async replaceMaterialSpec(
    patternItemId: string,
    dto: ReplacePatternItemMaterialSpecDto,
    actorEmployeeId?: string | null,
  ): Promise<PatternDetailDto> {
    const pattern = await this.prisma.patternItem.findUnique({
      where: { id: patternItemId },
      select: { id: true },
    });
    if (!pattern) throw new PatternNotFoundException();

    // Legacy-роли, уже лежащие в БД (например, `APPLICATION` из бэкфилла
    // техкарт — этап 2), при full-replace сохраняемы: менеджер должен
    // уметь пересохранить карточку, не редактируя legacy-строку (та же
    // политика, что у `TechCardsService.update`).
    const existingLegacyRoleKeys = new Set(
      (
        await this.prisma.patternItemMaterialLine.findMany({
          where: { patternItemId },
          select: { materialRole: true },
        })
      )
        .map((r) => r.materialRole)
        .filter((k): k is string => k != null && k.length > 0),
    );

    await this.prisma.$transaction(async (tx) => {
      await tx.patternItemMaterialLine.deleteMany({
        where: { patternItemId },
      });
      if (dto.materialLines.length > 0) {
        await tx.patternItemMaterialLine.createMany({
          data: dto.materialLines.map((l, i) =>
            patternMaterialLineCreateData(patternItemId, l, i, {
              existingRoleKeys: existingLegacyRoleKeys,
            }),
          ),
        });
      }
      await tx.patternItemSpecParameter.deleteMany({
        where: { patternItemId },
      });
      if (dto.parameters.length > 0) {
        await tx.patternItemSpecParameter.createMany({
          data: dto.parameters.map((p, i) =>
            patternSpecParameterCreateData(patternItemId, p, i),
          ),
        });
      }
      await this.audit.log(
        {
          event: 'PATTERN_MATERIAL_SPEC_REPLACED',
          entityType: 'PATTERN',
          entityId: patternItemId,
          payload: {
            materialLinesCount: dto.materialLines.length,
            parametersCount: dto.parameters.length,
            roleKeys: Array.from(
              new Set(
                dto.materialLines
                  .map((l) => l.materialRole)
                  .filter((k): k is string => k != null),
              ),
            ),
          },
          employeeId: actorEmployeeId ?? null,
        },
        tx,
      );
    });
    this.logger.log(
      `event=pattern.material_spec_replace pattern=${patternItemId} ` +
        `lines=${dto.materialLines.length} params=${dto.parameters.length}`,
    );
    return this.getOne(patternItemId);
  }

  private toDetailDto(
    row: Prisma.PatternItemGetPayload<{
      include: {
        sizeFiles: { include: { size: true } };
        materialAreas: { include: { size: true } };
        parameterNorms: { include: { categoryParameter: true } };
        sizeParameterValues: { include: { size: true } };
        materialSpecLines: true;
        specParameters: true;
        category: {
          include: {
            parameters: true;
            _count: {
              select: { parameters: true; patterns: true };
            };
          };
        };
        constructorTask: {
          include: {
            createdBy: { select: { fullName: true } };
            assignedTo: { select: { fullName: true } };
            _count: { select: { files: true; sizeRows: true } };
          };
        };
      };
    }>,
  ): PatternDetailDto {
    const sizeFiles: PatternSizeFileDto[] = row.sizeFiles.map((f) => ({
      id: f.id,
      patternItemId: f.patternItemId,
      sizeId: f.sizeId,
      size: {
        id: f.size.id,
        code: f.size.code,
        sortOrder: f.size.sortOrder,
      },
      fileUrl: f.fileUrl,
      originalFileName: f.originalFileName,
      version: f.version,
      status: f.status,
      uploadedById: f.uploadedById,
      createdAt: f.createdAt.toISOString(),
      updatedAt: f.updatedAt.toISOString(),
    }));
    const materialAreas: PatternMaterialAreaDto[] = row.materialAreas.map(
      (a) => ({
        id: a.id,
        patternItemId: a.patternItemId,
        sizeId: a.sizeId,
        size: {
          id: a.size.id,
          code: a.size.code,
          sortOrder: a.size.sortOrder,
        },
        materialRole: a.materialRole,
        areaM2: a.areaM2.toString(),
        comment: a.comment,
        createdAt: a.createdAt.toISOString(),
        updatedAt: a.updatedAt.toISOString(),
      }),
    );
    const category: PatternCategoryDto | null = row.category
      ? {
          id: row.category.id,
          name: row.category.name,
          slug: row.category.slug,
          iconKey: row.category.iconKey,
          iconImageUrl: row.category.iconImageUrl,
          iconOriginalFileName: row.category.iconOriginalFileName,
          sortOrder: row.category.sortOrder,
          status: row.category.status,
          description: row.category.description,
          parametersCount: row.category._count.parameters,
          patternsCount: row.category._count.patterns,
          createdAt: row.category.createdAt.toISOString(),
          updatedAt: row.category.updatedAt.toISOString(),
          parameters: row.category.parameters.map((p) => ({
            id: p.id,
            categoryId: p.categoryId,
            roleKey: p.roleKey,
            subtypeKey: p.subtypeKey,
            label: p.label,
            inputType: p.inputType,
            unit: p.unit,
            isRequired: p.isRequired,
            sortOrder: p.sortOrder,
            status: p.status,
            description: p.description,
            createdAt: p.createdAt.toISOString(),
            updatedAt: p.updatedAt.toISOString(),
          })),
        }
      : null;

    const categoryAreaParameters: PatternCategoryParameterDto[] = category
      ? category.parameters.filter(
          (p) => p.status === 'ACTIVE' && p.inputType === 'AREA_M2_BY_SIZE',
        )
      : [];

    const parameterNorms: PatternItemParameterNormDto[] = row.parameterNorms.map(
      (n) => ({
        id: n.id,
        patternItemId: n.patternItemId,
        categoryParameterId: n.categoryParameterId,
        roleKey: n.roleKey,
        labelSnapshot: n.labelSnapshot,
        inputTypeSnapshot: n.inputTypeSnapshot,
        unit: n.unit,
        qtyPerItem: n.qtyPerItem.toString(),
        comment: n.comment,
        createdAt: n.createdAt.toISOString(),
        updatedAt: n.updatedAt.toISOString(),
      }),
    );

    const sizeParameterValues: PatternItemSizeParameterValueDto[] =
      row.sizeParameterValues.map((v) => ({
        id: v.id,
        patternItemId: v.patternItemId,
        categoryParameterId: v.categoryParameterId,
        sizeId: v.sizeId,
        size: {
          id: v.size.id,
          code: v.size.code,
          sortOrder: v.size.sortOrder,
        },
        roleKey: v.roleKey,
        labelSnapshot: v.labelSnapshot,
        inputTypeSnapshot: v.inputTypeSnapshot,
        unit: v.unit,
        value: v.value.toString(),
        comment: v.comment,
        createdAt: v.createdAt.toISOString(),
        updatedAt: v.updatedAt.toISOString(),
      }));

    // Этап 1 «Материалы в номенклатуре»: состав материалов + слоты
    // спецификации. Контракт строки — 1-в-1 со строкой техкарты
    // (см. `@sewing/shared/pattern-item-spec`).
    const materialSpecLines: PatternItemMaterialLineDto[] =
      row.materialSpecLines.map((l) => ({
        id: l.id,
        sortOrder: l.sortOrder,
        name: l.name,
        unit: l.unit,
        normUnit: l.normUnit,
        qtyPerUnit: l.qtyPerUnit.toString(),
        note: l.note,
        parameterBindings:
          (l.parameterBindings as TechCardParameterBindings | null) ?? null,
        materialRole: l.materialRole,
        fabricType: l.fabricType,
        densityGsm: l.densityGsm,
        plannedWidthCm: l.plannedWidthCm,
        colorRule: (l.colorRule as TechCardMaterialColorRule | null) ?? null,
        fixedColorText: l.fixedColorText,
        hardwareSizeText: l.hardwareSizeText,
        hardwareMaterialText: l.hardwareMaterialText,
        materialImageUrl: l.materialImageUrl,
        materialImageOriginalFileName: l.materialImageOriginalFileName,
        subtypeKey: l.subtypeKey,
        characteristics:
          (l.characteristics as MaterialCharacteristics | null) ?? null,
      }));
    const specParameters: PatternItemSpecParameterDto[] =
      row.specParameters.map((p) => ({
        id: p.id,
        key: p.key,
        label: p.label,
        inputType: p.inputType as TechCardParameterInputType,
        options: (p.options as string[] | null) ?? null,
        unit: p.unit,
        isRequired: p.isRequired,
        defaultValue: p.defaultValue,
        owner: p.owner as TechCardParameterOwner,
        sortOrder: p.sortOrder,
      }));

    return {
      id: row.id,
      name: row.name,
      article: row.article,
      categoryCode: row.categoryCode,
      categoryId: row.categoryId,
      category,
      categoryAreaParameters,
      previewImageUrl: row.previewImageUrl,
      status: row.status,
      description: row.description,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      sizeFiles,
      materialAreas,
      parameterNorms,
      sizeParameterValues,
      materialSpecLines,
      specParameters,
      // Этап «Конструкторское бюро»: включаем patternItem-данные
      // в summary (они нужны UI карточки «Источник» на /admin/patterns/[id]
      // — название и артикул совпадают с самим лекалом).
      constructorTask: row.constructorTask
        ? mapConstructorTaskSummary({
            ...row.constructorTask,
            patternItem: { name: row.name, article: row.article },
          })
        : null,
    };
  }

  private translateUniqueError(e: unknown): void {
    if (
      e instanceof Prisma.PrismaClientKnownRequestError &&
      e.code === 'P2002'
    ) {
      const target = (e.meta?.target as string[] | string | undefined) ?? [];
      const fields = Array.isArray(target) ? target : [target];
      if (fields.some((f) => String(f).includes('article'))) {
        throw new PatternArticleTakenException();
      }
      throw new PatternArticleTakenException();
    }
  }
}
