-- AlterTable: ничего — Operation остаётся как есть.

-- CreateTable
CREATE TABLE "OperationSubstitution" (
    "id" TEXT NOT NULL,
    "satisfiesOpId" TEXT NOT NULL,
    "substituteOpId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OperationSubstitution_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OperationSubstitution_satisfiesOpId_substituteOpId_key" ON "OperationSubstitution"("satisfiesOpId", "substituteOpId");

-- CreateIndex
CREATE INDEX "OperationSubstitution_substituteOpId_idx" ON "OperationSubstitution"("substituteOpId");

-- AddForeignKey
ALTER TABLE "OperationSubstitution" ADD CONSTRAINT "OperationSubstitution_satisfiesOpId_fkey" FOREIGN KEY ("satisfiesOpId") REFERENCES "Operation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OperationSubstitution" ADD CONSTRAINT "OperationSubstitution_substituteOpId_fkey" FOREIGN KEY ("substituteOpId") REFERENCES "Operation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Seed: РАСПОШИВ (code='04') — заместитель для Подгиб низа (code='0001')
-- и Распошив рукав (code='16').
--
-- Сценарий: сломан станок «Подгиб низа» → швея делает всю работу одна
-- на rasposhiv-N → закрывает 04 (full) вместо пары (0001, 16). AND-гейт
-- параллельной группы в маршруте 02 ({03, 0001, 16}) должен это принять
-- как эквивалент пары.
--
-- Лук-ап по `code` (а не по id) — id-шники на проде и dev разные. Если
-- какой-то операции нет (например, на dev код 04 ещё не заведён), строка
-- просто пропускается через INNER JOIN, миграция не падает.
INSERT INTO "OperationSubstitution" ("id", "satisfiesOpId", "substituteOpId", "createdAt")
SELECT
  'osub_' || substring(md5(sat.id || ':' || sub.id) for 24),
  sat.id,
  sub.id,
  CURRENT_TIMESTAMP
FROM (VALUES
  ('0001', '04'),  -- Подгиб низа ← РАСПОШИВ
  ('16',   '04')   -- Распошив рукав ← РАСПОШИВ
) AS pair(satisfies_code, substitute_code)
JOIN "Operation" sat ON sat.code = pair.satisfies_code
JOIN "Operation" sub ON sub.code = pair.substitute_code
ON CONFLICT ("satisfiesOpId", "substituteOpId") DO NOTHING;
