import { Controller, Get } from '@nestjs/common';
import { QcService } from './qc.service.js';
import { Roles } from '../auth/auth.decorators.js';

/**
 * Справочник видов брака. Вынесен на корневой путь `/api/defect-types`,
 * чтобы фронт мог брать его независимо от ОТК-страниц (например,
 * на форме «Зафиксировать брак» в карточке паспорта).
 *
 * RBAC. Используется только на ОТК-формах, поэтому доступ ограничен
 * теми же ролями, что и `/api/qc/*`: `QC`, `SHOP_MANAGER`, `ADMIN`.
 */
@Controller('defect-types')
@Roles('QC', 'SHOP_MANAGER')
export class DefectTypesController {
  constructor(private readonly qc: QcService) {}

  @Get()
  list() {
    return this.qc.listDefectTypes();
  }
}
