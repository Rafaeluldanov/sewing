-- End-to-end выбор Windows-принтера для агента (см. docs/domain.md §17b
-- «Физический принтер Windows», docs/api.md §16). Полностью additive:
-- ничего не ломаем, существующий pairing/heartbeat/polling/print flow
-- остаётся.
--
-- Что добавляем в "Printer":
--   * agentHostName            — hostname Windows-машины агента;
--   * availableWindowsPrinters — список системных принтеров (string[]),
--     присланный агентом через POST /api/printers/agent/windows-printers;
--   * windowsPrintersUpdatedAt — когда агент в последний раз прислал
--     этот список (отдельно от lastSeenAt — UI хочет различать «агент
--     онлайн» и «список свежий»);
--   * selectedWindowsPrinter   — какой именно Windows-принтер выбрал
--     менеджер для печати. Проверка «он есть в availableWindowsPrinters»
--     валидируется на бекенде (PrintersService.update).

ALTER TABLE "Printer"
    ADD COLUMN "agentHostName"            TEXT,
    ADD COLUMN "availableWindowsPrinters" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    ADD COLUMN "windowsPrintersUpdatedAt" TIMESTAMP(3),
    ADD COLUMN "selectedWindowsPrinter"   TEXT;
