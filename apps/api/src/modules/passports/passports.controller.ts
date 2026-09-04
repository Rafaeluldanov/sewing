import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  CreatePassportSchema,
  PlacePassportSchema,
  ReleaseFromRollsSchema,
  UpdatePassportSchema,
  type CreatePassportDto,
  type MyPassportListItem,
  type PlacePassportDto,
  type ReleaseFromRollsDto,
  type ReleaseFromRollsResultDto,
  type UpdatePassportDto,
} from '@sewing/shared/passports';
import { z } from 'zod';
import {
  BatchCompleteOperationsSchema,
  CompleteOperationSchema,
  IssuePassportSchema,
  PassportCodeSchema,
  ScanPassportSchema,
  type BatchCompleteOperationsDto,
  type CompleteOperationDto,
  type IssuePassportDto,
  type ScanPassportDto,
} from '@sewing/shared/shifts';

const PassportByCodeSchema = z.object({ code: PassportCodeSchema });
type PassportByCodeDto = z.infer<typeof PassportByCodeSchema>;
import { ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import { PassportsService } from './passports.service.js';
import {
  renderPassportPrintHtml,
  renderPassportsPrintHtml,
} from './passport-print.js';
import { buildPassportQrPayload, buildPassportWebUrl } from './qr.js';
import * as QRCode from 'qrcode';
import { CurrentUser, Public, MachineScopes, Roles } from '../auth/auth.decorators.js';
import type { AuthPrincipal } from '../auth/auth.types.js';

@Controller('passports')
export class PassportsController {
  constructor(private readonly passports: PassportsService) {}

  /**
   * Ручной выпуск паспорта. RBAC: выпуск кроя теперь ведёт помощник
   * раскройщика (`CUTTER_ASSISTANT`) — преимущественно через рулонный
   * `release-from-rolls`. Ручная форма оставлена менеджеру/админу для
   * правок и заказов без задачи раскроя. Раскройщик (`CUTTER`) паспорта
   * больше НЕ выпускает — его рабочее место — только `/cutter`.
   */
  @Post()
  @Roles('CUTTER_ASSISTANT', 'SHOP_MANAGER')
  create(
    @Body(new ZodValidationPipe(CreatePassportSchema)) dto: CreatePassportDto,
    @CurrentUser() user: AuthPrincipal,
  ) {
    return this.passports.create(dto, user.employeeId);
  }

  /**
   * `POST /api/passports/release-from-rolls` — рулонный выпуск
   * помощником раскройщика. Количество и рулоны берутся из завершённой
   * задачи раскройщика (`CuttingTask`), помощник лишь выбирает размер и
   * рулоны. Идемпотентно по парам `(размер, рулон)`. См.
   * `PassportsService.releaseFromRolls`.
   */
  @Post('release-from-rolls')
  @Roles('CUTTER', 'CUTTER_ASSISTANT', 'SHOP_MANAGER', 'ADMIN')
  releaseFromRolls(
    @Body(new ZodValidationPipe(ReleaseFromRollsSchema)) dto: ReleaseFromRollsDto,
    @CurrentUser() user: AuthPrincipal,
  ): Promise<ReleaseFromRollsResultDto> {
    return this.passports.releaseFromRolls(dto, user.employeeId);
  }

  /**
   * `GET /api/passports/my-recent` — последние паспорта, выпущенные
   * самим actor-ом. Используется страницей `/work/passports` помощника
   * раскройщика / раскройщика. RBAC сужен до тех ролей, у кого есть
   * рабочее место выпуска паспорта; менеджеры/админ всё равно видят
   * чужие паспорта в admin-карточке заказа, отдельной страницы списка
   * для них нет, но мы оставляем им endpoint доступным — это удобно
   * для отладки/QA.
   *
   * Маршрут объявлен ДО `@Get(':id')`, чтобы NestJS-роутер не
   * разрешал его как `id = "my-recent"` и не отдавал `404
   * PASSPORT_NOT_FOUND` вместо списка.
   */
  @Get('my-recent')
  @Roles('CUTTER', 'CUTTER_ASSISTANT', 'SHOP_MANAGER', 'ADMIN')
  async listMineRecent(
    @CurrentUser() user: AuthPrincipal,
  ): Promise<MyPassportListItem[]> {
    return this.passports.listMineRecent(user.employeeId);
  }

  /**
   * `GET /api/passports/print-batch?ids=a,b,c` — пакетная печатная форма:
   * один HTML-документ, в котором по одной этикетке на паспорт (каждая на
   * своей странице 70×120 мм). Открывает кнопка «Распечатать» помощника
   * раскройщика как браузерный fallback, когда на рабочем месте нет
   * настроенного принтера-агента. Public — печать из киоск-режима, как у
   * одиночного `:id/print`.
   *
   * Объявлен ДО `@Get(':id')`, иначе роутер разрешит `print-batch` как
   * `id = "print-batch"` (см. тот же приём у `my-recent`). Отсутствующие
   * id молча пропускаются — печатаем то, что найдено.
   */
  @Public()
  @Get('print-batch')
  @Header('content-type', 'text/html; charset=utf-8')
  async printBatch(@Query('ids') idsRaw?: string): Promise<string> {
    const ids = [
      ...new Set(
        (idsRaw ?? '')
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.length > 0),
      ),
    ].slice(0, 500);
    if (ids.length === 0) {
      throw new BadRequestException({
        statusCode: 400,
        code: 'PRINT_BATCH_EMPTY',
        message: 'Не передан список паспортов для печати',
      });
    }

    const items: Array<{
      passport: Awaited<ReturnType<PassportsService['getOne']>>;
      qrDataUrl: string;
      webUrl: string;
    }> = [];
    for (const id of ids) {
      let passport;
      try {
        passport = await this.passports.getOne(id);
      } catch {
        continue; // отсутствующий паспорт молча пропускаем
      }
      const qrDataUrl = await QRCode.toDataURL(buildPassportQrPayload(id), {
        errorCorrectionLevel: 'M',
        margin: 1,
        width: 320,
      });
      items.push({ passport, qrDataUrl, webUrl: buildPassportWebUrl(id) });
    }

    if (items.length === 0) {
      throw new BadRequestException({
        statusCode: 400,
        code: 'PRINT_BATCH_NOT_FOUND',
        message: 'Ни один из переданных паспортов не найден',
      });
    }
    return renderPassportsPrintHtml(items);
  }

  // Карточка паспорта: из документа производства ERP по номеру-основанию.
  @MachineScopes('orders:read')
  @Get(':id')
  getOne(@Param('id') id: string) {
    return this.passports.getOne(id);
  }

  /**
   * `GET /api/passports/:id/history` — хронологический список
   * `PassportEvent` для экрана `/master` (кнопка «Посмотреть историю
   * паспорта» в `PassportActionsSheet`). См. `docs/flows.md
   * §F-Master actions`.
   *
   * RBAC: основной потребитель — мастер цеха, но история может быть
   * полезна и менеджеру/админу для разбора инцидентов. Раскройщику
   * и швее endpoint недоступен (для них есть `/admin/passports/:id`
   * со своим UI).
   */
  @MachineScopes('orders:read')
  @Get(':id/history')
  @Roles('SHOPFLOOR_MASTER', 'SHOP_MANAGER', 'ADMIN')
  getHistory(@Param('id') id: string) {
    return this.passports.getHistory(id);
  }

  /**
   * `PATCH /api/passports/:id` — редактирование полей паспорта, пока
   * он ещё не двинулся в производство. Источник истины и инварианты —
   * `PassportsService.update` (status=CREATED, без ячейки, без событий
   * кроме CREATED). Для не-менеджерских ролей дополнительно
   * проверяется `creatorId === me`.
   */
  @Patch(':id')
  @Roles('CUTTER', 'CUTTER_ASSISTANT', 'SHOP_MANAGER', 'ADMIN')
  update(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(UpdatePassportSchema)) dto: UpdatePassportDto,
    @CurrentUser() user: AuthPrincipal,
  ) {
    return this.passports.update(id, dto, {
      employeeId: user.employeeId,
      role: user.role,
    });
  }

  /**
   * Удалить паспорт целиком. RBAC расширен: помощник раскройщика и
   * раскройщик могут удалить СВОЙ только что выпущенный паспорт
   * (status=CREATED, без ячейки, без событий кроме CREATED) — это
   * штатная серийная коррекция мисс-выпуска на /work/passports.
   * Менеджер/админ удаляют любой паспорт по строгим инвариантам
   * (boxItems / APPROVED earnings / POSTED material issue).
   * Подробнее — `PassportsService.delete` и `docs/domain.md §7.8
   * «Удаление паспорта»`.
   */
  @Delete(':id')
  @Roles('CUTTER', 'CUTTER_ASSISTANT', 'SHOP_MANAGER', 'ADMIN')
  @HttpCode(204)
  async delete(
    @Param('id') id: string,
    @CurrentUser() user: AuthPrincipal,
  ): Promise<void> {
    await this.passports.delete(id, user.employeeId, user.role);
  }

  @Post(':id/place')
  @Roles('CUTTER', 'CUTTER_ASSISTANT', 'SHOP_MANAGER')
  place(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(PlacePassportSchema)) dto: PlacePassportDto,
  ) {
    return this.passports.place(id, dto);
  }

  /**
   * Швея «получает крой». Снимает паспорт с ячейки и закрепляет его
   * за собой на активной смене. См. `docs/flows.md §F3a`.
   */
  @Post(':id/issue')
  issue(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(IssuePassportSchema)) _dto: IssuePassportDto,
    @CurrentUser() user: AuthPrincipal,
  ) {
    return this.passports.issueToEmployee(id, user.employeeId);
  }

  /**
   * Сканирование паспорта на операции. Любой скан = переход на
   * `session.operationId`. См. `docs/flows.md §F4`.
   */
  @Post(':id/scan')
  scan(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(ScanPassportSchema)) _dto: ScanPassportDto,
    @CurrentUser() user: AuthPrincipal,
  ) {
    return this.passports.scanOnOperation(id, user.employeeId);
  }

  /**
   * Швея завершает свою операцию по паспорту через повторный скан
   * (см. `docs/flows.md §F4a`, ТЗ §2–§7). Тело пустое — владелец
   * определяется сессией. Валидация `passport.currentEmployeeId = me`
   * и `status = IN_PROGRESS` делается в сервисе.
   */
  @Post(':id/complete-operation')
  completeOperation(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(CompleteOperationSchema))
    _dto: CompleteOperationDto,
    @CurrentUser() user: AuthPrincipal,
  ) {
    return this.passports.completeOperationByEmployee(id, user.employeeId);
  }

  /**
   * «Закрыть» свою незакрытую операцию по паспорту, который уже увели
   * дальше по маршруту (секция «Не закрыто вами» на `/work`).
   *
   * Тела нет: что именно закрывать, backend берёт из истории самого
   * паспорта — последнее взятие ЭТОГО сотрудника без последующего
   * `OPERATION_FINISHED` (см.
   * `PassportsService.closeUnclosedOperationByEmployee`). Владелец
   * действия — из сессии (ADR-0014), чужой долг закрыть нельзя.
   */
  @Post(':id/close-unclosed-operation')
  closeUnclosedOperation(
    @Param('id') id: string,
    @CurrentUser() user: AuthPrincipal,
  ) {
    return this.passports.closeUnclosedOperationByEmployee(
      id,
      user.employeeId,
    );
  }

  /**
   * Пакетное завершение операций сразу по нескольким паспортам швеи
   * (UX /work: отметила чекбоксами «Текущий крой» → «Завершить
   * выбранные»). Тело — `{ passportIds: string[] }`; владелец берётся
   * из сессии. Партиальный успех: ответ `{ completed, failed }`, где
   * `failed` несёт бизнес-код и сообщение по каждому незакрытому
   * паспорту (см. `PassportsService.completeOperationsBatch`).
   *
   * Объявлен ДО `@Post(':id/...')`-ничего не ломает (разные сегменты),
   * но держим рядом с одиночным `complete-operation` для читаемости.
   */
  @Post('batch/complete-operations')
  batchCompleteOperations(
    @Body(new ZodValidationPipe(BatchCompleteOperationsSchema))
    dto: BatchCompleteOperationsDto,
    @CurrentUser() user: AuthPrincipal,
  ) {
    return this.passports.completeOperationsBatch(
      dto.passportIds,
      user.employeeId,
    );
  }

  /**
   * Шаг 6: резолв паспорта по произвольному коду (QR `passport:{id}`,
   * номер `P-…`, или голый id). Используется UI `/work`, когда
   * сотрудник сканирует/вводит код, а нам нужен сам паспорт до
   * `issue/scan`. См. ADR-0008.
   *
   * STEP 8 ТЗ MVP (soft-route hint): передаём `user.employeeId` в
   * сервис, чтобы он мог сравнить активную смену сотрудника с
   * ожидаемым шагом маршрута и проставить `routeHint.routeMismatchWithActiveShift`.
   * Это исключительно read-only подсказка, без 409 и без блокировки.
   */
  @Post('by-code')
  byCode(
    @Body(new ZodValidationPipe(PassportByCodeSchema)) dto: PassportByCodeDto,
    @CurrentUser() user: AuthPrincipal,
  ) {
    return this.passports.findByCode(dto.code, {
      employeeIdForRouteHint: user.employeeId,
    });
  }

  /**
   * Печатная форма паспорта (Шаг 5). Отдаём HTML вместо PDF (см. ADR-0010).
   * Браузер сам предложит «Печать» через системный диалог.
   * Печать доступна без сессии — типография может быть открыта в киоск-режиме.
   */
  @Public()
  @Get(':id/print')
  @Header('content-type', 'text/html; charset=utf-8')
  async print(@Param('id') id: string): Promise<string> {
    const passport = await this.passports.getOne(id);
    const qrDataUrl = await QRCode.toDataURL(buildPassportQrPayload(id), {
      errorCorrectionLevel: 'M',
      margin: 1,
      width: 320,
    });
    const webUrl = buildPassportWebUrl(id);
    return renderPassportPrintHtml({ passport, qrDataUrl, webUrl });
  }

  /**
   * PNG QR-кода паспорта в формате `passport:{id}` (ADR-0008). Полезно
   * для интеграций и для встраивания QR в произвольные печатные формы.
   */
  @Public()
  @Get(':id/qr')
  async qr(@Param('id') id: string, @Res() res: Response): Promise<void> {
    // 404, если паспорта нет.
    await this.passports.getOne(id);
    const buf = await QRCode.toBuffer(buildPassportQrPayload(id), {
      errorCorrectionLevel: 'M',
      margin: 1,
      width: 320,
      type: 'png',
    });
    res
      .status(200)
      .setHeader('content-type', 'image/png')
      .setHeader('cache-control', 'public, max-age=300')
      .send(buf);
  }
}
