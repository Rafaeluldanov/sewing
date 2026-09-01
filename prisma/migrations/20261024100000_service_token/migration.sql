-- Машинный токен для интеграции с ERP upgifts (сервер-сервер).
--
-- Таблица приезжает ПУСТОЙ: пока владелец не выпустит токен, поведение API не
-- меняется ни на байт. Существующие таблицы не затрагиваются — ни ALTER, ни DML,
-- ни бэкфилла, значит ни блокировок на рабочих таблицах, ни перезаписи данных.
-- Вход цеха (cookie `sewing_session`) этой таблицы не читает вовсе.
--
-- IF NOT EXISTS — страховка от окружения, где entrypoint успел сделать
-- `prisma db push` до `migrate deploy`.
CREATE TABLE IF NOT EXISTS "ServiceToken" (
  "id"          TEXT NOT NULL,
  "name"        TEXT NOT NULL,
  "tokenHash"   TEXT NOT NULL,
  "tokenPrefix" TEXT NOT NULL,
  "roles"       TEXT[] NOT NULL DEFAULT ARRAY['SHOP_MANAGER']::TEXT[],
  "scopes"      TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "createdById" TEXT,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastUsedAt"  TIMESTAMP(3),
  "expiresAt"   TIMESTAMP(3),
  "revokedAt"   TIMESTAMP(3),
  "revokedById" TEXT,
  CONSTRAINT "ServiceToken_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ServiceToken_tokenHash_key"
  ON "ServiceToken"("tokenHash");
