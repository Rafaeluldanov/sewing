-- Шаг QC role-terminal: явное подтверждение «ОТК прошло».
--
-- Добавляем новое значение в перечисление `PassportEventType`,
-- чтобы фиксировать действие сотрудника ОТК «Проверка выполнена»
-- отдельно от `OPERATION_FINISHED` (его пишет швея, см.
-- `PassportsService.completeOperationByEmployee`). Семантика и
-- бизнес-инварианты — `docs/flows.md §F5`.
ALTER TYPE "PassportEventType" ADD VALUE 'QC_PASSED';
