import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import {
  CreatePassportQtyCorrectionSchema,
  ReviewPassportQtyCorrectionSchema,
  type ApprovePassportQtyCorrectionResultDto,
  type CreatePassportQtyCorrectionDto,
  type PassportQtyCorrectionDto,
  type ReviewPassportQtyCorrectionDto,
} from '@sewing/shared/passport-qty-corrections';
import { ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import { CurrentUser, Roles } from '../auth/auth.decorators.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { PassportQtyCorrectionsService } from './passport-qty-corrections.service.js';

/**
 * Сторона ОТК: подать заявку на корректировку по паспорту и отозвать
 * свою заявку. Живёт под префиксом `/api/qc`, рядом с остальными
 * ОТК-роутами (`QcController`). RBAC — как у фиксации брака.
 */
@Controller('qc')
export class QcQtyCorrectionsController {
  constructor(private readonly service: PassportQtyCorrectionsService) {}

  /** ОТК предлагает новое фактическое количество по паспорту. */
  @Post('passports/:passportId/qty-corrections')
  @Roles('QC', 'SHOP_MANAGER')
  create(
    @Param('passportId') passportId: string,
    @Body(new ZodValidationPipe(CreatePassportQtyCorrectionSchema))
    dto: CreatePassportQtyCorrectionDto,
    @CurrentUser() user: AuthPrincipal,
  ): Promise<PassportQtyCorrectionDto> {
    return this.service.create(passportId, dto, user.employeeId);
  }

  /** ОТК отзывает свою открытую заявку (пока мастер не рассмотрел). */
  @Post('qty-corrections/:id/cancel')
  @Roles('QC', 'SHOP_MANAGER')
  cancel(
    @Param('id') id: string,
    @CurrentUser() user: AuthPrincipal,
  ): Promise<PassportQtyCorrectionDto> {
    return this.service.cancel(id, user.employeeId);
  }
}

/**
 * Сторона мастера цеха: очередь открытых заявок + подтверждение /
 * отклонение. Отдельный префикс `/api/master-qty-corrections`. RBAC —
 * `SHOPFLOOR_MASTER` (владелец `/master`) + `SHOP_MANAGER` (и `ADMIN`
 * через глобальный guard).
 */
@Controller('master-qty-corrections')
export class MasterQtyCorrectionsController {
  constructor(private readonly service: PassportQtyCorrectionsService) {}

  /** Очередь открытых корректировок для мастера. */
  @Get()
  @Roles('SHOPFLOOR_MASTER', 'SHOP_MANAGER')
  listPending(): Promise<PassportQtyCorrectionDto[]> {
    return this.service.listPending();
  }

  /** Мастер подтверждает корректировку — применяем во всём следе. */
  @Post(':id/approve')
  @Roles('SHOPFLOOR_MASTER', 'SHOP_MANAGER')
  approve(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(ReviewPassportQtyCorrectionSchema))
    dto: ReviewPassportQtyCorrectionDto,
    @CurrentUser() user: AuthPrincipal,
  ): Promise<ApprovePassportQtyCorrectionResultDto> {
    return this.service.approve(id, dto, user.employeeId);
  }

  /** Мастер отклоняет корректировку. */
  @Post(':id/reject')
  @Roles('SHOPFLOOR_MASTER', 'SHOP_MANAGER')
  reject(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(ReviewPassportQtyCorrectionSchema))
    dto: ReviewPassportQtyCorrectionDto,
    @CurrentUser() user: AuthPrincipal,
  ): Promise<PassportQtyCorrectionDto> {
    return this.service.reject(id, dto, user.employeeId);
  }
}
