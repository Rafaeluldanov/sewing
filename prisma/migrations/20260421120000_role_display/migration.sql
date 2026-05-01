-- Добавляем read-only роль для экрана цеха (shopfloor display).
-- Backwards-compatible: новый enum-value не ломает уже существующих
-- сотрудников, потому что по умолчанию никто эту роль не получает —
-- demo-аккаунт `display` создаётся seed-скриптом.
ALTER TYPE "Role" ADD VALUE 'DISPLAY';
