import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import {
  CreateCutReleasePolicySchema,
  UpdateCutReleasePolicySchema,
  type CreateCutReleasePolicyDto,
  type CutReleasePolicyDto,
  type UpdateCutReleasePolicyDto,
} from '@sewing/shared';
import { ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import { CurrentUser, Roles } from '../auth/auth.decorators.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { CutReleasePolicyService } from './cut-release-policy.service.js';

/**
 * Stage 3 «Мастер цеха» — REST-контракт управления одной активной
 * политикой выдачи кроя.
 *
 * Endpoints (все защищены `SHOPFLOOR_MASTER` / `SHOP_MANAGER` /
 * implicit `ADMIN` через глобальный `RolesGuard`):
 *
 *   - `GET    /api/cut-release-policy`             — текущая активная или `null`;
 *   - `POST   /api/cut-release-policy`             — создать новую (старая выключается);
 *   - `PATCH  /api/cut-release-policy/:id`         — точечное обновление полей;
 *   - `POST   /api/cut-release-policy/:id/disable` — снять ограничение.
 *
 * Сервис не возвращает `null` из `disable/update`: если политики с таким
 * `id` нет, бросается `NotFoundException` («не нашли — нечего отключать»).
 */
@Controller('cut-release-policy')
@Roles('SHOPFLOOR_MASTER', 'SHOP_MANAGER')
export class CutReleasePolicyController {
  constructor(private readonly service: CutReleasePolicyService) {}

  /**
   * Текущая активная политика. `null` означает «ограничений нет», и UI
   * на `/master` показывает empty-state «Установить ограничение».
   */
  @Get()
  async getActive(): Promise<{ policy: CutReleasePolicyDto | null }> {
    return { policy: await this.service.getActive() };
  }

  /**
   * Создать новую активную политику. Все остальные активные политики
   * будут выключены в той же транзакции (см.
   * `CutReleasePolicyService.create`).
   */
  @Post()
  async create(
    @CurrentUser() user: AuthPrincipal,
    @Body(new ZodValidationPipe(CreateCutReleasePolicySchema))
    dto: CreateCutReleasePolicyDto,
  ): Promise<CutReleasePolicyDto> {
    return this.service.create(user, dto);
  }

  /**
   * Точечное обновление существующей политики. Используется редко —
   * мастер обычно создаёт новую. Поддерживаем для админских
   * корректировок (увеличить лимит на лету, поменять активность вручную).
   */
  @Patch(':id')
  async update(
    @CurrentUser() user: AuthPrincipal,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(UpdateCutReleasePolicySchema))
    dto: UpdateCutReleasePolicyDto,
  ): Promise<CutReleasePolicyDto> {
    try {
      return await this.service.update(user, id, dto);
    } catch (err) {
      if (
        err instanceof Error &&
        err.message === 'CUT_RELEASE_POLICY_NOT_FOUND'
      ) {
        throw new NotFoundException({
          statusCode: 404,
          code: 'CUT_RELEASE_POLICY_NOT_FOUND',
          message: 'Политика выдачи кроя не найдена',
        });
      }
      throw err;
    }
  }

  /**
   * Снять ограничение (выставить `isActive = false`). Идемпотентно —
   * повторный вызов на уже отключённой политике вернёт её состояние
   * без дополнительной записи в audit.
   */
  @Post(':id/disable')
  async disable(
    @CurrentUser() user: AuthPrincipal,
    @Param('id') id: string,
  ): Promise<CutReleasePolicyDto> {
    try {
      return await this.service.disable(user, id);
    } catch (err) {
      if (
        err instanceof Error &&
        err.message === 'CUT_RELEASE_POLICY_NOT_FOUND'
      ) {
        throw new NotFoundException({
          statusCode: 404,
          code: 'CUT_RELEASE_POLICY_NOT_FOUND',
          message: 'Политика выдачи кроя не найдена',
        });
      }
      throw err;
    }
  }
}
