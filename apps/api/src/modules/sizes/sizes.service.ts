import { Injectable, Logger } from '@nestjs/common';
import type { CreateSizeDto, SizeDto } from '@sewing/shared/sizes';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';

/**
 * Сервис write-операций справочника `Size`.
 *
 * Контракт `create`:
 *   - `dto.code` уже нормализован Zod-схемой (`CreateSizeSchema`
 *     в `@sewing/shared/sizes`), поэтому здесь мы оперируем
 *     каноничной строкой;
 *   - если в БД уже есть размер с таким `code` — возвращаем его без
 *     модификации (idempotent). Это сознательная политика: повторный
 *     submit модалки «Создать размер» не должен ломать UX, а сам
 *     `Size.code` уникален в БД (`@unique` в `prisma/schema.prisma`).
 *   - если размера нет — создаём, `sortOrder` либо берём из DTO,
 *     либо ставим `max(Size.sortOrder) + 10`, чтобы новые размеры
 *     уезжали в конец списка справочника (см. ТЗ §«Сортировка
 *     размеров»).
 *
 * Аудит:
 *   - реальная вставка пишет одно событие `SIZE_CREATED` (entityType
 *     `SIZE`, payload — `code`/`sortOrder`).
 *   - idempotent-возврат существующего размера НЕ пишет аудит — это
 *     не изменение справочника.
 */
@Injectable()
export class SizesService {
  private readonly logger = new Logger(SizesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async create(
    dto: CreateSizeDto,
    actorEmployeeId?: string | null,
  ): Promise<SizeDto> {
    const code = dto.code;

    const existing = await this.prisma.size.findUnique({ where: { code } });
    if (existing) {
      // Idempotent return: повторный POST не создаёт дубль и не пишет
      // аудит. UI ожидает SizeDto в обоих случаях — он не различает
      // «создан только что» и «уже был».
      return toDto(existing);
    }

    const sortOrder =
      typeof dto.sortOrder === 'number'
        ? dto.sortOrder
        : await this.nextSortOrder();

    const created = await this.prisma.size.create({
      data: { code, sortOrder },
    });
    this.logger.log(
      `event=size.create id=${created.id} code="${created.code}" sortOrder=${created.sortOrder}`,
    );
    await this.audit.log({
      event: 'SIZE_CREATED',
      entityType: 'SIZE',
      entityId: created.id,
      payload: {
        code: created.code,
        sortOrder: created.sortOrder,
      },
      employeeId: actorEmployeeId ?? null,
    });
    return toDto(created);
  }

  /**
   * Следующий `sortOrder` для размера, добавляемого в конец списка.
   * Считаем как `max(sortOrder) + 10`. Если справочник пуст — возвращаем
   * `10`, чтобы первый размер не получил `sortOrder = 0`.
   */
  private async nextSortOrder(): Promise<number> {
    const agg = await this.prisma.size.aggregate({
      _max: { sortOrder: true },
    });
    return (agg._max.sortOrder ?? 0) + 10;
  }
}

function toDto(row: {
  id: string;
  code: string;
  sortOrder: number;
}): SizeDto {
  return { id: row.id, code: row.code, sortOrder: row.sortOrder };
}
