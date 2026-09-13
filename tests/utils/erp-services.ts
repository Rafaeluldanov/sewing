/**
 * Сервисы ERP-очередей на ПРЯМОМ prisma-клиенте тестов.
 *
 * DI-версии из контейнера Nest ходят через `PrismaService`-прокси, которому нужен
 * `TenantContext` HTTP-запроса; ручки очередей машинные (`@MachineScopes`), и машинного токена
 * в тестовом приложении нет. Поэтому очереди зовём напрямую, собирая цепочку зависимостей
 * руками на клиенте `t.prisma` — так же, как это делали `erp-production-document.test.ts` и
 * `erp-material-consumption.test.ts` до аудита 13.09.2026 (D1-2/D1-3), когда у сервисов
 * появилась зависимость от `ProductionDocumentsService`.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import type { TestApp } from './app';
import { AuditService } from '../../apps/api/src/modules/audit/audit.service.js';
import { OrderFactCostService } from '../../apps/api/src/modules/costs/order-fact-cost.service.js';
import { OrderMaterialCostService } from '../../apps/api/src/modules/costs/order-material-cost.service.js';
import { PassportRealCostService } from '../../apps/api/src/modules/costs/passport-real-cost.service.js';
import { ErpConsumptionService } from '../../apps/api/src/modules/integrations/erp-consumption.service.js';
import { ErpProductionService } from '../../apps/api/src/modules/integrations/erp-production.service.js';
import { ProductionDocumentNumberService } from '../../apps/api/src/modules/production-documents/production-document-number.service.js';
import { ProductionDocumentsService } from '../../apps/api/src/modules/production-documents/production-documents.service.js';

export function buildOrderFactCostService(t: TestApp): OrderFactCostService {
  const prisma = t.prisma as any;
  return new OrderFactCostService(
    prisma,
    new PassportRealCostService(prisma),
    new OrderMaterialCostService(prisma),
  );
}

export function buildProductionDocumentsService(t: TestApp): ProductionDocumentsService {
  const prisma = t.prisma as any;
  return new ProductionDocumentsService(
    prisma,
    new ProductionDocumentNumberService(),
    buildOrderFactCostService(t),
    new AuditService(prisma),
  );
}

/** Очередь сдачи заказов в ERP (`GET/PUT /api/integrations/erp-production`). */
export function buildErpProductionService(t: TestApp): ErpProductionService {
  return new ErpProductionService(
    t.prisma as any,
    buildOrderFactCostService(t),
    buildProductionDocumentsService(t),
  );
}

/** Очередь списания материала в ERP (`GET/PUT /api/integrations/erp-consumption`). */
export function buildErpConsumptionService(t: TestApp): ErpConsumptionService {
  return new ErpConsumptionService(t.prisma as any, buildProductionDocumentsService(t));
}
