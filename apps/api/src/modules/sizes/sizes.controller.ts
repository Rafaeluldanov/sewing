import { Body, Controller, Post } from '@nestjs/common';
import {
  CreateSizeSchema,
  type CreateSizeDto,
  type SizeDto,
} from '@sewing/shared/sizes';
import { ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import { CurrentUser, MachineScopes, Roles } from '../auth/auth.decorators.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { SizesService } from './sizes.service.js';

/**
 * Контроллер write-эндпоинтов справочника `Size`.
 *
 *   POST /api/sizes — создание нового размера в общем справочнике.
 *
 * RBAC — `ADMIN`/`SHOP_MANAGER`. Read-only `GET /api/sizes` живёт в
 * `CatalogController` (любая авторизованная роль) — для чтения нам
 * не нужно повышать права, чтобы формы заказов и карточки лекал
 * могли подгружать справочник без ADMIN-сессии.
 *
 * Контракт `POST` (см. `CreateSizeSchema` в `@sewing/shared/sizes`):
 *   Body: `{ code: string; sortOrder?: number | null }`
 *   Response: `SizeDto` (id / code / sortOrder).
 *
 * Идемпотентность:
 *   - повторный POST с тем же кодом (после нормализации) НЕ создаёт
 *     дубль и возвращает существующий размер. Это важно для UI:
 *     модалка «Создать размер» не падает на double-submit, а закрывается
 *     с тем же результатом, что и при первой попытке.
 */
@Roles('ADMIN', 'SHOP_MANAGER')
@Controller('sizes')
@MachineScopes('patterns:read', 'patterns:write')
export class SizesController {
  constructor(private readonly sizes: SizesService) {}

  @Post()
  create(
    @Body(new ZodValidationPipe(CreateSizeSchema))
    body: CreateSizeDto,
    @CurrentUser() user: AuthPrincipal,
  ): Promise<SizeDto> {
    return this.sizes.create(body, user.employeeId);
  }
}
