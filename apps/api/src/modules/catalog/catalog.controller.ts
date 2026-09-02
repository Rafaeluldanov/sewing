import { Controller, Get } from '@nestjs/common';
import type { ProductDto, SizeDto } from '@sewing/shared/orders';
import { PrismaService } from '../../prisma/prisma.service';
import { MachineScopes } from '../auth/auth.decorators.js';

/**
 * Справочники, нужные формам заказов (Шаг 4):
 *   GET /api/sizes
 *   GET /api/products
 *
 * Шаг 4 отдаёт эти эндпоинты read-only. CRUD (POST/PATCH) из admin-панели
 * появится на следующих шагах (см. `docs/api.md §2`).
 */
@Controller()
@MachineScopes('catalog:read')
export class CatalogController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('sizes')
  async sizes(): Promise<SizeDto[]> {
    const rows = await this.prisma.size.findMany({
      orderBy: { sortOrder: 'asc' },
    });
    return rows.map((s) => ({ id: s.id, code: s.code, sortOrder: s.sortOrder }));
  }

  @Get('products')
  async products(): Promise<ProductDto[]> {
    const rows = await this.prisma.product.findMany({
      where: { active: true },
      orderBy: { name: 'asc' },
    });
    return rows.map((p) => ({
      id: p.id,
      name: p.name,
      color: p.color,
      active: p.active,
    }));
  }
}
