-- Справочник значений поля «Характеристика» строки материала техкарты.
--
-- Поле «Подтип» убрано из формы техкарты, его значения переехали в список
-- «Характеристики», а сам список стал пополняемым: то, что менеджер набрал
-- руками, сохраняется здесь и предлагается в следующих техкартах.
--
-- Встроенные значения (лейблы MATERIAL_SUBTYPES) в таблице НЕ хранятся —
-- они живут в коде и подмешиваются на чтении. Здесь только пользовательские.
CREATE TABLE "MaterialCharacteristicOption" (
    "id" TEXT NOT NULL,
    "roleKey" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "valueNorm" TEXT NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MaterialCharacteristicOption_pkey" PRIMARY KEY ("id")
);

-- Защита от дублей: «Молния» и «молния » — одно значение (valueNorm).
CREATE UNIQUE INDEX "MaterialCharacteristicOption_roleKey_valueNorm_key"
    ON "MaterialCharacteristicOption"("roleKey", "valueNorm");

CREATE INDEX "MaterialCharacteristicOption_roleKey_idx"
    ON "MaterialCharacteristicOption"("roleKey");

ALTER TABLE "MaterialCharacteristicOption"
    ADD CONSTRAINT "MaterialCharacteristicOption_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "Employee"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
