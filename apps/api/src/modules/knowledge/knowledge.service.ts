import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  KNOWLEDGE_DEFAULT_REVIEW_MONTHS,
  knowledgeSlugFromTitle,
  type CreateKnowledgeArticleDto,
  type KnowledgeArticleDto,
  type KnowledgeSearchHitDto,
  type ListKnowledgeQuery,
  type SearchKnowledgeQuery,
  type UpdateKnowledgeArticleDto,
} from '@sewing/shared/knowledge';
import type {
  BulkArchiveResultDto,
  BulkArchiveSkipDto,
} from '@sewing/shared/archive';
import { KnowledgeArticleNotFoundException } from '../../common/errors.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';

/**
 * Сервис «База знаний» — статьи компании, слой «как принято у нас».
 *
 * Три вещи, ради которых он существует отдельно от контроллера:
 *
 *   1. ПОИСК. Postgres FTS с русским словарём выражается только сырым
 *      SQL: Prisma `fullTextSearch` умеет `to_tsquery` без указания
 *      конфигурации, то есть по-английски, и «рулоны» не находит по
 *      «рулон». Отсюда `$queryRaw` в `search()`.
 *   2. SLUG. Адрес статьи собирается из заголовка и должен быть
 *      уникальным — коллизии разруливаются здесь суффиксом, а не
 *      500-й ошибкой уникального индекса в лицо мастеру.
 *   3. ИМЕНА АВТОРОВ. FK на `Employee` сознательно нет (удаление
 *      сотрудника не должно ронять справку), поэтому имена
 *      подтягиваются отдельным запросом по списку id.
 *
 * Признак «пора перечитать» здесь НЕ хранится и не считается: он
 * выводится из `reviewedAt`/`reviewEveryMonths` на клиенте
 * (`isKnowledgeReviewOverdue`). Производное поле в БД — это второй
 * источник правды, который однажды разойдётся с первым.
 */
@Injectable()
export class KnowledgeService {
  private readonly logger = new Logger(KnowledgeService.name);

  /**
   * Конфигурация текстового поиска Postgres. Именно `russian`, а не
   * `simple`: без словаря «рулоны» и «рулон» — разные лексемы, и поиск
   * промахивается ровно там, где сотрудник пишет живым языком.
   */
  private static readonly FTS_CONFIG = 'russian';

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // ===========================================================================
  // READ
  // ===========================================================================

  async list(query: ListKnowledgeQuery): Promise<KnowledgeArticleDto[]> {
    const tab = query.tab ?? 'active';
    const where: Prisma.KnowledgeArticleWhereInput = {
      status:
        tab === 'archive'
          ? 'ARCHIVED'
          : tab === 'drafts'
            ? 'DRAFT'
            : 'PUBLISHED',
    };
    if (query.area) where.area = query.area;
    if (query.search) {
      // Список админки ищет подстрокой, а не FTS: мастер здесь ищет
      // статью, которую сам написал и помнит по названию, а не
      // формулирует вопрос. FTS — в `search()`, для сотрудников.
      const contains = { contains: query.search, mode: 'insensitive' } as const;
      where.OR = [
        { title: contains },
        { body: contains },
        { keywords: { has: query.search.toLowerCase() } },
      ];
    }

    const rows = await this.prisma.knowledgeArticle.findMany({
      where,
      orderBy: [{ updatedAt: 'desc' }],
    });
    return this.withAuthorNames(rows);
  }

  async get(id: string): Promise<KnowledgeArticleDto> {
    const row = await this.prisma.knowledgeArticle.findUnique({
      where: { id },
    });
    if (!row) throw new KnowledgeArticleNotFoundException();
    const [dto] = await this.withAuthorNames([row]);
    return dto;
  }

  async getBySlug(slug: string): Promise<KnowledgeArticleDto> {
    const row = await this.prisma.knowledgeArticle.findUnique({
      where: { slug },
    });
    if (!row) throw new KnowledgeArticleNotFoundException();
    const [dto] = await this.withAuthorNames([row]);
    return dto;
  }

  // ===========================================================================
  // ПОИСК
  // ===========================================================================

  /**
   * Поиск по опубликованным статьям.
   *
   * Две ступени, и вторая не косметическая: `plainto_tsquery` отдаёт
   * пусто на запросе из одних стоп-слов («а что если»), на латинице в
   * русском словаре и на слове с опечаткой. Тогда лучше показать
   * подстроковое совпадение, чем пустой экран — сотрудник у машины
   * второй раз переформулировать не станет.
   *
   * `rank` возвращается наружу: по нему роутер отличает явного лидера
   * (можно показать статью сразу) от кучки одинаково слабых кандидатов
   * (нужен уровень выше).
   */
  async search(query: SearchKnowledgeQuery): Promise<KnowledgeSearchHitDto[]> {
    const limit = query.limit ?? 5;
    const cfg = KnowledgeService.FTS_CONFIG;

    const hits = await this.prisma.$queryRaw<
      Array<{
        id: string;
        slug: string;
        title: string;
        area: string;
        snippet: string;
        rank: number;
      }>
    >`
      SELECT a."id", a."slug", a."title", a."area"::text AS "area",
             ts_headline(
               ${cfg}::regconfig,
               a."body",
               plainto_tsquery(${cfg}::regconfig, ${query.q}),
               'MaxWords=24, MinWords=8, ShortWord=3, MaxFragments=1, FragmentDelimiter=" … "'
             ) AS "snippet",
             ts_rank(
               setweight(to_tsvector(${cfg}::regconfig, a."title"), 'A') ||
               setweight(to_tsvector(${cfg}::regconfig, array_to_string(a."keywords", ' ')), 'B') ||
               setweight(to_tsvector(${cfg}::regconfig, a."body"), 'C'),
               plainto_tsquery(${cfg}::regconfig, ${query.q})
             )::float8 AS "rank"
        FROM "KnowledgeArticle" a
       WHERE a."status" = 'PUBLISHED'::"KnowledgeStatus"
         AND (
               setweight(to_tsvector(${cfg}::regconfig, a."title"), 'A') ||
               setweight(to_tsvector(${cfg}::regconfig, array_to_string(a."keywords", ' ')), 'B') ||
               setweight(to_tsvector(${cfg}::regconfig, a."body"), 'C')
             ) @@ plainto_tsquery(${cfg}::regconfig, ${query.q})
       ORDER BY "rank" DESC, a."updatedAt" DESC
       LIMIT ${limit}
    `;

    if (hits.length > 0) {
      return hits.map((h) => ({
        id: h.id,
        slug: h.slug,
        title: h.title,
        area: h.area as KnowledgeSearchHitDto['area'],
        snippet: h.snippet,
        rank: h.rank,
      }));
    }

    const fallback = await this.prisma.knowledgeArticle.findMany({
      where: {
        status: 'PUBLISHED',
        OR: [
          { title: { contains: query.q, mode: 'insensitive' } },
          { keywords: { has: query.q.toLowerCase() } },
          { body: { contains: query.q, mode: 'insensitive' } },
        ],
      },
      orderBy: [{ viewCount: 'desc' }, { updatedAt: 'desc' }],
      take: limit,
    });
    return fallback.map((a) => ({
      id: a.id,
      slug: a.slug,
      title: a.title,
      area: a.area,
      snippet: snippetAround(a.body, query.q),
      // Ноль, а не выдуманное число: подстроковое совпадение не
      // ранжировано, и роутер не должен принимать его за лидера.
      rank: 0,
    }));
  }

  // ===========================================================================
  // CREATE / UPDATE
  // ===========================================================================

  async create(
    dto: CreateKnowledgeArticleDto,
    actorEmployeeId: string,
  ): Promise<KnowledgeArticleDto> {
    const slug = await this.uniqueSlug(knowledgeSlugFromTitle(dto.title));
    const created = await this.prisma.knowledgeArticle.create({
      data: {
        slug,
        title: dto.title,
        body: dto.body,
        keywords: dto.keywords ?? [],
        area: dto.area ?? 'GENERAL',
        roles: dto.roles ?? [],
        status: dto.status ?? 'DRAFT',
        assistantOk: dto.assistantOk ?? true,
        reviewEveryMonths:
          dto.reviewEveryMonths === undefined
            ? KNOWLEDGE_DEFAULT_REVIEW_MONTHS
            : dto.reviewEveryMonths,
        // Публикация — это и есть первая проверка: человек прочитал
        // текст и согласился его показать. Отсчёт срока годности идёт
        // отсюда, иначе свежая статья сразу «просрочена».
        reviewedAt: (dto.status ?? 'DRAFT') === 'PUBLISHED' ? new Date() : null,
        authorId: actorEmployeeId,
      },
    });
    this.logger.log(
      `event=knowledge.create id=${created.id} slug=${created.slug} status=${created.status}`,
    );
    await this.audit.log({
      event: 'KNOWLEDGE_ARTICLE_CREATED',
      entityType: 'KNOWLEDGE_ARTICLE',
      entityId: created.id,
      payload: {
        slug: created.slug,
        title: created.title,
        area: created.area,
        status: created.status,
      },
      employeeId: actorEmployeeId,
    });
    const [result] = await this.withAuthorNames([created]);
    return result;
  }

  async update(
    id: string,
    dto: UpdateKnowledgeArticleDto,
    actorEmployeeId: string,
  ): Promise<KnowledgeArticleDto> {
    const current = await this.prisma.knowledgeArticle.findUnique({
      where: { id },
    });
    if (!current) throw new KnowledgeArticleNotFoundException();

    const data: Prisma.KnowledgeArticleUpdateInput = {
      updatedById: actorEmployeeId,
    };
    if (dto.title !== undefined) data.title = dto.title;
    if (dto.body !== undefined) data.body = dto.body;
    if (dto.keywords !== undefined) data.keywords = dto.keywords;
    if (dto.area !== undefined) data.area = dto.area;
    if (dto.roles !== undefined) data.roles = dto.roles;
    if (dto.assistantOk !== undefined) data.assistantOk = dto.assistantOk;
    if (dto.reviewEveryMonths !== undefined) {
      data.reviewEveryMonths = dto.reviewEveryMonths;
    }
    if (dto.status !== undefined) {
      data.status = dto.status;
      // Первая публикация черновика = первая проверка текста человеком.
      if (dto.status === 'PUBLISHED' && current.status !== 'PUBLISHED') {
        data.reviewedAt = new Date();
      }
    }
    // Slug НЕ пересобираем при смене заголовка: на статью уже могли
    // сослаться из ответа ассистента и из закладки сотрудника, а
    // редирект со старого адреса — это отдельная сущность, которой на
    // этом этапе нет.

    const updated = await this.prisma.knowledgeArticle.update({
      where: { id },
      data,
    });
    this.logger.log(
      `event=knowledge.update id=${updated.id} status=${updated.status}`,
    );
    await this.audit.log({
      event: 'KNOWLEDGE_ARTICLE_UPDATED',
      entityType: 'KNOWLEDGE_ARTICLE',
      entityId: updated.id,
      payload: {
        before: {
          title: current.title,
          status: current.status,
          area: current.area,
        },
        after: {
          title: updated.title,
          status: updated.status,
          area: updated.area,
        },
      },
      employeeId: actorEmployeeId,
    });
    const [result] = await this.withAuthorNames([updated]);
    return result;
  }

  /**
   * «Актуально» — подтверждение без правки текста, в один клик.
   *
   * Отдельная ручка, а не `PATCH { reviewedAt }`: подтверждение должно
   * стоить один клик из списка. Если бы для этого нужно было открыть
   * редактор и сохранить статью, подтверждать перестали бы, а подсветка
   * просроченных превратилась бы в фоновый шум.
   */
  async confirmReview(
    id: string,
    actorEmployeeId: string,
  ): Promise<KnowledgeArticleDto> {
    const current = await this.prisma.knowledgeArticle.findUnique({
      where: { id },
    });
    if (!current) throw new KnowledgeArticleNotFoundException();

    const updated = await this.prisma.knowledgeArticle.update({
      where: { id },
      data: { reviewedAt: new Date(), updatedById: actorEmployeeId },
    });
    await this.audit.log({
      event: 'KNOWLEDGE_ARTICLE_REVIEWED',
      entityType: 'KNOWLEDGE_ARTICLE',
      entityId: updated.id,
      payload: { title: updated.title, reviewedAt: updated.reviewedAt },
      employeeId: actorEmployeeId,
    });
    const [result] = await this.withAuthorNames([updated]);
    return result;
  }

  // ===========================================================================
  // АРХИВ (общий контракт `@sewing/shared/archive`)
  // ===========================================================================

  async archive(
    ids: string[],
    actorEmployeeId: string,
  ): Promise<BulkArchiveResultDto> {
    return this.bulkStatus(ids, 'ARCHIVED', actorEmployeeId);
  }

  async restore(
    ids: string[],
    actorEmployeeId: string,
  ): Promise<BulkArchiveResultDto> {
    // Возвращаем в ЧЕРНОВИКИ, а не сразу в опубликованные: статью
    // отправили в архив, потому что ей не доверяли, и молча показать её
    // сотрудникам обратно — худшее, что можно сделать.
    return this.bulkStatus(ids, 'DRAFT', actorEmployeeId);
  }

  async purge(
    ids: string[],
    actorEmployeeId: string,
  ): Promise<BulkArchiveResultDto> {
    const rows = await this.prisma.knowledgeArticle.findMany({
      where: { id: { in: ids } },
      select: { id: true, status: true, title: true },
    });
    const byId = new Map(rows.map((r) => [r.id, r]));

    const processed: string[] = [];
    const skipped: BulkArchiveSkipDto[] = [];
    for (const id of ids) {
      const row = byId.get(id);
      if (!row) {
        skipped.push({ id, reason: 'NOT_FOUND' });
        continue;
      }
      if (row.status !== 'ARCHIVED') {
        skipped.push({ id, reason: 'NOT_ARCHIVED' });
        continue;
      }
      processed.push(id);
    }

    if (processed.length > 0) {
      await this.prisma.knowledgeArticle.deleteMany({
        where: { id: { in: processed } },
      });
      for (const id of processed) {
        await this.audit.log({
          event: 'KNOWLEDGE_ARTICLE_PURGED',
          entityType: 'KNOWLEDGE_ARTICLE',
          entityId: id,
          payload: { title: byId.get(id)?.title ?? null },
          employeeId: actorEmployeeId,
        });
      }
    }
    this.logger.log(
      `event=knowledge.purge processed=${processed.length} skipped=${skipped.length}`,
    );
    return { processed, skipped };
  }

  private async bulkStatus(
    ids: string[],
    status: 'ARCHIVED' | 'DRAFT',
    actorEmployeeId: string,
  ): Promise<BulkArchiveResultDto> {
    const rows = await this.prisma.knowledgeArticle.findMany({
      where: { id: { in: ids } },
      select: { id: true, status: true, title: true },
    });
    const found = new Set(rows.map((r) => r.id));

    const processed: string[] = [];
    const skipped: BulkArchiveSkipDto[] = [];
    for (const id of ids) {
      if (!found.has(id)) {
        skipped.push({ id, reason: 'NOT_FOUND' });
        continue;
      }
      // Повторная архивация уже архивной статьи — успех, а не ошибка:
      // контракт массовых операций идемпотентный.
      processed.push(id);
    }

    if (processed.length > 0) {
      await this.prisma.knowledgeArticle.updateMany({
        where: { id: { in: processed } },
        data: { status, updatedById: actorEmployeeId },
      });
      for (const id of processed) {
        await this.audit.log({
          event:
            status === 'ARCHIVED'
              ? 'KNOWLEDGE_ARTICLE_ARCHIVED'
              : 'KNOWLEDGE_ARTICLE_RESTORED',
          entityType: 'KNOWLEDGE_ARTICLE',
          entityId: id,
          payload: { status },
          employeeId: actorEmployeeId,
        });
      }
    }
    this.logger.log(
      `event=knowledge.${status === 'ARCHIVED' ? 'archive' : 'restore'} processed=${processed.length} skipped=${skipped.length}`,
    );
    return { processed, skipped };
  }

  // ===========================================================================
  // helpers
  // ===========================================================================

  /**
   * Уникальный адрес статьи: `base`, `base-2`, `base-3`…
   *
   * Считаем по префиксу одним запросом, а не подбираем в цикле с
   * повторными вставками: статей мало, а гонка двух мастеров, жмущих
   * «Сохранить» одновременно, всё равно упрётся в уникальный индекс —
   * и это правильное место, чтобы упасть.
   */
  private async uniqueSlug(base: string): Promise<string> {
    const taken = await this.prisma.knowledgeArticle.findMany({
      where: { slug: { startsWith: base } },
      select: { slug: true },
    });
    if (taken.length === 0) return base;
    const set = new Set(taken.map((t) => t.slug));
    if (!set.has(base)) return base;
    for (let i = 2; i < 1000; i += 1) {
      const candidate = `${base}-${i}`;
      if (!set.has(candidate)) return candidate;
    }
    return `${base}-${Date.now()}`;
  }

  /** Дотягивает имена автора и последнего правщика по списку id. */
  private async withAuthorNames(
    rows: Prisma.KnowledgeArticleGetPayload<Record<string, never>>[],
  ): Promise<KnowledgeArticleDto[]> {
    const ids = new Set<string>();
    for (const r of rows) {
      ids.add(r.authorId);
      if (r.updatedById) ids.add(r.updatedById);
    }
    const names = new Map<string, string>();
    if (ids.size > 0) {
      const employees = await this.prisma.employee.findMany({
        where: { id: { in: Array.from(ids) } },
        select: { id: true, fullName: true },
      });
      for (const e of employees) names.set(e.id, e.fullName);
    }
    return rows.map((r) => ({
      id: r.id,
      slug: r.slug,
      title: r.title,
      body: r.body,
      keywords: r.keywords,
      area: r.area,
      roles: r.roles,
      status: r.status,
      assistantOk: r.assistantOk,
      reviewEveryMonths: r.reviewEveryMonths,
      reviewedAt: r.reviewedAt ? r.reviewedAt.toISOString() : null,
      authorId: r.authorId,
      authorName: names.get(r.authorId) ?? null,
      updatedByName: r.updatedById ? (names.get(r.updatedById) ?? null) : null,
      viewCount: r.viewCount,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    }));
  }
}

/**
 * Фрагмент вокруг совпадения для подстрокового fallback-а. `ts_headline`
 * здесь не применить: он работает от `tsquery`, а мы сюда попали именно
 * потому, что запрос в `tsquery` не превратился.
 */
function snippetAround(body: string, needle: string, width = 120): string {
  const at = body.toLowerCase().indexOf(needle.toLowerCase());
  if (at < 0) return body.slice(0, width).trim();
  const from = Math.max(0, at - Math.floor(width / 3));
  const to = Math.min(body.length, from + width);
  return `${from > 0 ? '… ' : ''}${body.slice(from, to).trim()}${to < body.length ? ' …' : ''}`;
}
