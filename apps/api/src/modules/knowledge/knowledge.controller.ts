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
  BulkArchiveRequestSchema,
  type BulkArchiveRequestDto,
} from '@sewing/shared/archive';
import {
  CreateKnowledgeArticleSchema,
  ListKnowledgeQuerySchema,
  SearchKnowledgeQuerySchema,
  UpdateKnowledgeArticleSchema,
  type CreateKnowledgeArticleDto,
  type ListKnowledgeQuery,
  type SearchKnowledgeQuery,
  type UpdateKnowledgeArticleDto,
} from '@sewing/shared/knowledge';
import { ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import { CurrentUser, Roles } from '../auth/auth.decorators.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { KnowledgeService } from './knowledge.service.js';

/**
 * Контроллер «База знаний» — справка компании.
 *
 *   GET   /api/knowledge                — список (вкладки: активные / черновики / архив)
 *   GET   /api/knowledge/search?q=…     — поиск по опубликованным
 *   GET   /api/knowledge/:id            — карточка
 *   POST  /api/knowledge                — новая статья (по умолчанию черновик)
 *   PATCH /api/knowledge/:id            — правка
 *   POST  /api/knowledge/:id/review     — «Актуально», подтверждение в один клик
 *   POST  /api/knowledge/archive|restore|purge — массовые операции архива
 *
 * RBAC — `SHOP_MANAGER`/`ADMIN`: на этом этапе базой знаний ВЕДАЮТ из
 * админки, и других поверхностей ещё нет.
 *
 * ВАЖНО, что будет дальше: читалка сотрудника (`/work` → «Справка»)
 * потребует ОТДЕЛЬНОЙ ручки чтения, открытой всем аутентифицированным,
 * с фильтром по `roles`/`area` статьи. Расширять этот контроллер
 * ролями нельзя — вместе с чтением уехали бы и правки.
 */
@Roles('SHOP_MANAGER', 'ADMIN')
@Controller('knowledge')
export class KnowledgeController {
  constructor(private readonly knowledge: KnowledgeService) {}

  @Get()
  list(
    @Query(new ZodValidationPipe(ListKnowledgeQuerySchema))
    query: ListKnowledgeQuery,
  ) {
    return this.knowledge.list(query);
  }

  /**
   * Поиск. Объявлен ДО `:id` — иначе Nest примет `search` за
   * идентификатор статьи и вернёт 404.
   */
  @Get('search')
  search(
    @Query(new ZodValidationPipe(SearchKnowledgeQuerySchema))
    query: SearchKnowledgeQuery,
  ) {
    return this.knowledge.search(query);
  }

  @Post()
  create(
    @Body(new ZodValidationPipe(CreateKnowledgeArticleSchema))
    body: CreateKnowledgeArticleDto,
    @CurrentUser() user: AuthPrincipal,
  ) {
    return this.knowledge.create(body, user.employeeId);
  }

  @Post('archive')
  archive(
    @Body(new ZodValidationPipe(BulkArchiveRequestSchema))
    body: BulkArchiveRequestDto,
    @CurrentUser() user: AuthPrincipal,
  ) {
    return this.knowledge.archive(body.ids, user.employeeId);
  }

  @Post('restore')
  restore(
    @Body(new ZodValidationPipe(BulkArchiveRequestSchema))
    body: BulkArchiveRequestDto,
    @CurrentUser() user: AuthPrincipal,
  ) {
    return this.knowledge.restore(body.ids, user.employeeId);
  }

  @Post('purge')
  purge(
    @Body(new ZodValidationPipe(BulkArchiveRequestSchema))
    body: BulkArchiveRequestDto,
    @CurrentUser() user: AuthPrincipal,
  ) {
    return this.knowledge.purge(body.ids, user.employeeId);
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.knowledge.get(id);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(UpdateKnowledgeArticleSchema))
    body: UpdateKnowledgeArticleDto,
    @CurrentUser() user: AuthPrincipal,
  ) {
    return this.knowledge.update(id, body, user.employeeId);
  }

  @Post(':id/review')
  confirmReview(@Param('id') id: string, @CurrentUser() user: AuthPrincipal) {
    return this.knowledge.confirmReview(id, user.employeeId);
  }
}
