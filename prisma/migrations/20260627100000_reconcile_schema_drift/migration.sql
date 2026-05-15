-- Reconcile migration history with prisma/schema.prisma.
--
-- These columns / indexes / FK exist in schema.prisma (and were applied to
-- already-running environments via `prisma db push`), but no earlier
-- migration creates them. A from-scratch `prisma migrate deploy` (new
-- server / db:reset) would therefore be missing them and the app would fail.
--
-- Written idempotently (IF NOT EXISTS / guarded FK): on a fresh DB it adds
-- the missing objects; on environments that already have them (prod) every
-- statement is a no-op, so this migration cannot break an existing server.

-- AlterTable: Box
ALTER TABLE "Box" ADD COLUMN IF NOT EXISTS "placedAt" TIMESTAMP(3);
ALTER TABLE "Box" ADD COLUMN IF NOT EXISTS "placedInCellId" TEXT;

-- AlterTable: Printer
ALTER TABLE "Printer" ADD COLUMN IF NOT EXISTS "role" "Role";

-- AlterTable: StockBalance (drop stray DB default; updatedAt is app-managed @updatedAt)
ALTER TABLE "StockBalance" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Box_placedAt_idx" ON "Box"("placedAt");
CREATE INDEX IF NOT EXISTS "Box_placedInCellId_idx" ON "Box"("placedInCellId");
CREATE INDEX IF NOT EXISTS "Printer_role_isActive_idx" ON "Printer"("role", "isActive");

-- AddForeignKey (Postgres has no ADD CONSTRAINT IF NOT EXISTS — guard by name)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'Box_placedInCellId_fkey'
  ) THEN
    ALTER TABLE "Box"
      ADD CONSTRAINT "Box_placedInCellId_fkey"
      FOREIGN KEY ("placedInCellId") REFERENCES "Cell"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END
$$;
