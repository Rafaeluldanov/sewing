import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  HELP_LEADER_RATIO,
  KNOWLEDGE_DEFAULT_REVIEW_MONTHS,
  knowledgeSlugFromTitle,
  type CreateKnowledgeArticleDto,
  type HelpArticleDto,
  type HelpArticleListItemDto,
  type HelpSearchQuery,
  type HelpSearchResultDto,
  type KnowledgeArticleDto,
  type KnowledgeFeedbackDto,
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
import type { AuthPrincipal } from '../auth/auth.types.js';
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
    const rows = await this.searchRows(query.q, query.limit ?? 5);
    return rows.map((r) => ({
      id: r.id,
      slug: r.slug,
      title: r.title,
      area: r.area,
      snippet: r.snippet,
      rank: r.rank,
    }));
  }

  /**
   * Внутренняя выдача поиска: то же, что `search()`, плюс роли и
   * ключевые слова — их нужно знать, чтобы отфильтровать по видимости
   * и собрать строку списка, не ходя в базу второй раз.
   */
  private async searchRows(q: string, limit: number): Promise<SearchRow[]> {
    const cfg = KnowledgeService.FTS_CONFIG;

    const hits = await this.prisma.$queryRaw<
      Array<{
        id: string;
        slug: string;
        title: string;
        area: string;
        roles: string[];
        keywords: string[];
        snippet: string;
        rank: number;
      }>
    >`
      SELECT a."id", a."slug", a."title", a."area"::text AS "area",
             a."roles", a."keywords",
             ts_headline(
               ${cfg}::regconfig,
               a."body",
               plainto_tsquery(${cfg}::regconfig, ${q}),
               'MaxWords=24, MinWords=8, ShortWord=3, MaxFragments=1, FragmentDelimiter=" … "'
             ) AS "snippet",
             ts_rank(
               setweight(to_tsvector(${cfg}::regconfig, a."title"), 'A') ||
               setweight(to_tsvector(${cfg}::regconfig, array_to_string(a."keywords", ' ')), 'B') ||
               setweight(to_tsvector(${cfg}::regconfig, a."body"), 'C'),
               plainto_tsquery(${cfg}::regconfig, ${q})
             )::float8 AS "rank"
        FROM "KnowledgeArticle" a
       WHERE a."status" = 'PUBLISHED'::"KnowledgeStatus"
         AND (
               setweight(to_tsvector(${cfg}::regconfig, a."title"), 'A') ||
               setweight(to_tsvector(${cfg}::regconfig, array_to_string(a."keywords", ' ')), 'B') ||
               setweight(to_tsvector(${cfg}::regconfig, a."body"), 'C')
             ) @@ plainto_tsquery(${cfg}::regconfig, ${q})
       ORDER BY "rank" DESC, a."updatedAt" DESC
       LIMIT ${limit}
    `;

    if (hits.length > 0) {
      return hits.map((h) => ({
        ...h,
        area: h.area as SearchRow['area'],
      }));
    }

    const fallback = await this.prisma.knowledgeArticle.findMany({
      where: {
        status: 'PUBLISHED',
        OR: [
          { title: { contains: q, mode: 'insensitive' } },
          { keywords: { has: q.toLowerCase() } },
          { body: { contains: q, mode: 'insensitive' } },
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
      roles: a.roles,
      keywords: a.keywords,
      snippet: snippetAround(a.body, q),
      // Ноль, а не выдуманное число: подстроковое совпадение не
      // ранжировано, и «явным лидером» его считать нельзя.
      rank: 0,
    }));
  }

  // ===========================================================================
  // ЧИТАЛКА СОТРУДНИКА
  // ===========================================================================

  /**
   * Что показать в окне «Справка»: топ статей или результат поиска.
   *
   * Пустой запрос — не пустой экран: показываем то, что читают чаще
   * всего, и статьи участка. Человек у машины второй раз формулировать
   * не станет, и первое, что он видит, должно быть уже полезным.
   */
  async help(
    query: HelpSearchQuery,
    user: AuthPrincipal,
  ): Promise<HelpSearchResultDto> {
    if (!query.q) {
      const top = await this.prisma.knowledgeArticle.findMany({
        where: this.visibleWhere(user),
        orderBy: [{ viewCount: 'desc' }, { updatedAt: 'desc' }],
        take: 8,
      });
      return { exact: null, others: top.map(toListItem) };
    }

    // Берём с запасом и режем видимостью в TS, а не в SQL: правило
    // видимости одно на все поверхности, и дублировать его во втором
    // языке — верный способ однажды разойтись.
    const hits = await this.searchRows(query.q, 20);
    const visible = hits.filter((h) => this.canSee(h.roles, h.area, user));
    if (visible.length === 0) return { exact: null, others: [] };

    const [leader, second] = visible;
    const isLeader =
      leader.rank > 0 &&
      (second === undefined || leader.rank >= second.rank * HELP_LEADER_RATIO);

    if (!isLeader) {
      return {
        exact: null,
        others: visible.slice(0, 5).map((h) => ({
          slug: h.slug,
          title: h.title,
          area: h.area,
          keywords: h.keywords,
          snippet: h.snippet,
        })),
      };
    }

    // Явный лидер — открываем статью целиком, без промежуточного
    // списка из одной ссылки.
    const exact = await this.readForEmployee(leader.slug, user);
    return {
      exact,
      others: visible.slice(1, 5).map((h) => ({
        slug: h.slug,
        title: h.title,
        area: h.area,
        keywords: h.keywords,
        snippet: h.snippet,
      })),
    };
  }

  /**
   * Статья для сотрудника. Считает показ.
   *
   * Инкремент делается здесь, а не на фронте: показ — это факт выдачи
   * текста сервером, и считать его должен тот, кто текст отдал.
   * Ошибка счётчика не должна ронять чтение, поэтому апдейт идёт
   * fail-soft.
   */
  async readForEmployee(
    slug: string,
    user: AuthPrincipal,
  ): Promise<HelpArticleDto> {
    const row = await this.prisma.knowledgeArticle.findUnique({
      where: { slug },
    });
    // Невидимая статья и несуществующая — для сотрудника одно и то же:
    // разное поведение подсказало бы, что «что-то про зарплату здесь
    // есть, просто вам нельзя».
    if (!row || row.status !== 'PUBLISHED') {
      throw new KnowledgeArticleNotFoundException();
    }
    if (!this.canSee(row.roles, row.area, user)) {
      throw new KnowledgeArticleNotFoundException();
    }

    try {
      await this.prisma.knowledgeArticle.update({
        where: { id: row.id },
        data: { viewCount: { increment: 1 } },
      });
    } catch (e) {
      this.logger.warn(
        `event=knowledge.view.count_failed slug=${slug} err=${String(e)}`,
      );
    }

    const author = row.authorId
      ? await this.prisma.employee.findUnique({
          where: { id: row.authorId },
          select: { fullName: true },
        })
      : null;

    return {
      slug: row.slug,
      title: row.title,
      body: row.body,
      area: row.area,
      reviewedAt: row.reviewedAt ? row.reviewedAt.toISOString() : null,
      authorName: author?.fullName ?? null,
    };
  }

  /**
   * 👍 / 👎 / «это не то».
   *
   * Запрос, по которому статью нашли, сохраняется вместе с отзывом:
   * пара «искали X → сказали „это не то"» — самая полезная подсказка
   * автору, потому что показывает не «статья плохая», а каким словом
   * её не нашли.
   */
  async submitFeedback(
    slug: string,
    dto: KnowledgeFeedbackDto,
    user: AuthPrincipal,
  ): Promise<{ ok: true }> {
    const row = await this.prisma.knowledgeArticle.findUnique({
      where: { slug },
      select: { id: true, roles: true, area: true, status: true },
    });
    if (!row || row.status !== 'PUBLISHED') {
      throw new KnowledgeArticleNotFoundException();
    }
    if (!this.canSee(row.roles, row.area, user)) {
      throw new KnowledgeArticleNotFoundException();
    }

    await this.prisma.knowledgeFeedback.create({
      data: {
        articleId: row.id,
        employeeId: user.employeeId,
        kind: dto.kind,
        query: dto.query ?? null,
      },
    });
    this.logger.log(
      `event=knowledge.feedback slug=${slug} kind=${dto.kind} q="${dto.query ?? ''}"`,
    );
    return { ok: true };
  }

  // ---------------------------------------------------------------------------
  // Видимость
  // ---------------------------------------------------------------------------

  /**
   * Правило одно на все поверхности читалки.
   *
   *   1. Статья должна быть опубликована.
   *   2. Роли статьи пусты — видна всем; заданы — нужна хотя бы одна
   *      совпадающая с ролями сотрудника.
   *   3. ИСКЛЮЧЕНИЕ для «Денег» и «Зарплаты»: статья без явно
   *      выставленных ролей в этих областях видна только
   *      управленческому слою. Автор, забывший отметить роли, не должен
   *      случайно открыть цеху расчёт маржи — а забыть галочку легко.
   */
  private canSee(
    articleRoles: string[],
    area: string,
    user: AuthPrincipal,
  ): boolean {
    const mine = user.roles ?? [user.role];
    if (articleRoles.length > 0) {
      return articleRoles.some((r) => mine.includes(r));
    }
    if (area === 'MONEY' || area === 'PAYROLL') {
      return mine.includes('ADMIN') || mine.includes('SHOP_MANAGER');
    }
    return true;
  }

  /** Тот же фильтр в терминах Prisma — для выборок без сырого SQL. */
  private visibleWhere(user: AuthPrincipal): Prisma.KnowledgeArticleWhereInput {
    const mine = user.roles ?? [user.role];
    const manager = mine.includes('ADMIN') || mine.includes('SHOP_MANAGER');
    return {
      status: 'PUBLISHED',
      OR: [
        {
          roles: { isEmpty: true },
          ...(manager
            ? {}
            : { area: { notIn: ['MONEY', 'PAYROLL'] as const } }),
        },
        { roles: { hasSome: mine } },
      ],
    };
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

/** Строка выдачи поиска с полями, нужными для фильтра видимости. */
interface SearchRow {
  id: string;
  slug: string;
  title: string;
  area: KnowledgeSearchHitDto['area'];
  roles: string[];
  keywords: string[];
  snippet: string;
  rank: number;
}

/** Строка списка читалки из строки таблицы. */
function toListItem(a: {
  slug: string;
  title: string;
  area: KnowledgeSearchHitDto['area'];
  keywords: string[];
  body: string;
}): HelpArticleListItemDto {
  return {
    slug: a.slug,
    title: a.title,
    area: a.area,
    keywords: a.keywords,
    snippet: a.body.slice(0, 140).trim(),
  };
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
