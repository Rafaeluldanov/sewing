-- Фича «База знаний», этап 1b — читалка сотрудника.
--
-- Раздел админки уже есть (миграция 20261019100000); здесь появляется
-- то, ради чего он заводился: сотрудник открывает справку из своего
-- кабинета, а система начинает получать сигналы о статьях.
--
-- Одна таблица — отзывы. Счётчик показов живёт колонкой на самой
-- статье (`viewCount`), потому что нужен только суммой; отзывы —
-- строками, потому что по ним считают ДОЛЮ («это не то» 7 раз из 24
-- показов) и смотрят, ЧТО искали.

CREATE TYPE "KnowledgeFeedbackKind" AS ENUM (
  'HELPFUL',
  'NOT_HELPFUL',
  -- Отдельный исход, а не разновидность 👎: «это не то» значит, что
  -- поиск привёл не туда, и лечится заголовком и ключевыми словами, а
  -- не переписыванием текста.
  'NOT_WHAT_I_MEANT'
);

CREATE TABLE "KnowledgeFeedback" (
  "id"         TEXT NOT NULL,
  "articleId"  TEXT NOT NULL,
  "employeeId" TEXT NOT NULL,
  "kind"       "KnowledgeFeedbackKind" NOT NULL,
  -- Запрос, по которому статью нашли: по паре «искали X → сказали
  -- „это не то"» видно, какого слова статье не хватает.
  "query"      TEXT,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "KnowledgeFeedback_pkey" PRIMARY KEY ("id")
);

-- Доля «это не то» по статье — основной запрос вкладки «На проверку».
CREATE INDEX "KnowledgeFeedback_articleId_kind_idx"
  ON "KnowledgeFeedback"("articleId", "kind");

-- «Что нажимал этот сотрудник» — защита от накрутки одним человеком.
CREATE INDEX "KnowledgeFeedback_employeeId_createdAt_idx"
  ON "KnowledgeFeedback"("employeeId", "createdAt");

-- Отзыв без статьи бессмыслен: удалили статью навсегда — уносим и
-- сигналы о ней.
ALTER TABLE "KnowledgeFeedback"
  ADD CONSTRAINT "KnowledgeFeedback_articleId_fkey"
  FOREIGN KEY ("articleId") REFERENCES "KnowledgeArticle"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
