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
  CreatePatternCategorySchema,
  ListPatternCategoriesQuerySchema,
  ReplacePatternCategoryParametersSchema,
  UpdatePatternCategorySchema,
  type CreatePatternCategoryDto,
  type ListPatternCategoriesQuery,
  type PatternCategoryDto,
  type PatternCategoryListItemDto,
  type ReplacePatternCategoryParametersDto,
  type UpdatePatternCategoryDto,
} from '@sewing/shared/pattern-categories';
import { ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import { CurrentUser, MachineScopes, Roles } from '../auth/auth.decorators.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { PatternCategoriesService } from './pattern-categories.service.js';
import { PatternCategoriesStorageService } from './pattern-categories-storage.service.js';
import type { UploadedFileLike } from '../patterns/patterns-storage.service.js';

/**
 * Контроллер модуля «Категории номенклатуры» (этап «Категории
 * номенклатуры»).
 *
 *   GET    /api/pattern-categories                             — список (фильтры: status, search)
 *   GET    /api/pattern-categories/:id                         — карточка с параметрами
 *   POST   /api/pattern-categories                             — создать (с параметрами)
 *   PATCH  /api/pattern-categories/:id                         — править поля карточки
 *   PUT    /api/pattern-categories/:id/parameters              — bulk-replace параметров
 *   POST   /api/pattern-categories/:id/icon                    — загрузить иконку JPG/JPEG/PNG (multipart/form-data)
 *   DELETE /api/pattern-categories/:id                         — soft-archive (status=ARCHIVED)
 *
 * RBAC — `ADMIN`/`SHOP_MANAGER` (как у `/api/patterns`).
 */
@Roles('ADMIN', 'SHOP_MANAGER')
@Controller('pattern-categories')
@MachineScopes('patterns:read', 'patterns:write')
export class PatternCategoriesController {
  constructor(private readonly service: PatternCategoriesService) {}

  @Get()
  list(
    @Query(new ZodValidationPipe(ListPatternCategoriesQuerySchema))
    query: ListPatternCategoriesQuery,
  ): Promise<PatternCategoryListItemDto[]> {
    return this.service.list(query);
  }

  @Get(':id')
  get(@Param('id') id: string): Promise<PatternCategoryDto> {
    return this.service.get(id);
  }

  @Post()
  create(
    @Body(new ZodValidationPipe(CreatePatternCategorySchema))
    body: CreatePatternCategoryDto,
    @CurrentUser() user: AuthPrincipal,
  ): Promise<PatternCategoryDto> {
    return this.service.create(body, user.employeeId);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(UpdatePatternCategorySchema))
    body: UpdatePatternCategoryDto,
    @CurrentUser() user: AuthPrincipal,
  ): Promise<PatternCategoryDto> {
    return this.service.update(id, body, user.employeeId);
  }

  @Put(':id/parameters')
  replaceParameters(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(ReplacePatternCategoryParametersSchema))
    body: ReplacePatternCategoryParametersDto,
    @CurrentUser() user: AuthPrincipal,
  ): Promise<PatternCategoryDto> {
    return this.service.replaceParameters(id, body, user.employeeId);
  }

  /**
   * Загрузка иконки категории — JPG/JPEG/PNG (этап «Загружаемая
   * иконка категории»). Multipart-поле `file`. Лимит размера дублируется в
   * `multer` и в сервисной проверке (см.
   * `PatternCategoriesStorageService.assertSize`) — multer обрезает
   * слишком большие запросы ещё до вызова контроллера, а сервис
   * ловит «обход» multer и кидает понятную бизнес-ошибку.
   */
  @Post(':id/icon')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: PatternCategoriesStorageService.ICON_MAX_SIZE_BYTES },
    }),
  )
  uploadIcon(
    @Param('id') id: string,
    @UploadedFile() file: UploadedFileLike | undefined,
    @CurrentUser() user: AuthPrincipal,
  ): Promise<PatternCategoryDto> {
    return this.service.uploadIcon(id, file, user.employeeId);
  }

  
  @Delete(':id')
  archive(
    @Param('id') id: string,
    @CurrentUser() user: AuthPrincipal,
  ): Promise<PatternCategoryDto> {
    return this.service.archive(id, user.employeeId);
  }

  /**
   * Hard-delete архивной категории (этап «Удалить архивную запись
   * навсегда»). Отдельный путь `:id/permanent`, чтобы не конфликтовать
   * с `DELETE :id` (soft-archive). Сервис блокирует удаление, если
   * категория не `ARCHIVED` (`PATTERN_CATEGORY_DELETE_FORBIDDEN`).
   *
   * `?cascade=1` — явное согласие на каскад по содержимому группы:
   * номенклатура уходит В АРХИВ, техкарты остаются, но теряют привязку
   * к группе. Флаг opt-in, потому что UI показывает предупреждение со
   * счётчиками ПЕРЕД вызовом; без флага непустая группа даёт 409 с
   * объяснением.
   */
  @Delete(':id/permanent')
  remove(
    @Param('id') id: string,
    @CurrentUser() user: AuthPrincipal,
    @Query('cascade') cascade?: string,
  ): Promise<void> {
    return this.service.remove(id, user.employeeId, {
      cascade: cascade === '1' || cascade === 'true',
    });
  }
}
