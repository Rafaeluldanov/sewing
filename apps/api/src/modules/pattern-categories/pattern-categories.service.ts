import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  applyParameterDefaults,
  generatePatternCategorySlug,
  type CompatibleTechCardDto,
  type CompatibleTechCardsResponseDto,
  type CreatePatternCategoryDto,
  type ListPatternCategoriesQuery,
  type PatternCategoryDto,
  type PatternCategoryListItemDto,
  type PatternCategoryParameterDto,
  type PatternCategoryParameterInputDto,
  type ReplacePatternCategoryParametersDto,
  type TechCardCompatibilityLevel,
  type UpdatePatternCategoryDto,
} from '@sewing/shared/pattern-categories';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  PatternCategoryNotFoundException,
  PatternCategorySlugTakenException,
  PatternUploadMissingFileException,
} from '../../common/errors.js';
import { AuditService } from '../audit/audit.service.js';
import { PatternCategoriesStorageService } from './pattern-categories-storage.service.js';
import type { UploadedFileLike } from '../patterns/patterns-storage.service.js';

/**
 * Сервис «Категории номенклатуры» — типизированный справочник
 * категорий лекал и их параметров материалов.
 *
 * См. контракт DTO/Zod в `@sewing/shared/pattern-categories`,
 * Prisma-модели `PatternCategory` / `PatternCategoryParameter`.
 *
 * Дизайн:
 *   - `list/get/create/update` — типовой CRUD без destructive
 *     удалений; «удаление» = soft-archive (`status = ARCHIVED`).
 *   - `replaceParameters` — bulk replace в одной транзакции
 *     (`deleteMany + createMany`), как в `PatternsService.replaceMaterialAreas`.
 *     Это удобнее, чем «дифф по id»: на MVP список параметров
 *     невелик (≤ ~20), а атомарная замена защищает от частичного
 *     состояния «половина параметров — старая, половина — новая».
 *   - Удаление параметра — через `replaceParameters` (не передал
 *     параметр в новом списке = он удалён). Это согласовано с UI
 *     модалки «Параметры категории», где менеджер просто кликает
 *     «X» и сохраняет всю карточку.
 *
 * Аудит: события `PATTERN_CATEGORY_*` пишутся через `AuditService`
 * с `entityType = PATTERN_CATEGORY` (см. `audit.service.ts`).
 */
@Injectable()
export class PatternCategoriesService {
  private readonly logger = new Logger(PatternCategoriesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly storage: PatternCategoriesStorageService,
  ) {}

  // ===========================================================================
  // READ
  // ===========================================================================

  async list(
    query: ListPatternCategoriesQuery,
  ): Promise<PatternCategoryListItemDto[]> {
    const where: Prisma.PatternCategoryWhereInput = {};
    if (query.status) where.status = query.status;
    if (query.search) {
      where.OR = [
        { name: { contains: query.search, mode: 'insensitive' } },
        { slug: { contains: query.search, mode: 'insensitive' } },
      ];
    }
    const rows = await this.prisma.patternCategory.findMany({
      where,
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      include: {
        _count: {
          select: { parameters: true, patterns: true },
        },
      },
    });
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      slug: row.slug,
      iconKey: row.iconKey,
      iconImageUrl: row.iconImageUrl,
      iconOriginalFileName: row.iconOriginalFileName,
      sortOrder: row.sortOrder,
      status: row.status,
      description: row.description,
      parametersCount: row._count.parameters,
      patternsCount: row._count.patterns,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    }));
  }

  async get(id: string): Promise<PatternCategoryDto> {
    const row = await this.prisma.patternCategory.findUnique({
      where: { id },
      include: {
        parameters: {
          orderBy: [{ sortOrder: 'asc' }, { label: 'asc' }],
        },
        _count: {
          select: { parameters: true, patterns: true },
        },
      },
    });
    if (!row) throw new PatternCategoryNotFoundException();
    return toDetailDto(row);
  }

  /**
   * Inline-создание изделия из формы заказа (см.
   * `apps/api/src/modules/pattern-categories/pattern-categories.controller.ts`,
   * `apps/web/app/admin/orders/new/admin-create-order-form.tsx`).
   *
   * Возвращает активные техкарты с оценкой совместимости по этой
   * группе номенклатуры:
   *   - `FULL`    — все активные `AREA_M2_BY_SIZE`-параметры категории
   *     имеют соответствующую `TechCardMaterialLine.materialRole`;
   *   - `PARTIAL` — часть roleKey-ов совпала, часть отсутствует;
   *   - `NONE`    — нет ни одного совпавшего roleKey.
   *
   * Используется UI модалки «Создать изделие» для подсветки/фильтрации
   * селекта «Техкарта». Backend `OrdersService.create` дополнительно
   * валидирует строго при сохранении.
   */
  async compatibleTechCards(
    categoryId: string,
  ): Promise<CompatibleTechCardsResponseDto> {
    const category = await this.prisma.patternCategory.findUnique({
      where: { id: categoryId },
      include: {
        parameters: { where: { status: 'ACTIVE' } },
      },
    });
    if (!category) throw new PatternCategoryNotFoundException();
    const requiredRoleKeys = category.parameters
      .filter((p) => p.inputType === 'AREA_M2_BY_SIZE')
      .map((p) => p.roleKey);

    const requiredSet = new Set(requiredRoleKeys);
    const techCards = await this.prisma.techCardTemplate.findMany({
      where: { isActive: true },
      include: {
        materialLines: { select: { materialRole: true } },
        _count: { select: { materialLines: true } },
      },
      orderBy: [{ code: 'asc' }],
    });

    const result: CompatibleTechCardDto[] = techCards.map((tc) => {
      const present = new Set<string>();
      for (const l of tc.materialLines) {
        if (l.materialRole) present.add(l.materialRole);
      }
      const matched: string[] = [];
      const missing: string[] = [];
      for (const role of requiredSet) {
        if (present.has(role)) matched.push(role);
        else missing.push(role);
      }
      let compatibility: TechCardCompatibilityLevel;
      if (requiredSet.size === 0) {
        // У категории нет AREA_M2_BY_SIZE параметров — любая
        // техкарта считается «полностью совместимой» (нечего
        // покрывать).
        compatibility = 'FULL';
      } else if (missing.length === 0) {
        compatibility = 'FULL';
      } else if (matched.length === 0) {
        compatibility = 'NONE';
      } else {
        compatibility = 'PARTIAL';
      }
      return {
        id: tc.id,
        code: tc.code,
        name: tc.name,
        isActive: tc.isActive,
        patternCategoryId: tc.patternCategoryId,
        compatibility,
        matchedRoleKeys: matched,
        missingRoleKeys: missing,
        materialLinesCount: tc._count.materialLines,
      };
    });

    // Sort FULL → PARTIAL → NONE, затем по code asc.
    const order: Record<TechCardCompatibilityLevel, number> = {
      FULL: 0,
      PARTIAL: 1,
      NONE: 2,
    };
    result.sort((a, b) => {
      const d = order[a.compatibility] - order[b.compatibility];
      if (d !== 0) return d;
      return a.code.localeCompare(b.code);
    });

    return {
      categoryId,
      requiredRoleKeys,
      techCards: result,
    };
  }

  // ===========================================================================
  // CREATE
  // ===========================================================================

  async create(
    dto: CreatePatternCategoryDto,
    actorEmployeeId?: string | null,
  ): Promise<PatternCategoryDto> {
    const slug = (dto.slug ?? generatePatternCategorySlug(dto.name)).trim();
    const parameters = (dto.parameters ?? []).map(applyParameterDefaults);

    let createdId: string;
    try {
      const created = await this.prisma.$transaction(async (tx) => {
        const cat = await tx.patternCategory.create({
          data: {
            name: dto.name,
            slug,
            // На новом UI menager не выбирает lucide-иконку — поле осталось
            // как legacy fallback. Если фронт ничего не прислал, кладём
            // безопасный дефолт `TAG`. Загружаемая JPEG-иконка приедет
            // отдельным запросом `POST /pattern-categories/:id/icon`.
            iconKey: dto.iconKey ?? 'TAG',
            sortOrder: dto.sortOrder ?? 100,
            status: dto.status ?? 'ACTIVE',
            description: dto.description ?? null,
          },
        });
        if (parameters.length > 0) {
          await tx.patternCategoryParameter.createMany({
            data: parameters.map((p) => ({
              categoryId: cat.id,
              roleKey: p.roleKey,
              label: p.label,
              inputType: p.inputType,
              unit: p.unit,
              isRequired: p.isRequired,
              sortOrder: p.sortOrder,
              status: p.status,
              description: p.description ?? null,
            })),
          });
        }
        await this.audit.log(
          {
            event: 'PATTERN_CATEGORY_CREATED',
            entityType: 'PATTERN_CATEGORY',
            entityId: cat.id,
            payload: {
              name: cat.name,
              slug: cat.slug,
              iconKey: cat.iconKey,
              status: cat.status,
              parametersCount: parameters.length,
              roleKeys: parameters.map((p) => p.roleKey),
            },
            employeeId: actorEmployeeId ?? null,
          },
          tx,
        );
        return cat;
      });
      createdId = created.id;
    } catch (e) {
      this.translateUniqueError(e);
      throw e;
    }
    this.logger.log(
      `event=pattern_category.create id=${createdId} name="${dto.name}" slug="${slug}"`,
    );
    return this.get(createdId);
  }

  // ===========================================================================
  // UPDATE
  // ===========================================================================

  async update(
    id: string,
    dto: UpdatePatternCategoryDto,
    actorEmployeeId?: string | null,
  ): Promise<PatternCategoryDto> {
    const current = await this.prisma.patternCategory.findUnique({
      where: { id },
    });
    if (!current) throw new PatternCategoryNotFoundException();

    const data: Prisma.PatternCategoryUpdateInput = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.iconKey !== undefined) data.iconKey = dto.iconKey;
    if (dto.slug !== undefined) data.slug = dto.slug;
    if (dto.sortOrder !== undefined) data.sortOrder = dto.sortOrder;
    if (dto.status !== undefined) data.status = dto.status;
    if (dto.description !== undefined) {
      data.description = dto.description ?? null;
    }
    try {
      await this.prisma.patternCategory.update({ where: { id }, data });
    } catch (e) {
      this.translateUniqueError(e);
      throw e;
    }
    this.logger.log(
      `event=pattern_category.update id=${id} fields=${Object.keys(dto).join(',')}`,
    );
    await this.audit.log({
      event: 'PATTERN_CATEGORY_UPDATED',
      entityType: 'PATTERN_CATEGORY',
      entityId: id,
      payload: {
        before: {
          name: current.name,
          slug: current.slug,
          iconKey: current.iconKey,
          sortOrder: current.sortOrder,
          status: current.status,
        },
        after: {
          name: dto.name ?? current.name,
          slug: dto.slug ?? current.slug,
          iconKey: dto.iconKey ?? current.iconKey,
          sortOrder: dto.sortOrder ?? current.sortOrder,
          status: dto.status ?? current.status,
        },
      },
      employeeId: actorEmployeeId ?? null,
    });
    return this.get(id);
  }

  /**
   * Soft-archive: ставим `status = ARCHIVED`. Карточки лекал с
   * `categoryId === id` НЕ трогаем — они продолжают ссылаться на
   * архивную категорию (UI рисует подсказку «архивная категория»),
   * чтобы менеджер мог восстановить её через `update({ status: 'ACTIVE' })`.
   */
  async archive(
    id: string,
    actorEmployeeId?: string | null,
  ): Promise<PatternCategoryDto> {
    const current = await this.prisma.patternCategory.findUnique({
      where: { id },
    });
    if (!current) throw new PatternCategoryNotFoundException();
    if (current.status !== 'ARCHIVED') {
      await this.prisma.patternCategory.update({
        where: { id },
        data: { status: 'ARCHIVED' },
      });
    }
    this.logger.log(`event=pattern_category.archive id=${id}`);
    await this.audit.log({
      event: 'PATTERN_CATEGORY_ARCHIVED',
      entityType: 'PATTERN_CATEGORY',
      entityId: id,
      payload: {
        previousStatus: current.status,
      },
      employeeId: actorEmployeeId ?? null,
    });
    return this.get(id);
  }

  // ===========================================================================
  // UPLOAD ICON (этап «Загружаемая иконка категории JPG/PNG»)
  // ===========================================================================

  /**
   * Загружает иконку категории (JPG/JPEG/PNG). Поток:
   *   1) проверяем, что категория существует;
   *   2) валидируем файл (расширение / размер) и пишем на диск;
   *   3) сохраняем `iconImageUrl` + `iconOriginalFileName` в БД;
   *   4) пишем `PATTERN_CATEGORY_ICON_UPLOADED` в audit log.
   *
   * Старый файл иконки физически НЕ удаляем (см. ADR-style комментарий
   * в `PatternCategoriesStorageService.saveIcon`).
   *
   * Если запрос пришёл без файла — кидаем
   * `PatternUploadMissingFileException` (тот же 400-код, что и в
   * upload-эндпоинтах модуля «Лекала»).
   */
  async uploadIcon(
    id: string,
    file: UploadedFileLike | undefined,
    actorEmployeeId?: string | null,
  ): Promise<PatternCategoryDto> {
    if (!file || !file.buffer || file.size === 0) {
      throw new PatternUploadMissingFileException();
    }
    const current = await this.prisma.patternCategory.findUnique({
      where: { id },
      select: { id: true, name: true },
    });
    if (!current) throw new PatternCategoryNotFoundException();

    const saved = await this.storage.saveIcon(id, file);
    await this.prisma.patternCategory.update({
      where: { id },
      data: {
        iconImageUrl: saved.publicUrl,
        iconOriginalFileName: saved.originalFileName,
      },
    });
    this.logger.log(
      `event=pattern_category.icon_upload id=${id} url=${saved.publicUrl}`,
    );
    await this.audit.log({
      event: 'PATTERN_CATEGORY_ICON_UPLOADED',
      entityType: 'PATTERN_CATEGORY',
      entityId: id,
      payload: {
        iconImageUrl: saved.publicUrl,
        originalFileName: saved.originalFileName,
        sizeBytes: file.size,
      },
      employeeId: actorEmployeeId ?? null,
    });
    return this.get(id);
  }

  // ===========================================================================
  // REPLACE PARAMETERS (bulk)
  // ===========================================================================

  async replaceParameters(
    id: string,
    dto: ReplacePatternCategoryParametersDto,
    actorEmployeeId?: string | null,
  ): Promise<PatternCategoryDto> {
    const current = await this.prisma.patternCategory.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!current) throw new PatternCategoryNotFoundException();

    const normalized: Array<
      ReturnType<typeof applyParameterDefaults>
    > = dto.parameters.map(applyParameterDefaults);

    await this.prisma.$transaction(async (tx) => {
      await tx.patternCategoryParameter.deleteMany({
        where: { categoryId: id },
      });
      if (normalized.length > 0) {
        await tx.patternCategoryParameter.createMany({
          data: normalized.map(
            (p: ReturnType<typeof applyParameterDefaults>) => ({
              categoryId: id,
              roleKey: p.roleKey,
              label: p.label,
              inputType: p.inputType,
              unit: p.unit,
              isRequired: p.isRequired,
              sortOrder: p.sortOrder,
              status: p.status,
              description: p.description ?? null,
            }),
          ),
        });
      }
      await this.audit.log(
        {
          event: 'PATTERN_CATEGORY_PARAMETERS_REPLACED',
          entityType: 'PATTERN_CATEGORY',
          entityId: id,
          payload: {
            count: normalized.length,
            roleKeys: normalized.map(
              (p: PatternCategoryParameterInputDto) => p.roleKey,
            ),
            inputTypes: normalized.map(
              (p: PatternCategoryParameterInputDto) => p.inputType,
            ),
          },
          employeeId: actorEmployeeId ?? null,
        },
        tx,
      );
    });
    this.logger.log(
      `event=pattern_category.params_replace id=${id} count=${normalized.length}`,
    );
    return this.get(id);
  }

  // ===========================================================================
  // INTERNAL
  // ===========================================================================

  private translateUniqueError(e: unknown): void {
    if (
      e instanceof Prisma.PrismaClientKnownRequestError &&
      e.code === 'P2002'
    ) {
      const target = (e.meta?.target as string[] | string | undefined) ?? [];
      const fields = Array.isArray(target) ? target : [target];
      if (fields.some((f) => String(f).includes('slug'))) {
        throw new PatternCategorySlugTakenException();
      }
    }
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

type CategoryWithIncludes = Prisma.PatternCategoryGetPayload<{
  include: {
    parameters: true;
    _count: { select: { parameters: true; patterns: true } };
  };
}>;

function toDetailDto(row: CategoryWithIncludes): PatternCategoryDto {
  const parameters: PatternCategoryParameterDto[] = row.parameters.map((p) => ({
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
  }));
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    iconKey: row.iconKey,
    iconImageUrl: row.iconImageUrl,
    iconOriginalFileName: row.iconOriginalFileName,
    sortOrder: row.sortOrder,
    status: row.status,
    description: row.description,
    parametersCount: row._count.parameters,
    patternsCount: row._count.patterns,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    parameters,
  };
}
