-- Фича «несколько ролей у сотрудника» + «смена активной роли сканом
-- рабочего места» (18.06.2026).
--
-- 1) Employee.roles  — полный набор ролей доступа (ИНВАРИАНТ: содержит role).
--    Бэкфилл из текущей role → набор из одного элемента, поведение не
--    меняется для существующих сотрудников.
-- 2) Employee.activeRole — последняя роль, на которую переключились сканом
--    (лендинг/подсветка); NULL = берём role.
-- 3) Equipment.role — роль «рабочего места» для скан-переключения; NULL =
--    станок в переключении не участвует.

ALTER TABLE "Employee" ADD COLUMN "roles" "Role"[] NOT NULL DEFAULT ARRAY[]::"Role"[];
ALTER TABLE "Employee" ADD COLUMN "activeRole" "Role";

-- Бэкфилл набора ролей из текущей основной роли.
UPDATE "Employee" SET "roles" = ARRAY["role"]::"Role"[];

ALTER TABLE "Equipment" ADD COLUMN "role" "Role";
