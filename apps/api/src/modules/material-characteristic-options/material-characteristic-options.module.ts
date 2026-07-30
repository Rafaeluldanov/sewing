import { Module } from '@nestjs/common';
import { MaterialCharacteristicOptionsController } from './material-characteristic-options.controller.js';
import { MaterialCharacteristicOptionsService } from './material-characteristic-options.service.js';

/**
 * Модуль справочника значений поля «Характеристика» строки материала
 * техкарты (замена убранного поля «Подтип», см. шапку сервиса).
 *
 * Таблица `MaterialCharacteristicOption` хранит только ПОЛЬЗОВАТЕЛЬСКИЕ
 * значения; встроенные подмешиваются из `MATERIAL_SUBTYPES` на чтении.
 */
@Module({
  controllers: [MaterialCharacteristicOptionsController],
  providers: [MaterialCharacteristicOptionsService],
  exports: [MaterialCharacteristicOptionsService],
})
export class MaterialCharacteristicOptionsModule {}
