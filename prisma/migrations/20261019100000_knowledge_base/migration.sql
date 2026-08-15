-- Фича «База знаний» — редактируемая справка компании, этап 1.
--
-- Второй слой знания рядом с системным (`assistant/knowledge.ts`, едет в
-- коде): «как принято у нас». Правит мастер из `/admin/knowledge`.
-- Почему слоя два и что где лежит — `packages/shared/src/knowledge.ts`.
--
-- Миграция НИЧЕГО не включает и ничего не заполняет: таблица приезжает
-- пустой, раздел просто появляется в админке. Первые статьи заводит
-- человек (интервью с мастером / импорт существующих регламентов).
--
-- ПОЧЕМУ ЗДЕСЬ НЕТ tsvector-КОЛОНКИ И GIN-ИНДЕКСА. Поиск на этом этапе
-- идёт через `to_tsvector('russian', …)` в `$queryRaw` без своего
-- индекса: на корпусе в десятки-сотни статей seq scan занимает единицы
-- миллисекунд, а генерируемая колонка и выражённый индекс не выражаются
-- в schema.prisma — `prisma migrate dev` считал бы их дрейфом и однажды
-- молча снёс бы. Индекс заведём отдельной миграцией, когда объём
-- вырастет настолько, что это станет видно в замерах.

-- 1. Справочные типы ---------------------------------------------------------

CREATE TYPE "KnowledgeArea" AS ENUM (
  'PRODUCTION',
  'SUPPLY',
  'MONEY',
  'PAYROLL',
  'GENERAL'
);

CREATE TYPE "KnowledgeStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');

-- 2. Статьи ------------------------------------------------------------------

CREATE TABLE "KnowledgeArticle" (
  "id"                TEXT NOT NULL,
  "slug"              TEXT NOT NULL,
  "title"             TEXT NOT NULL,
  "body"              TEXT NOT NULL,
  "keywords"          TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "area"              "KnowledgeArea"   NOT NULL DEFAULT 'GENERAL',
  "roles"             TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "status"            "KnowledgeStatus" NOT NULL DEFAULT 'DRAFT',
  "assistantOk"       BOOLEAN NOT NULL DEFAULT true,
  "reviewEveryMonths" INTEGER DEFAULT 6,
  "reviewedAt"        TIMESTAMP(3),
  "authorId"          TEXT NOT NULL,
  "updatedById"       TEXT,
  "viewCount"         INTEGER NOT NULL DEFAULT 0,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"         TIMESTAMP(3) NOT NULL,

  CONSTRAINT "KnowledgeArticle_pkey" PRIMARY KEY ("id")
);

-- Адрес статьи уникален: по нему её открывают из ответа ассистента.
CREATE UNIQUE INDEX "KnowledgeArticle_slug_key" ON "KnowledgeArticle"("slug");

-- Основная выборка админки и читалки: «опубликованные в такой-то области».
CREATE INDEX "KnowledgeArticle_status_area_idx"
  ON "KnowledgeArticle"("status", "area");

-- Список статей сортируется по дате правки внутри вкладки.
CREATE INDEX "KnowledgeArticle_status_updatedAt_idx"
  ON "KnowledgeArticle"("status", "updatedAt");

-- «Что написал этот сотрудник» — для карточки автора и разбора полётов.
CREATE INDEX "KnowledgeArticle_authorId_idx"
  ON "KnowledgeArticle"("authorId");

-- Внешних ключей на `Employee` сознательно нет — как у `AssistantThread`:
-- удаление сотрудника не должно ронять справку, а имя автора
-- подтягивается запросом по списку id.
