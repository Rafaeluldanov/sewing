import { Controller, Get, Param } from '@nestjs/common';
import { CuttingClosureService } from './cutting-closure.service.js';

/**
 * Подресурс паспорта: «текущая» заявка на закрытие раскроя по строке,
 * к которой относится паспорт. Используется UI карточки паспорта
 * (`/passports/[id]`) — и помощник, и мастер видят один и тот же
 * объект, просто по-разному реагируют на статус.
 *
 * Доступ намеренно открыт всем авторизованным ролям (как и сама
 * карточка паспорта `/passports/:id`): сами действия `approve`/
 * `reject`/`create` защищены ролевыми гвардами в основном
 * контроллере. Это согласуется с тем, как мы оформили историю
 * дефектов (`PassportDefectsController`).
 */
@Controller('passports')
export class PassportCuttingClosureController {
  constructor(private readonly closure: CuttingClosureService) {}

  @Get(':id/cutting-closure-request')
  current(@Param('id') id: string) {
    return this.closure.findCurrentForPassport(id);
  }
}
