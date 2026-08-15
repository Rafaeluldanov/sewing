/**
 * Контракты «Базы знаний» — редактируемой справки компании.
 *
 * Зачем отдельная сущность рядом с ассистентом: знание в системе живёт
 * ДВУМЯ слоями, и у них разный жизненный цикл.
 *
 *   1. «Как устроен продукт» — статусы заказа, паспорт, роли, московские
 *      сутки. Едет В КОДЕ (`apps/api/src/modules/assistant/knowledge.ts`),
 *      правится в PR вместе с фичей, одинаково у всех тенантов.
 *   2. «Как принято у нас» — регламенты цеха, кто за что отвечает, частые
 *      вопросы швей. Это ЗДЕСЬ: таблица `KnowledgeArticle` в тенантной БД,
 *      правит мастер из админки, у каждой компании своя.
 *
 * Слои сознательно не смешаны: у нас DB-per-tenant, и статья «паспорт =
 * расклад × размер × рулон» не должна лежать в двадцати копиях и
 * расходиться с релизом, а «брак несём Ирине» не место в коде.
 *
 * Поиск при этом ОДИН на оба слоя — см. `KnowledgeService.search` и
 * (позже) `assistant/knowledge.ts::searchKnowledge`.
 *
 * Backend-валидация и веб-формы используют эти Zod-схемы как источник
 * истины (`apps/api/src/modules/knowledge/*`,
 * `apps/web/lib/knowledge-api.ts`, `apps/web/app/admin/knowledge/*`).
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Область знания
// ---------------------------------------------------------------------------

/**
 * Область статьи. Те же четыре группы данных, что у ассистента
 * (`IntegrationSettings.assistantScope*`), плюс `GENERAL` для того, что
 * не относится ни к одной: график смен, кому звонить, техника
 * безопасности.
 *
 * Область — это не рубрикатор «для красоты», а ЕДИНИЦА ДОСТУПА: закрытая
 * у тенанта область прячет статью и от читалки, и от ассистента разом.
 */
export const KNOWLEDGE_AREAS = [
  'PRODUCTION',
  'SUPPLY',
  'MONEY',
  'PAYROLL',
  'GENERAL',
] as const;
export type KnowledgeArea = (typeof KNOWLEDGE_AREAS)[number];

export const KNOWLEDGE_AREA_LABELS: Record<KnowledgeArea, string> = {
  PRODUCTION: 'Производство',
  SUPPLY: 'Снабжение',
  MONEY: 'Деньги',
  PAYROLL: 'Зарплата',
  GENERAL: 'Общее',
};

// ---------------------------------------------------------------------------
// Статус
// ---------------------------------------------------------------------------

/**
 * Жизненный цикл статьи. Черновик виден только в админке; опубликованную
 * видят сотрудники и цитирует ассистент; архивная не видна никому, но
 * сохраняется — устаревшую статью лучше убрать, чем оставить неверной.
 */
export const KNOWLEDGE_STATUSES = ['DRAFT', 'PUBLISHED', 'ARCHIVED'] as const;
export type KnowledgeStatus = (typeof KNOWLEDGE_STATUSES)[number];

export const KNOWLEDGE_STATUS_LABELS: Record<KnowledgeStatus, string> = {
  DRAFT: 'Черновик',
  PUBLISHED: 'Опубликована',
  ARCHIVED: 'В архиве',
};

// ---------------------------------------------------------------------------
// Ограничения полей
// ---------------------------------------------------------------------------

export const KNOWLEDGE_TITLE_MAX_LENGTH = 200;
export const KNOWLEDGE_BODY_MAX_LENGTH = 20_000;
export const KNOWLEDGE_SLUG_MAX_LENGTH = 120;
export const KNOWLEDGE_KEYWORD_MAX_LENGTH = 60;
export const KNOWLEDGE_KEYWORDS_MAX_COUNT = 30;

/**
 * Срок перепроверки по умолчанию. Полгода — компромисс: реже, чем
 * меняются регламенты цеха, но достаточно часто, чтобы протухшая статья
 * не жила годами. `null` = статья бессрочная (например, техника
 * безопасности, переписанная только приказом).
 */
export const KNOWLEDGE_DEFAULT_REVIEW_MONTHS = 6;

const TitleField = z
  .string()
  .trim()
  .min(1, 'Заголовок обязателен')
  .max(
    KNOWLEDGE_TITLE_MAX_LENGTH,
    `Заголовок не длиннее ${KNOWLEDGE_TITLE_MAX_LENGTH} символов`,
  );

const BodyField = z
  .string()
  .trim()
  .min(1, 'Текст статьи обязателен')
  .max(
    KNOWLEDGE_BODY_MAX_LENGTH,
    `Текст не длиннее ${KNOWLEDGE_BODY_MAX_LENGTH} символов`,
  );

/**
 * Ключевые слова — синонимы и жаргон, которых нет в тексте («ткань
 * пришла», «поехал шов»). Основной поиск и так идёт по заголовку и телу;
 * это поле нужно ровно для того, чем цех называет вещи по-своему.
 *
 * Нормализуем к нижнему регистру и убираем дубли — иначе «Брак» и «брак»
 * в одной статье дадут двойной вес одному и тому же слову.
 */
const KeywordsField = z.preprocess(
  (v) => {
    if (v === undefined || v === null) return undefined;
    const raw = Array.isArray(v) ? v : [v];
    const cleaned = raw
      .map((k) => (typeof k === 'string' ? k.trim().toLowerCase() : ''))
      .filter((k) => k.length > 0);
    return Array.from(new Set(cleaned));
  },
  z
    .array(
      z
        .string()
        .max(
          KNOWLEDGE_KEYWORD_MAX_LENGTH,
          `Ключевое слово не длиннее ${KNOWLEDGE_KEYWORD_MAX_LENGTH} символов`,
        ),
    )
    .max(
      KNOWLEDGE_KEYWORDS_MAX_COUNT,
      `Не больше ${KNOWLEDGE_KEYWORDS_MAX_COUNT} ключевых слов`,
    )
    .optional(),
);

/**
 * Коды ролей, которым статья видна. ПУСТОЙ массив = видна всем, у кого
 * открыта область статьи. Коды — те же, что в `Employee.roles` и
 * `AppRole.code`, поэтому список ролей тенанта здесь не фиксируем.
 */
const RolesField = z.preprocess(
  (v) => {
    if (v === undefined || v === null) return undefined;
    const raw = Array.isArray(v) ? v : [v];
    const cleaned = raw
      .map((r) => (typeof r === 'string' ? r.trim().toUpperCase() : ''))
      .filter((r) => r.length > 0);
    return Array.from(new Set(cleaned));
  },
  z.array(z.string().max(64)).max(50).optional(),
);

/**
 * Срок перепроверки в месяцах. 0 и пустая строка означают «бессрочно» и
 * приезжают из формы как `null` — селекту проще отдать пустое значение,
 * чем отсутствующее поле.
 */
const ReviewEveryMonthsField = z.preprocess((v) => {
  if (v === undefined) return undefined;
  if (v === null || v === '' || v === 0 || v === '0') return null;
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : v;
  }
  return v;
}, z.number().int('Срок задаётся целым числом месяцев').min(1, 'Срок не меньше месяца').max(60, 'Срок не больше 60 месяцев').nullable().optional());

// ---------------------------------------------------------------------------
// Slug
// ---------------------------------------------------------------------------

const TRANSLIT: Record<string, string> = {
  а: 'a',
  б: 'b',
  в: 'v',
  г: 'g',
  д: 'd',
  е: 'e',
  ё: 'e',
  ж: 'zh',
  з: 'z',
  и: 'i',
  й: 'i',
  к: 'k',
  л: 'l',
  м: 'm',
  н: 'n',
  о: 'o',
  п: 'p',
  р: 'r',
  с: 's',
  т: 't',
  у: 'u',
  ф: 'f',
  х: 'h',
  ц: 'c',
  ч: 'ch',
  ш: 'sh',
  щ: 'sch',
  ъ: '',
  ы: 'y',
  ь: '',
  э: 'e',
  ю: 'yu',
  я: 'ya',
};

/**
 * Человекочитаемый адрес статьи из заголовка.
 *
 * Транслитерация, а не `encodeURIComponent`: адрес статьи попадает в
 * ссылку из ответа ассистента и в адресную строку сотрудника, и
 * `%D0%BF%D0%B0%D1%81...` там читается как ошибка. Уникальность slug
 * обеспечивает сервис (суффиксом `-2`, `-3`), а не эта функция.
 */
export function knowledgeSlugFromTitle(title: string): string {
  const slug = title
    .toLowerCase()
    .split('')
    .map((ch) => TRANSLIT[ch] ?? ch)
    .join('')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, KNOWLEDGE_SLUG_MAX_LENGTH)
    .replace(/-+$/g, '');
  return slug.length > 0 ? slug : 'article';
}

// ---------------------------------------------------------------------------
// Request DTO
// ---------------------------------------------------------------------------

export const CreateKnowledgeArticleSchema = z.object({
  title: TitleField,
  body: BodyField,
  keywords: KeywordsField,
  area: z.enum(KNOWLEDGE_AREAS).optional(),
  roles: RolesField,
  /**
   * Публиковать сразу или оставить черновиком. Дефолт — черновик:
   * статья, попавшая к сотрудникам без вычитки, дороже лишнего клика.
   */
  status: z.enum(['DRAFT', 'PUBLISHED']).optional(),
  assistantOk: z.boolean().optional(),
  reviewEveryMonths: ReviewEveryMonthsField,
});
export type CreateKnowledgeArticleDto = z.infer<
  typeof CreateKnowledgeArticleSchema
>;

export const UpdateKnowledgeArticleSchema = z
  .object({
    title: TitleField.optional(),
    body: BodyField.optional(),
    keywords: KeywordsField,
    area: z.enum(KNOWLEDGE_AREAS).optional(),
    roles: RolesField,
    status: z.enum(['DRAFT', 'PUBLISHED']).optional(),
    assistantOk: z.boolean().optional(),
    reviewEveryMonths: ReviewEveryMonthsField,
  })
  .refine(
    (obj) => Object.values(obj).some((v) => v !== undefined),
    'Нечего обновлять: укажите хотя бы одно поле',
  );
export type UpdateKnowledgeArticleDto = z.infer<
  typeof UpdateKnowledgeArticleSchema
>;

// ---------------------------------------------------------------------------
// List query
// ---------------------------------------------------------------------------

export const KNOWLEDGE_LIST_TABS = ['active', 'drafts', 'archive'] as const;
export type KnowledgeListTab = (typeof KNOWLEDGE_LIST_TABS)[number];

export const ListKnowledgeQuerySchema = z.object({
  /**
   * `active` — опубликованные, `drafts` — черновики, `archive` — архив.
   * По умолчанию `active`: список открывают, чтобы посмотреть, что видят
   * сотрудники.
   */
  tab: z.enum(KNOWLEDGE_LIST_TABS).optional(),
  search: z.string().trim().max(200).optional(),
  area: z.enum(KNOWLEDGE_AREAS).optional(),
});
export type ListKnowledgeQuery = z.infer<typeof ListKnowledgeQuerySchema>;

export const SearchKnowledgeQuerySchema = z.object({
  q: z.string().trim().min(1, 'Пустой запрос').max(200),
  limit: z.coerce.number().int().min(1).max(20).optional(),
});
export type SearchKnowledgeQuery = z.infer<typeof SearchKnowledgeQuerySchema>;

// ---------------------------------------------------------------------------
// Response DTO
// ---------------------------------------------------------------------------

export interface KnowledgeArticleDto {
  id: string;
  slug: string;
  title: string;
  body: string;
  keywords: string[];
  area: KnowledgeArea;
  roles: string[];
  status: KnowledgeStatus;
  assistantOk: boolean;
  reviewEveryMonths: number | null;
  reviewedAt: string | null; // ISO
  /** Имя автора для карточки; `null`, если сотрудник удалён. */
  authorName: string | null;
  authorId: string | null;
  updatedByName: string | null;
  viewCount: number;
  createdAt: string; // ISO
  updatedAt: string; // ISO
}

/** Строка выдачи поиска — без тела, но с фрагментом вокруг совпадения. */
export interface KnowledgeSearchHitDto {
  id: string;
  slug: string;
  title: string;
  area: KnowledgeArea;
  /** Кусок текста вокруг найденного слова, для превью в списке. */
  snippet: string;
  /** Ранг Postgres FTS. Нужен роутеру, чтобы отличить явного лидера. */
  rank: number;
}

// ---------------------------------------------------------------------------
// Срок годности
// ---------------------------------------------------------------------------

/**
 * Дата, после которой статью пора перечитать: от последней проверки (а
 * если её не было — от создания) плюс `reviewEveryMonths`.
 *
 * Возвращает `null` для бессрочных — у них срока нет вообще, и это не то
 * же самое, что «срок в будущем».
 */
export function knowledgeReviewDueAt(article: {
  reviewEveryMonths: number | null;
  reviewedAt: string | Date | null;
  createdAt: string | Date;
}): Date | null {
  if (article.reviewEveryMonths === null) return null;
  const base = new Date(article.reviewedAt ?? article.createdAt);
  const due = new Date(base);
  due.setMonth(due.getMonth() + article.reviewEveryMonths);
  return due;
}

/**
 * Пора ли перечитать статью.
 *
 * Считается ЗАПРОСОМ, а не хранится флагом: производный признак в
 * колонке — это второй источник правды, который однажды разойдётся с
 * первым (кто-то поменяет `reviewedAt` в обход, и флаг соврёт).
 */
export function isKnowledgeReviewOverdue(
  article: Parameters<typeof knowledgeReviewDueAt>[0],
  now: Date = new Date(),
): boolean {
  const due = knowledgeReviewDueAt(article);
  return due !== null && due.getTime() <= now.getTime();
}
