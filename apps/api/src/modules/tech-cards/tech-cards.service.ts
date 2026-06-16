import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type {
  CreateTechCardDto,
  ListTechCardsQuery,
  OutsourceTriggerType,
  TechCardMaterialColorRule,
  TechCardMaterialLineDto,
  TechCardMaterialLineInputDto,
  TechCardOutsourceLineDto,
  TechCardOutsourceLineInputDto,
  TechCardTemplateDetailDto,
  TechCardTemplateSummaryDto,
  UpdateTechCardDto,
} from '@sewing/shared/tech-cards';
import { isKnownTechCardMaterialRoleKey } from '@sewing/shared/tech-cards';
import {
  legacyColumnsToCharacteristics,
  type MaterialCharacteristics,
} from '@sewing/shared/material-characteristics';

import { PrismaService } from '../../prisma/prisma.service.js';
import {
  PatternCategoryInactiveException,
  PatternCategoryNotFoundException,
  TechCardCodeTakenException,
  TechCardDeleteForbiddenException,
  TechCardImageUploadMissingFileException,
  TechCardInactiveException,
  TechCardMaterialLineNotFoundException,
  TechCardNotFoundException,
} from '../../common/errors.js';
import {
  TechCardsStorageService,
} from './tech-cards-storage.service.js';
import type { UploadedFileLike } from '../patterns/patterns-storage.service.js';

/**
 * CRUD шаблонов техкарт. По духу аналогичен `RoutesService`:
 *   - admin создаёт `TechCardTemplate` со списками строк
 *     (`materialLines` + `outsourceLines`);
 *   - `sortOrder` нормализуется по позиции в массиве как `(i + 1) * 10`,
 *     UI работает с обычным порядком и не передаёт его явно;
 *   - PATCH со строками выполняет full-replace в одной транзакции —
 *     как `RoutesService.update` и `EquipmentOperationsService`;
 *   - snapshot заказа (`OrderMaterialRequirement[]` /
 *     `OrderOutsourceRequirement[]`) этот сервис не трогает: его
 *     создаёт `OrdersService.start()` (ADR-0022).
 *
 * Snapshot заказа независим от шаблона: FK
 * `OrderMaterial/OutsourceRequirement.sourceTechCardLineId` имеет
 * `ON DELETE SET NULL`, поэтому удаление строки техкарты не ломает
 * фиксированный план уже запущенных заказов.
 */
@Injectable()
export class TechCardsService {
  private readonly logger = new Logger(TechCardsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: TechCardsStorageService,
  ) {}

  // -------------------------------------------------------------------------
  // LIST
  // -------------------------------------------------------------------------

  async list(query: ListTechCardsQuery): Promise<TechCardTemplateSummaryDto[]> {
    const where: Prisma.TechCardTemplateWhereInput = {};
    if (query.isActive !== undefined) where.isActive = query.isActive;
    if (query.patternCategoryId) {
      where.patternCategoryId = query.patternCategoryId;
    }
    if (query.search) {
      where.OR = [
        { code: { contains: query.search, mode: 'insensitive' } },
        { name: { contains: query.search, mode: 'insensitive' } },
      ];
    }

    const rows = await this.prisma.techCardTemplate.findMany({
      where,
      orderBy: [{ isActive: 'desc' }, { code: 'asc' }],
      include: {
        _count: { select: { materialLines: true, outsourceLines: true } },
      },
    });

    return rows.map((row) => ({
      id: row.id,
      code: row.code,
      name: row.name,
      isActive: row.isActive,
      patternCategoryId: row.patternCategoryId,
      materialLinesCount: row._count.materialLines,
      outsourceLinesCount: row._count.outsourceLines,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    }));
  }

  // -------------------------------------------------------------------------
  // DETAIL
  // -------------------------------------------------------------------------

  async getOne(id: string): Promise<TechCardTemplateDetailDto> {
    const row = await this.prisma.techCardTemplate.findUnique({
      where: { id },
      include: {
        materialLines: { orderBy: { sortOrder: 'asc' } },
        outsourceLines: { orderBy: { sortOrder: 'asc' } },
      },
    });
    if (!row) throw new TechCardNotFoundException();
    return this.toDetailDto(row);
  }

  /**
   * Используется `OrdersService.start()` для построения snapshot-а
   * техкарты. По смыслу аналог `RoutesService.getActiveStepsForSnapshot`.
   * Активность шаблона здесь не проверяем: это уже делает
   * `assertTechCardUsable` при `create`/`update` заказа; в `start()`
   * допустимо запустить заказ с уже деактивированной техкартой
   * (план зафиксируется как был).
   */
  async getLinesForSnapshot(techCardId: string): Promise<{
    materialLines: {
      id: string;
      sortOrder: number;
      name: string;
      unit: string;
      qtyPerUnit: Prisma.Decimal;
      note: string | null;
      // Этап 3 «Потребности цеха»: копируются в snapshot
      // `OrderMaterialRequirement.*` без преобразований; `resolvedColorText`
      // считает уже `OrdersService.start()` по `colorRule` и `Order.color`.
      materialRole: string | null;
      fabricType: string | null;
      densityGsm: number | null;
      plannedWidthCm: number | null;
      colorRule: TechCardMaterialColorRule | null;
      fixedColorText: string | null;
      // Этап «Фурнитура / изображение материала» (см. ТЗ §3, §5):
      // snapshot-копии новых полей строки материала техкарты.
      hardwareSizeText: string | null;
      hardwareMaterialText: string | null;
      materialImageUrl: string | null;
      materialImageOriginalFileName: string | null;
      // Фаза 2 «Характеристики номенклатуры»: snapshot подтипа и значений.
      subtypeKey: string | null;
      characteristics: MaterialCharacteristics | null;
    }[];
    outsourceLines: {
      id: string;
      sortOrder: number;
      name: string;
      unit: string | null;
      qtyPerUnit: Prisma.Decimal | null;
      vendorName: string | null;
      note: string | null;
      // MVP-2 (ADR-0022 §«Cut-ready readiness»): копируется в snapshot
      // `OrderOutsourceRequirement.triggerType`.
      triggerType: OutsourceTriggerType;
    }[];
  }> {
    const tpl = await this.prisma.techCardTemplate.findUnique({
      where: { id: techCardId },
      include: {
        materialLines: { orderBy: { sortOrder: 'asc' } },
        outsourceLines: { orderBy: { sortOrder: 'asc' } },
      },
    });
    if (!tpl) throw new TechCardNotFoundException();
    return {
      materialLines: tpl.materialLines.map((l) => ({
        id: l.id,
        sortOrder: l.sortOrder,
        name: l.name,
        unit: l.unit,
        qtyPerUnit: l.qtyPerUnit,
        note: l.note,
        // БД хранит свободной строкой (расширяемость без миграции).
        // Запись валидируется shared schema (`TECH_CARD_MATERIAL_ROLE_KEYS`),
        // в snapshot пушим как есть — legacy roleKey-и тоже копируются
        // без преобразований (snapshot-independent от шаблона).
        materialRole: l.materialRole,
        fabricType: l.fabricType,
        densityGsm: l.densityGsm,
        plannedWidthCm: l.plannedWidthCm,
        colorRule: (l.colorRule as TechCardMaterialColorRule | null) ?? null,
        fixedColorText: l.fixedColorText,
        // Этап «Фурнитура / изображение материала»: новые snapshot-поля.
        hardwareSizeText: l.hardwareSizeText,
        hardwareMaterialText: l.hardwareMaterialText,
        materialImageUrl: l.materialImageUrl,
        materialImageOriginalFileName: l.materialImageOriginalFileName,
        // Фаза 2 «Характеристики номенклатуры».
        subtypeKey: l.subtypeKey,
        characteristics:
          (l.characteristics as MaterialCharacteristics | null) ?? null,
      })),
      outsourceLines: tpl.outsourceLines.map((l) => ({
        id: l.id,
        sortOrder: l.sortOrder,
        name: l.name,
        unit: l.unit,
        qtyPerUnit: l.qtyPerUnit,
        vendorName: l.vendorName,
        note: l.note,
        triggerType: l.triggerType,
      })),
    };
  }

  /**
   * Soft-protection для `OrdersService.create`/`update`: 404 если
   * техкарты нет, 409 если деактивирована. UI обычно прячет неактивные
   * в селекте, но прямой POST/PATCH `/api/orders` мы не доверяем.
   */
  async assertTechCardUsable(id: string): Promise<void> {
    const tpl = await this.prisma.techCardTemplate.findUnique({
      where: { id },
      select: { id: true, isActive: true },
    });
    if (!tpl) throw new TechCardNotFoundException();
    if (!tpl.isActive) throw new TechCardInactiveException();
  }

  /**
   * Inline-создание изделия из формы заказа: при привязке техкарты
   * к группе номенклатуры (`patternCategoryId`) валидируем, что
   * категория существует и `status = ACTIVE`.
   */
  private async assertPatternCategoryUsable(
    patternCategoryId: string,
  ): Promise<void> {
    const cat = await this.prisma.patternCategory.findUnique({
      where: { id: patternCategoryId },
      select: { id: true, status: true },
    });
    if (!cat) throw new PatternCategoryNotFoundException();
    if (cat.status !== 'ACTIVE') {
      throw new PatternCategoryInactiveException();
    }
  }

  // -------------------------------------------------------------------------
  // CREATE
  // -------------------------------------------------------------------------

  async create(dto: CreateTechCardDto): Promise<TechCardTemplateDetailDto> {
    if (dto.patternCategoryId) {
      await this.assertPatternCategoryUsable(dto.patternCategoryId);
    }
    let createdId: string;
    try {
      createdId = await this.prisma.$transaction(async (tx) => {
        const created = await tx.techCardTemplate.create({
          data: {
            code: dto.code,
            name: dto.name,
            isActive: dto.isActive ?? true,
            patternCategoryId: dto.patternCategoryId ?? null,
          },
        });
        if (dto.materialLines.length > 0) {
          // Создание новой техкарты — legacy ролей быть не может,
          // whitelist строгий: TECH_CARD_MATERIAL_ROLE_KEYS.
          await tx.techCardMaterialLine.createMany({
            data: dto.materialLines.map((l, i) =>
              this.materialLineCreateData(created.id, l, i),
            ),
          });
        }
        if (dto.outsourceLines.length > 0) {
          await tx.techCardOutsourceLine.createMany({
            data: dto.outsourceLines.map((l, i) =>
              this.outsourceLineCreateData(created.id, l, i),
            ),
          });
        }
        return created.id;
      });
    } catch (e) {
      this.translateUniqueError(e);
      throw e;
    }

    this.logger.log(
      `event=tech_card.create id=${createdId} code=${dto.code} ` +
        `materials=${dto.materialLines.length} outsource=${dto.outsourceLines.length}`,
    );
    return this.getOne(createdId);
  }

  // -------------------------------------------------------------------------
  // UPDATE (full-replace для строк)
  // -------------------------------------------------------------------------

  async update(
    id: string,
    dto: UpdateTechCardDto,
  ): Promise<TechCardTemplateDetailDto> {
    const existing = await this.prisma.techCardTemplate.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!existing) throw new TechCardNotFoundException();

    if (dto.patternCategoryId) {
      await this.assertPatternCategoryUsable(dto.patternCategoryId);
    }

    try {
      await this.prisma.$transaction(async (tx) => {
        const data: Prisma.TechCardTemplateUpdateInput = {};
        if (dto.code !== undefined) data.code = dto.code;
        if (dto.name !== undefined) data.name = dto.name;
        if (dto.isActive !== undefined) data.isActive = dto.isActive;
        if (dto.patternCategoryId !== undefined) {
          (data as { patternCategoryId?: string | null }).patternCategoryId =
            dto.patternCategoryId;
        }
        if (Object.keys(data).length > 0) {
          await tx.techCardTemplate.update({ where: { id }, data });
        }

        if (dto.materialLines !== undefined) {
          // Этап «Доработка UI и контракта техкарты» (см. ТЗ §1):
          // при PATCH full-replace разрешаем сохранить строки с
          // legacy roleKey-ами, которые УЖЕ были в старой техкарте
          // (например, APPLICATION или ad-hoc-строка). Это нужно,
          // чтобы менеджер мог открыть старую техкарту и сохранить
          // её без ошибок, даже не редактируя legacy-роль. Полностью
          // новые невалидные roleKey-и по-прежнему отбрасываются с
          // 400 `TECH_CARD_MATERIAL_ROLE_INVALID`.
          const existingLegacyRoleKeys = new Set(
            (
              await tx.techCardMaterialLine.findMany({
                where: { techCardId: id },
                select: { materialRole: true },
              })
            )
              .map((r) => r.materialRole)
              .filter(
                (k): k is string =>
                  k != null &&
                  // Whitelist пустой не помещаем — он и так разрешён.
                  // Сохраняем только то, что уже было в БД.
                  k.length > 0,
              ),
          );
          await tx.techCardMaterialLine.deleteMany({
            where: { techCardId: id },
          });
          if (dto.materialLines.length > 0) {
            await tx.techCardMaterialLine.createMany({
              data: dto.materialLines.map((l, i) =>
                this.materialLineCreateData(id, l, i, {
                  existingRoleKeys: existingLegacyRoleKeys,
                }),
              ),
            });
          }
        }

        if (dto.outsourceLines !== undefined) {
          await tx.techCardOutsourceLine.deleteMany({
            where: { techCardId: id },
          });
          if (dto.outsourceLines.length > 0) {
            await tx.techCardOutsourceLine.createMany({
              data: dto.outsourceLines.map((l, i) =>
                this.outsourceLineCreateData(id, l, i),
              ),
            });
          }
        }
      });
    } catch (e) {
      this.translateUniqueError(e);
      throw e;
    }

    this.logger.log(
      `event=tech_card.update id=${id} fields=${Object.keys(dto).join(',')}`,
    );
    return this.getOne(id);
  }

  /**
   * Hard-delete техкарты (этап «Удалить архивную запись навсегда»).
   *
   * На MVP DELETE техкарты намеренно не выставлялся (см. JSDoc
   * `TechCardsController`): карта может быть зашита в snapshot заказов.
   * Поэтому действует политика «блокировать, если используется»
   * (`TechCardDeleteForbiddenException`):
   *   1) удалять можно ТОЛЬКО деактивированную карту (`isActive =
   *      false`) — это её soft-удалённое состояние;
   *   2) блокируем, если на карту ссылается хотя бы один заказ
   *      (`Order.techCardId`, FK `SET NULL`) ИЛИ её строки уже попали
   *      в snapshot потребностей заказа (`OrderMaterialRequirement` /
   *      `OrderOutsourceRequirement.sourceTechCardLineId`).
   *
   * Строки карты (`TechCardMaterialLine` / `TechCardOutsourceLine`)
   * уходят каскадом — это части самой карты.
   */
  async remove(id: string): Promise<void> {
    const tpl = await this.prisma.techCardTemplate.findUnique({
      where: { id },
      select: { id: true, code: true, name: true, isActive: true },
    });
    if (!tpl) throw new TechCardNotFoundException();
    if (tpl.isActive) {
      throw new TechCardDeleteForbiddenException(
        'Удалить навсегда можно только архивную (неактивную) техкарту. Как удалить: сначала нажмите «Архивировать», затем кнопку «Удалить навсегда».',
      );
    }

    const [orderCount, matReqCount, outReqCount] = await Promise.all([
      this.prisma.order.count({ where: { techCardId: id } }),
      this.prisma.orderMaterialRequirement.count({
        where: { sourceTechCardLine: { techCardId: id } },
      }),
      this.prisma.orderOutsourceRequirement.count({
        where: { sourceTechCardLine: { techCardId: id } },
      }),
    ]);
    const snapshotRefs = matReqCount + outReqCount;
    if (orderCount > 0 || snapshotRefs > 0) {
      const parts: string[] = [];
      if (orderCount > 0) parts.push(`заказов: ${orderCount}`);
      if (snapshotRefs > 0)
        parts.push(`строк в потребностях заказов: ${snapshotRefs}`);
      throw new TechCardDeleteForbiddenException(
        `Эту техкарту удалить навсегда нельзя: её используют ${parts.join(
          ', ',
        )}. Заказы хранят её snapshot, поэтому удалить карту можно только после удаления этих заказов. Если они нужны — просто оставьте карту в архиве: в новые заказы неактивные не предлагаются.`,
      );
    }

    await this.prisma.techCardTemplate.delete({ where: { id } });
    this.logger.log(`event=tech_card.delete id=${id} code=${tpl.code}`);
  }

  // -------------------------------------------------------------------------
  // MATERIAL LINE IMAGE UPLOAD (см. ТЗ §5, §9)
  // -------------------------------------------------------------------------

  /**
   * Сохраняет JPG/JPEG/PNG-изображение для конкретной строки материала
   * техкарты. Идёт от техкарты, не от строки изолированно: проверяем,
   * что строка действительно принадлежит указанной техкарте — иначе
   * можно было бы переписать чужую строку, зная её id.
   *
   * НЕ менять другие поля строки — только `materialImageUrl` и
   * `materialImageOriginalFileName` (см. ТЗ §5 «не меняет другие
   * поля строки»). Не пересчитывать sortOrder, не сбрасывать
   * hardware-поля и т.п. В частности, операция работает и для
   * legacy-строк со старыми roleKey-ами (APPLICATION) — никакой
   * валидации roleKey тут нет.
   *
   * Аналогично `PatternsService.uploadPreview`: сначала пишем файл
   * на диск, потом обновляем БД. Если БД-обновление упадёт, файл
   * остаётся «осиротевшим» — на MVP это приемлемо (тот же подход,
   * что и в модуле «Лекала»).
   */
  async uploadMaterialImage(
    techCardId: string,
    lineId: string,
    file: UploadedFileLike | undefined,
  ): Promise<TechCardTemplateDetailDto> {
    if (!file) throw new TechCardImageUploadMissingFileException();

    const line = await this.prisma.techCardMaterialLine.findFirst({
      where: { id: lineId, techCardId },
      select: { id: true },
    });
    if (!line) {
      // Различаем «техкарты нет» и «строки нет в этой техкарте» — UI
      // покажет осмысленное сообщение. Для строки в чужой техкарте
      // это тоже 404, чтобы не утекали id чужих ресурсов.
      const tpl = await this.prisma.techCardTemplate.findUnique({
        where: { id: techCardId },
        select: { id: true },
      });
      if (!tpl) throw new TechCardNotFoundException();
      throw new TechCardMaterialLineNotFoundException();
    }

    const saved = await this.storage.saveMaterialImage(
      techCardId,
      lineId,
      file,
    );
    await this.prisma.techCardMaterialLine.update({
      where: { id: lineId },
      data: {
        materialImageUrl: saved.publicUrl,
        materialImageOriginalFileName: saved.originalFileName,
      },
    });
    this.logger.log(
      `event=tech_card.material_line_image_upload techCardId=${techCardId} ` +
        `lineId=${lineId} url=${saved.publicUrl}`,
    );
    return this.getOne(techCardId);
  }

  // -------------------------------------------------------------------------
  // INTERNAL
  // -------------------------------------------------------------------------

  private materialLineCreateData(
    techCardId: string,
    line: TechCardMaterialLineInputDto,
    index: number,
    opts: { existingRoleKeys?: ReadonlySet<string> } = {},
  ): Prisma.TechCardMaterialLineCreateManyInput {
    // Этап 3 «Потребности цеха»: при `colorRule != FIXED_COLOR` сервис
    // зачищает `fixedColorText` в null — даже если форма по ошибке
    // передала непустое значение. Это инвариант на уровне БД-записи:
    // «фиксированный цвет имеет смысл только при FIXED_COLOR».
    const colorRule = line.colorRule ?? null;
    const fixedColorText =
      colorRule === 'FIXED_COLOR' ? line.fixedColorText ?? null : null;
    // Этап «Фурнитура в техкарте» (см. ТЗ §3): hardware-поля имеют
    // смысл только для роли PACKAGING. Сервис принудительно зачищает
    // их в null для других ролей — это защищает контракт snapshot-а
    // заказа от «висячих» значений (например, если менеджер сначала
    // выбрал PACKAGING и заполнил «Размер», а потом сменил роль).
    const isHardwareRole = line.materialRole === 'PACKAGING';
    // Фаза 2 «Характеристики номенклатуры»: characteristics — источник
    // истины, если форма их прислала; иначе собираем из явных legacy-
    // полей (backward-compat со старой формой). Затем ЗЕРКАЛИМ legacy-
    // колонки из characteristics, чтобы downstream (cut-readiness,
    // себестоимость, snapshot заказа) продолжал читать привычные
    // densityGsm/plannedWidthCm/hardware* без изменений.
    const sentChars =
      line.characteristics && Object.keys(line.characteristics).length > 0
        ? line.characteristics
        : null;
    const chars: MaterialCharacteristics =
      sentChars ??
      legacyColumnsToCharacteristics({
        densityGsm: line.densityGsm,
        plannedWidthCm: line.plannedWidthCm,
        hardwareSizeText: line.hardwareSizeText,
        hardwareMaterialText: line.hardwareMaterialText,
      });
    const toInt = (v: unknown): number | null => {
      if (v === null || v === undefined || v === '') return null;
      const n = Number(v);
      return Number.isInteger(n) && n > 0 ? n : null;
    };
    const toText = (v: unknown): string | null => {
      if (v === null || v === undefined) return null;
      const s = String(v).trim();
      return s === '' ? null : s;
    };
    // Роль-зависимая очистка (инвариант прошлых этапов): density/
    // rollWidth — только для не-PACKAGING; size/material — только для
    // PACKAGING. Иначе после смены роли остались бы «висячие» значения.
    const densityGsm = isHardwareRole ? null : toInt(chars.density);
    const plannedWidthCm = isHardwareRole ? null : toInt(chars.rollWidth);
    const hardwareSizeText = isHardwareRole ? toText(chars.size) : null;
    const hardwareMaterialText = isHardwareRole
      ? toText(chars.material)
      : null;
    // Итоговый characteristics в БД: зеркало legacy-колонок (после
    // роль-очистки) + новые характеристики без legacy-колонки
    // (type/length/thickness/holesCount/width) из присланных формой.
    const cleanedChars: MaterialCharacteristics = {};
    if (densityGsm != null) cleanedChars.density = densityGsm;
    if (plannedWidthCm != null) cleanedChars.rollWidth = plannedWidthCm;
    if (hardwareSizeText != null) cleanedChars.size = hardwareSizeText;
    if (hardwareMaterialText != null) cleanedChars.material = hardwareMaterialText;
    if (sentChars) {
      for (const [k, v] of Object.entries(sentChars)) {
        if (k === 'density' || k === 'rollWidth' || k === 'size' || k === 'material') {
          continue;
        }
        if (v === null || v === undefined || v === '') continue;
        cleanedChars[k] = v;
      }
    }
    const characteristics =
      Object.keys(cleanedChars).length > 0 ? cleanedChars : null;
    // Этап «Доработка UI и контракта техкарты» (см. ТЗ §1): для НОВЫХ
    // строк roleKey должен быть из `PATTERN_CATEGORY_PARAMETER_GROUPS`.
    // Legacy (`existingRoleKeys` приходит из старой техкарты при
    // PATCH full-replace) — пропускаем без проверки. Если пользователь
    // явно выбирает невалидную новую роль → 422 на уровне
    // ZodValidationPipe + сервис не пишет.
    const role = line.materialRole ?? null;
    if (role !== null) {
      const allowed = isKnownTechCardMaterialRoleKey(role);
      const isLegacyKept = opts.existingRoleKeys?.has(role) ?? false;
      if (!allowed && !isLegacyKept) {
        throw new BadRequestException({
          statusCode: 400,
          code: 'TECH_CARD_MATERIAL_ROLE_INVALID',
          message: `Роль материала «${role}» не входит в список доступных. Используйте роли из карточки номенклатуры.`,
        });
      }
    }
    return {
      techCardId,
      sortOrder: (index + 1) * 10,
      name: line.name,
      unit: line.unit,
      // Zod гарантирует "положительная строка-Decimal"; null здесь
      // невозможен (поле required в схеме), но TS-сужение требует
      // проверки.
      qtyPerUnit: new Prisma.Decimal(line.qtyPerUnit ?? '0'),
      note: line.note,
      materialRole: role,
      fabricType: line.fabricType ?? null,
      densityGsm,
      plannedWidthCm,
      colorRule,
      fixedColorText,
      hardwareSizeText,
      hardwareMaterialText,
      materialImageUrl: line.materialImageUrl ?? null,
      materialImageOriginalFileName:
        line.materialImageOriginalFileName ?? null,
      subtypeKey: line.subtypeKey && line.subtypeKey.length ? line.subtypeKey : null,
      characteristics: characteristics ?? Prisma.DbNull,
    };
  }

  private outsourceLineCreateData(
    techCardId: string,
    line: TechCardOutsourceLineInputDto,
    index: number,
  ): Prisma.TechCardOutsourceLineCreateManyInput {
    return {
      techCardId,
      sortOrder: (index + 1) * 10,
      name: line.name,
      unit: line.unit,
      qtyPerUnit:
        line.qtyPerUnit == null ? null : new Prisma.Decimal(line.qtyPerUnit),
      vendorName: line.vendorName,
      note: line.note,
      // MVP-2: Zod гарантирует один из двух валидных enum-значений и
      // подставляет дефолт `MANUAL`, если поле отсутствует — backward-
      // compat со старыми клиентами/формами (см. ADR-0022).
      triggerType: line.triggerType,
    };
  }

  private toDetailDto(
    row: Prisma.TechCardTemplateGetPayload<{
      include: { materialLines: true; outsourceLines: true };
    }>,
  ): TechCardTemplateDetailDto {
    const materialLines: TechCardMaterialLineDto[] = row.materialLines
      .slice()
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((l) => ({
        id: l.id,
        sortOrder: l.sortOrder,
        name: l.name,
        unit: l.unit,
        qtyPerUnit: l.qtyPerUnit.toString(),
        note: l.note,
        // Этап 3 «Потребности цеха»: новые поля. БД хранит свободной
        // строкой; DTO отдаёт строку как есть — UI через
        // `getTechCardMaterialRoleLabel` маппит в человекочитаемый
        // лейбл (включая legacy roleKey-и).
        materialRole: l.materialRole,
        fabricType: l.fabricType,
        densityGsm: l.densityGsm,
        plannedWidthCm: l.plannedWidthCm,
        colorRule:
          (l.colorRule as TechCardMaterialColorRule | null) ?? null,
        fixedColorText: l.fixedColorText,
        // Этап «Фурнитура / изображение материала».
        hardwareSizeText: l.hardwareSizeText,
        hardwareMaterialText: l.hardwareMaterialText,
        materialImageUrl: l.materialImageUrl,
        materialImageOriginalFileName: l.materialImageOriginalFileName,
        // Фаза 2 «Характеристики номенклатуры».
        subtypeKey: l.subtypeKey,
        characteristics:
          (l.characteristics as MaterialCharacteristics | null) ?? null,
      }));
    const outsourceLines: TechCardOutsourceLineDto[] = row.outsourceLines
      .slice()
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((l) => ({
        id: l.id,
        sortOrder: l.sortOrder,
        name: l.name,
        unit: l.unit,
        qtyPerUnit: l.qtyPerUnit ? l.qtyPerUnit.toString() : null,
        vendorName: l.vendorName,
        note: l.note,
        triggerType: l.triggerType as OutsourceTriggerType,
      }));
    return {
      id: row.id,
      code: row.code,
      name: row.name,
      isActive: row.isActive,
      patternCategoryId: row.patternCategoryId,
      materialLinesCount: materialLines.length,
      outsourceLinesCount: outsourceLines.length,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      materialLines,
      outsourceLines,
    };
  }

  private translateUniqueError(e: unknown): void {
    if (
      e instanceof Prisma.PrismaClientKnownRequestError &&
      e.code === 'P2002'
    ) {
      throw new TechCardCodeTakenException();
    }
  }
}
