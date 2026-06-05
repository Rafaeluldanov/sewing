import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import {
  CreateTechCardSchema,
  ListTechCardsQuerySchema,
  TECH_CARD_LINE_IMAGE_MAX_SIZE_BYTES,
  UpdateTechCardSchema,
  type CreateTechCardDto,
  type ListTechCardsQuery,
  type TechCardTemplateDetailDto,
  type TechCardTemplateSummaryDto,
  type UpdateTechCardDto,
} from '@sewing/shared/tech-cards';

import { ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import { Roles } from '../auth/auth.decorators.js';
import { TechCardsService } from './tech-cards.service.js';
import type { UploadedFileLike } from '../patterns/patterns-storage.service.js';

/**
 * `/api/tech-cards` — управление шаблонами техкарт (см.
 * `docs/api.md §«tech-cards»`, ADR-0022).
 *
 * RBAC по аналогии с `/api/routes`:
 *   - GET (list/detail) — все авторизованные; `/orders/new` подгружает
 *     активные техкарты для селекта;
 *   - POST/PATCH — `ADMIN`, `SHOP_MANAGER`. На MVP DELETE намеренно
 *     не выставляем: техкарта может быть зашита в snapshot заказов, и
 *     soft-deactivation (isActive=false) закрывает все use-кейсы UI.
 */
@Controller('tech-cards')
export class TechCardsController {
  constructor(private readonly techCards: TechCardsService) {}

  @Get()
  list(
    @Query(new ZodValidationPipe(ListTechCardsQuerySchema))
    query: ListTechCardsQuery,
  ): Promise<TechCardTemplateSummaryDto[]> {
    return this.techCards.list(query);
  }

  @Get(':id')
  getOne(@Param('id') id: string): Promise<TechCardTemplateDetailDto> {
    return this.techCards.getOne(id);
  }

  @Post()
  @Roles('ADMIN', 'SHOP_MANAGER')
  create(
    @Body(new ZodValidationPipe(CreateTechCardSchema))
    dto: CreateTechCardDto,
  ): Promise<TechCardTemplateDetailDto> {
    return this.techCards.create(dto);
  }

  @Patch(':id')
  @Roles('ADMIN', 'SHOP_MANAGER')
  update(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(UpdateTechCardSchema))
    dto: UpdateTechCardDto,
  ): Promise<TechCardTemplateDetailDto> {
    return this.techCards.update(id, dto);
  }

  /**
   * Hard-delete архивной (неактивной) техкарты — этап «Удалить архивную
   * запись навсегда». Soft-deactivation (`isActive=false`) остаётся
   * основным сценарием; permanent-удаление сервис разрешает только если
   * карта неактивна и нигде не используется
   * (`TECH_CARD_DELETE_FORBIDDEN`).
   */
  @Delete(':id/permanent')
  @Roles('ADMIN', 'SHOP_MANAGER')
  remove(@Param('id') id: string): Promise<void> {
    return this.techCards.remove(id);
  }

  /**
   * Загрузка изображения JPG/JPEG/PNG для конкретной строки материала
   * техкарты (см. ТЗ §5, §9). Запрос: multipart/form-data, поле `file`.
   *
   * Backend сам валидирует расширение и размер
   * (`TechCardsStorageService`), здесь — только multer-лимит размера
   * как защита первой линии (multer бросит 413 ещё до сервиса, чтобы
   * не тянуть в память файл больше лимита).
   *
   * Доступно только для уже сохранённой строки — нового несохранённого
   * lineId здесь быть не может (URL содержит lineId, который backend
   * отдал при предыдущем GET/save). UI на свежей строке без id рисует
   * подсказку «Сохраните техкарту, чтобы загрузить изображение».
   */
  @Post(':id/material-lines/:lineId/image')
  @Roles('ADMIN', 'SHOP_MANAGER')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: TECH_CARD_LINE_IMAGE_MAX_SIZE_BYTES },
    }),
  )
  uploadMaterialLineImage(
    @Param('id') id: string,
    @Param('lineId') lineId: string,
    @UploadedFile() file: UploadedFileLike | undefined,
  ): Promise<TechCardTemplateDetailDto> {
    return this.techCards.uploadMaterialImage(id, lineId, file);
  }
}
