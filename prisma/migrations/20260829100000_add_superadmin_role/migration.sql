-- Мультитенантность Фаза 4: роль супер-админа control-plane.
-- Применяется ко ВСЕМ тенант-БД (через tenant:migrate-all). PG12+ допускает
-- ALTER TYPE ... ADD VALUE в транзакции; IF NOT EXISTS делает шаг идемпотентным.
ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'SUPERADMIN';
