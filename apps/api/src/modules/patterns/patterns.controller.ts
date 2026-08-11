import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import {
  ClonePatternSchema,
  CreatePatternSchema,
  ListPatternsQuerySchema,
  PATTERN_FILE_MAX_SIZE_BYTES,
  PatternsArchiveRequestSchema,
  ReplacePatternItemParameterNormsSchema,
  ReplacePatternItemSizeParameterValuesSchema,
  ReplacePatternMaterialAreasSchema,
  UpdatePatternSchema,
  type ClonePatternDto,
  type CreatePatternDto,
  type ListPatternsQuery,
  type PatternDetailDto,
  type PatternListItemDto,
  type PatternsArchiveRequestDto,
  type PatternsArchiveResultDto,
  type ReplacePatternItemParameterNormsDto,
  type ReplacePatternItemSizeParameterValuesDto,
  type ReplacePatternMaterialAreasDto,
  type UpdatePatternDto,
} from '@sewing/shared/patterns';
import {
  ReplacePatternItemMaterialSpecSchema,
  type ReplacePatternItemMaterialSpecDto,
} from '@sewing/shared/pattern-item-spec';
import { ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import { CurrentUser, Roles } from '../auth/auth.decorators.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { PatternsService } from './patterns.service.js';
import type { UploadedFileLike } from './patterns-storage.service.js';

/**
 * Контроллер модуля «Лекала» (Patterns MVP-1, изолированный).
 *
 *   GET    /api/patterns                                           — список
 *   GET    /api/patterns/:id                                       — карточка
 *   POST   /api/patterns                                           — создать
 *   PATCH  /api/patterns/:id                                       — править
 *   POST   /api/patterns/archive                                   — bulk в архив
 *   POST   /api/patterns/restore                                   — bulk из архива
 *   POST   /api/patterns/purge                                     — bulk удалить навсегда
 *   DELETE /api/patterns/:id/permanent                             — удалить навсегда (одну)
 *   POST   /api/patterns/:id/preview                               — загрузить превью
 *   POST   /api/patterns/:id/sizes/:sizeId/file                    — загрузить DXF (новая версия)
 *   DELETE /api/patterns/:id/sizes/:sizeId/file/:fileId            — архивировать DXF
 *   POST   /api/patterns/:id/sizes/:sizeId/file/:fileId/restore    — восстановить из архива
 *   DELETE /api/patterns/:id/sizes/:sizeId/file/:fileId/permanent  — удалить DXF навсегда
 *   PUT    /api/patterns/:id/material-areas                        — bulk-replace площадей
 *
 * RBAC — `ADMIN`/`SHOP_MANAGER` (см. требования к этапу). Файлы
 * пишутся через `multer.memoryStorage()` — buffer передаём
 * `PatternsStorageService`, который сам решает, куда их разложить;
 * лимит размера дублируется и в multer-конфиге, и в сервисной
 * проверке (см. ADR-style комментарий в `patterns-storage.service.ts`).
 */
@Roles('ADMIN', 'SHOP_MANAGER')
@Controller('patterns')
export class PatternsController {
  constructor(private readonly patterns: PatternsService) {}

  @Get()
  list(
    @Query(new ZodValidationPipe(ListPatternsQuerySchema))
    query: ListPatternsQuery,
  ): Promise<PatternListItemDto[]> {
    return this.patterns.list(query);
  }

  @Post()
  create(
    @Body(new ZodValidationPipe(CreatePatternSchema))
    body: CreatePatternDto,
    @CurrentUser() user: AuthPrincipal,
  ): Promise<PatternDetailDto> {
    return this.patterns.create(body, user.employeeId);
  }

  /**
   * Массовые операции архива номенклатуры (этап «Архив номенклатуры»,
   * по аналогии с `/api/workshop-needs/archive|restore|purge`):
   *
   *   POST /api/patterns/archive — мягко скрыть в архив (обратимо);
   *   POST /api/patterns/restore — вернуть из архива;
   *   POST /api/patterns/purge   — удалить безвозвратно (только из
   *                                архива, блок если есть заказы).
   *
   * Ответ — частичный успех (`processed` / `skipped` с причиной), а не
   * 409 на первую же непрошедшую карточку: список массовый, менеджеру
   * важно обработать остальные.
   *
   * ВАЖНО: объявлены ДО `@Get(':id')`/`@Post(':id/clone')` только для
   * читаемости — конфликта нет (одноимённого `@Post(':id')` в
   * контроллере не существует).
   */
  @Post('archive')
  archiveMany(
    @Body(new ZodValidationPipe(PatternsArchiveRequestSchema))
    body: PatternsArchiveRequestDto,
    @CurrentUser() user: AuthPrincipal,
  ): Promise<PatternsArchiveResultDto> {
    return this.patterns.archiveMany(body.patternIds, user.employeeId);
  }

  @Post('restore')
  restoreMany(
    @Body(new ZodValidationPipe(PatternsArchiveRequestSchema))
    body: PatternsArchiveRequestDto,
    @CurrentUser() user: AuthPrincipal,
  ): Promise<PatternsArchiveResultDto> {
    return this.patterns.restoreMany(body.patternIds, user.employeeId);
  }

  @Post('purge')
  purgeMany(
    @Body(new ZodValidationPipe(PatternsArchiveRequestSchema))
    body: PatternsArchiveRequestDto,
    @CurrentUser() user: AuthPrincipal,
  ): Promise<PatternsArchiveResultDto> {
    return this.patterns.purgeMany(body.patternIds, user.employeeId);
  }

  @Get(':id')
  getOne(@Param('id') id: string): Promise<PatternDetailDto> {
    return this.patterns.getOne(id);
  }

  /**
   * Клонирование номенклатуры (`POST /api/patterns/:id/clone`). Этап
   * «Создать номенклатуру по готовому лекалу» — см.
   * `PatternsService.clone`. Body опционален: если поля `name`/`article`
   * не заданы, backend сам подбирает значения (см. сервис).
   */
  @Post(':id/clone')
  clone(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(ClonePatternSchema))
    body: ClonePatternDto,
    @CurrentUser() user: AuthPrincipal,
  ): Promise<PatternDetailDto> {
    return this.patterns.clone(id, body, user.employeeId);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(UpdatePatternSchema))
    body: UpdatePatternDto,
    @CurrentUser() user: AuthPrincipal,
  ): Promise<PatternDetailDto> {
    return this.patterns.update(id, body, user.employeeId);
  }

  /**
   * Hard-delete архивной номенклатуры (этап «Удалить архивную запись
   * навсегда»). Отдельный путь `:id/permanent`, чтобы не путать с
   * архивацией DXF (`DELETE :id/sizes/...`). Сервис блокирует удаление,
   * если лекало не `ARCHIVED` или на него ссылаются заказы
   * (`PATTERN_DELETE_FORBIDDEN`).
   */
  @Delete(':id/permanent')
  remove(
    @Param('id') id: string,
    @CurrentUser() user: AuthPrincipal,
  ): Promise<void> {
    return this.patterns.remove(id, user.employeeId);
  }

  @Post(':id/preview')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: PATTERN_FILE_MAX_SIZE_BYTES },
    }),
  )
  uploadPreview(
    @Param('id') id: string,
    @UploadedFile() file: UploadedFileLike | undefined,
    @CurrentUser() user: AuthPrincipal,
  ): Promise<PatternDetailDto> {
    return this.patterns.uploadPreview(id, file, user.employeeId);
  }

  @Post(':id/sizes/:sizeId/file')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: PATTERN_FILE_MAX_SIZE_BYTES },
    }),
  )
  uploadSizeFile(
    @Param('id') id: string,
    @Param('sizeId') sizeId: string,
    @UploadedFile() file: UploadedFileLike | undefined,
    @CurrentUser() user: AuthPrincipal,
  ): Promise<PatternDetailDto> {
    return this.patterns.uploadSizeFile(id, sizeId, file, user.employeeId);
  }

  @Delete(':id/sizes/:sizeId/file/:fileId')
  archiveSizeFile(
    @Param('id') id: string,
    @Param('sizeId') sizeId: string,
    @Param('fileId') fileId: string,
    @CurrentUser() user: AuthPrincipal,
  ): Promise<PatternDetailDto> {
    return this.patterns.archiveSizeFile(id, sizeId, fileId, user.employeeId);
  }

  @Post(':id/sizes/:sizeId/file/:fileId/restore')
  restoreSizeFile(
    @Param('id') id: string,
    @Param('sizeId') sizeId: string,
    @Param('fileId') fileId: string,
    @CurrentUser() user: AuthPrincipal,
  ): Promise<PatternDetailDto> {
    return this.patterns.restoreSizeFile(id, sizeId, fileId, user.employeeId);
  }

  @Delete(':id/sizes/:sizeId/file/:fileId/permanent')
  deleteSizeFilePermanent(
    @Param('id') id: string,
    @Param('sizeId') sizeId: string,
    @Param('fileId') fileId: string,
    @CurrentUser() user: AuthPrincipal,
  ): Promise<PatternDetailDto> {
    return this.patterns.deleteSizeFilePermanent(
      id,
      sizeId,
      fileId,
      user.employeeId,
    );
  }

  @Put(':id/material-areas')
  replaceMaterialAreas(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(ReplacePatternMaterialAreasSchema))
    body: ReplacePatternMaterialAreasDto,
    @CurrentUser() user: AuthPrincipal,
  ): Promise<PatternDetailDto> {
    return this.patterns.replaceMaterialAreas(id, body, user.employeeId);
  }

  /**
   * Этап «Фурнитура и нормы» (см. ТЗ, `PatternsService.replaceParameterNorms`).
   * Bulk-replace норм «количество на изделие» по параметрам категории
   * с `inputType = QTY_PER_ITEM`. Параметры, для которых в payload
   * нет нормы, удаляются — это «очистить норму».
   */
  @Put(':id/parameter-norms')
  replaceParameterNorms(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(ReplacePatternItemParameterNormsSchema))
    body: ReplacePatternItemParameterNormsDto,
    @CurrentUser() user: AuthPrincipal,
  ): Promise<PatternDetailDto> {
    return this.patterns.replaceParameterNorms(id, body, user.employeeId);
  }

  /**
   * Этап «Погонные метры по размерам» (см. ТЗ §7,
   * `PatternsService.replaceSizeParameterValues`).
   *
   * Bulk-replace значений «погонных метров по размерам» для параметров
   * категории с `inputType = LINEAR_M_BY_SIZE`. Параметры, для которых
   * в payload значений нет, очищаются. На MVP таблица
   * `PatternItemSizeParameterValue` используется только под
   * LINEAR_M_BY_SIZE.
   */
  @Put(':id/size-parameter-values')
  replaceSizeParameterValues(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(ReplacePatternItemSizeParameterValuesSchema))
    body: ReplacePatternItemSizeParameterValuesDto,
    @CurrentUser() user: AuthPrincipal,
  ): Promise<PatternDetailDto> {
    return this.patterns.replaceSizeParameterValues(id, body, user.employeeId);
  }

  /**
   * Этап 1 плана «техкарты → номенклатура» (анализ 11.08.2026):
   * атомарный full-replace СОСТАВА МАТЕРИАЛОВ карточки (строки +
   * слоты-параметры) — как PATCH техкарты, но одной ручкой и всегда с
   * полным итоговым состоянием (см.
   * `PatternsService.replaceMaterialSpec`).
   */
  @Put(':id/material-spec')
  replaceMaterialSpec(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(ReplacePatternItemMaterialSpecSchema))
    body: ReplacePatternItemMaterialSpecDto,
    @CurrentUser() user: AuthPrincipal,
  ): Promise<PatternDetailDto> {
    return this.patterns.replaceMaterialSpec(id, body, user.employeeId);
  }
}
