import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import {
  HelpSearchQuerySchema,
  KnowledgeFeedbackSchema,
  type HelpSearchQuery,
  type KnowledgeFeedbackDto,
} from '@sewing/shared/knowledge';
import { ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import { CurrentUser } from '../auth/auth.decorators.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { KnowledgeService } from './knowledge.service.js';

/**
 * Читалка справки для сотрудника.
 *
 *   GET  /api/help?q=…              — топ статей или результат поиска
 *   GET  /api/help/:slug            — статья (считает показ)
 *   POST /api/help/:slug/feedback   — 👍 / 👎 / «это не то»
 *
 * `@Roles(...)` сознательно НЕ навешан: справка доступна любому
 * аутентифицированному сотруднику — швее, раскройщику, ОТК. В этом
 * половина смысла фичи: у цеха те же вопросы, что у мастера, а админки
 * у них нет.
 *
 * Отдельный контроллер, а не роли на `KnowledgeController`: там вместе
 * с чтением уехали бы создание, правка и архив. Здесь ручки только
 * читают, а видимость статьи режется по ролям сотрудника внутри
 * сервиса (`visibleToEmployee`).
 */
@Controller('help')
export class HelpController {
  constructor(private readonly knowledge: KnowledgeService) {}

  @Get()
  search(
    @Query(new ZodValidationPipe(HelpSearchQuerySchema)) query: HelpSearchQuery,
    @CurrentUser() user: AuthPrincipal,
  ) {
    return this.knowledge.help(query, user);
  }

  /**
   * Статья по человекочитаемому адресу, а не по id: ссылку на неё
   * сотрудник получает из ответа ассистента и кладёт в закладки.
   */
  @Get(':slug')
  read(@Param('slug') slug: string, @CurrentUser() user: AuthPrincipal) {
    return this.knowledge.readForEmployee(slug, user);
  }

  @Post(':slug/feedback')
  feedback(
    @Param('slug') slug: string,
    @Body(new ZodValidationPipe(KnowledgeFeedbackSchema))
    body: KnowledgeFeedbackDto,
    @CurrentUser() user: AuthPrincipal,
  ) {
    return this.knowledge.submitFeedback(slug, body, user);
  }
}
