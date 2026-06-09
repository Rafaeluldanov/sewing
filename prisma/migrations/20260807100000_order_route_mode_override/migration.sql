-- Адаптивный режим сплит-распошива: ручной override на заказе.
-- См. apps/api/src/modules/passports/route-mode.ts (modeForOrder) и
-- prisma/schema.prisma::RouteModeOverride / Order.routeModeOverride.
--
-- AUTO (по умолчанию) — режим SPLIT/COLLAPSED вычисляется на лету по
-- активным сменам на выделенном низ-станке. FORCE_* — мастер фиксирует
-- режим вручную. Снапшот маршрута (OrderRouteStep) не трогается.

-- CreateEnum
CREATE TYPE "RouteModeOverride" AS ENUM ('AUTO', 'FORCE_SPLIT', 'FORCE_COLLAPSED');

-- AlterTable
ALTER TABLE "Order"
  ADD COLUMN "routeModeOverride" "RouteModeOverride" NOT NULL DEFAULT 'AUTO';
