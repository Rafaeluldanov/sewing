import { Global, Module } from '@nestjs/common';
import { AuditService } from './audit.service.js';

/**
 * Универсальный сервис аудита (`AuditLog`). Сделан `@Global`, потому
 * что записывать события захотят почти все доменные модули
 * (passports / orders / qc / wto / packing / …) — лишний import в
 * каждый module.ts ничего не добавляет к читаемости, зато создаёт
 * шум при добавлении новой точки записи.
 *
 * Контракт сервиса: см. `audit.service.ts` и `docs/domain.md
 * §«Audit log»`.
 */
@Global()
@Module({
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
