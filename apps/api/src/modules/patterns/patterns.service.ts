import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  MATERIAL_ROLES,
  type MaterialRole,
} from '@sewing/shared/material-roles';
import type {
  CreatePatternDto,
  ListPatternsQuery,
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
import { PrismaService } from '../../prisma/prisma.service.js';
import { mapConstructorTaskSummary } from '../constructor-tasks/constructor-task-mappers.js';
import {
  PatternArticleTakenException,
  PatternCategoryInactiveException,
  PatternCategoryNotFoundException,
  PatternMaterialRoleNotInCategoryException,
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
    if (!file) throw new PatternUploadMissingFileException();
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

    const saved = await this.storage.saveSizeFile(
      patternItemId,
      sizeId,
      file,
    );

    const created = await this.prisma.patternSizeFile.create({
      data: {
        patternItemId,
        sizeId,
        fileUrl: saved.publicUrl,
        originalFileName: file.originalname,
        version: nextVersion,
        status: 'ACTIVE',
        uploadedById: actorEmployeeId ?? null,
      },
    });
    this.logger.log(
      `event=pattern.size_file_upload pattern=${patternItemId} size=${sizeId} ` +
        `version=${nextVersion} url=${saved.publicUrl}`,
    );
    await this.audit.log({
      event: 'PATTERN_SIZE_FILE_UPLOADED',
      entityType: 'PATTERN',
      entityId: patternItemId,
      payload: {
        fileId: created.id,
        sizeId,
        version: nextVersion,
        fileUrl: saved.publicUrl,
        originalFileName: file.originalname,
        size: file.size,
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

  private toDetailDto(
    row: Prisma.PatternItemGetPayload<{
      include: {
        sizeFiles: { include: { size: true } };
        materialAreas: { include: { size: true } };
        parameterNorms: { include: { categoryParameter: true } };
        sizeParameterValues: { include: { size: true } };
        category: {
          include: {
            parameters: true;
            _count: { select: { parameters: true; patterns: true } };
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
