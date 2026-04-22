import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  CreateTechCardSchema,
  ListTechCardsQuerySchema,
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
}
