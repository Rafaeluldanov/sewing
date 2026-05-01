-- Шаг WTO role-terminal: явное подтверждение «ВТО выполнено».
--
-- По аналогии с `QC_PASSED` (миграция 20260419120000_qc_passed_event)
-- добавляем новое значение в перечисление `PassportEventType`, чтобы
-- фиксировать действие сотрудника ВТО «Завершить ВТО» отдельно от
-- `OPERATION_FINISHED` (его пишет швея). Семантика и бизнес-инварианты
-- — `docs/flows.md §F6`, ADR-0013 §«WTO_DONE bucket».
ALTER TYPE "PassportEventType" ADD VALUE 'WTO_PASSED';
