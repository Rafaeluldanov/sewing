import { Body, Controller, Get, Post } from '@nestjs/common';
import {
  CreateDefectTypeSchema,
  type CreateDefectTypeDto,
  type DefectTypeDto,
} from '@sewing/shared/qc';
import { QcService } from './qc.service.js';
import { Roles } from '../auth/auth.decorators.js';
import { ZodValidationPipe } from '../../common/zod-validation.pipe.js';

/**
 * Справочник видов брака. Вынесен на корневой путь `/api/defect-types`,
 * чтобы фронт мог брать его независимо от ОТК-страниц (например,
 * на форме «Зафиксировать брак» в карточке паспорта).
 *
 * RBAC. Чтение — те же роли, что и `/api/qc/*`: `QC`, `SHOP_MANAGER`,
 * `ADMIN` (мастер читает справочник через свой
 * `GET /api/master-actions/defect-types`). Создание («＋ Добавить…» в
 * select-е формы фиксации брака) дополнительно открыто
 * `SHOPFLOOR_MASTER` — метод-уровневый `@Roles` перекрывает
 * класс-уровневый (приём как в `employees.controller.ts`).
 */
@Controller('defect-types')
@Roles('QC', 'SHOP_MANAGER')
export class DefectTypesController {
  constructor(private readonly qc: QcService) {}

  @Get()
  list() {
    return this.qc.listDefectTypes();
  }

  @Post()
  @Roles('QC', 'SHOPFLOOR_MASTER', 'SHOP_MANAGER')
  create(
    @Body(new ZodValidationPipe(CreateDefectTypeSchema))
    dto: CreateDefectTypeDto,
  ): Promise<DefectTypeDto> {
    return this.qc.createDefectType(dto);
  }
}
