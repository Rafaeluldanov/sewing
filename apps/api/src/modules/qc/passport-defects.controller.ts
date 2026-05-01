import { Controller, Get, Param } from '@nestjs/common';
import { QcService } from './qc.service.js';

/**
 * Подресурс паспорта: история зафиксированных дефектов.
 *
 * Вынесен в QC-модуль, чтобы не размазывать логику работы с
 * `PassportDefect` между двумя сервисами и не тащить QcService в
 * `PassportsModule` ради одного списочного метода.
 */
@Controller('passports')
export class PassportDefectsController {
  constructor(private readonly qc: QcService) {}

  @Get(':id/defects')
  list(@Param('id') id: string) {
    return this.qc.listDefectsByPassport(id);
  }
}
