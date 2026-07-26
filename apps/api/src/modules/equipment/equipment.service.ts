import { Injectable, Logger } from '@nestjs/common';
import type {
  CreateEquipmentDto,
  EquipmentDetailDto,
  EquipmentOperationLinkDto,
  EquipmentSummaryDto,
  UpdateEquipmentDto,
} from '@sewing/shared/equipment';
import {
  OPERATION_CATEGORY_ORDER,
  type OperationCategory,
} from '@sewing/shared/operations';
import { Prisma, type Role } from '@prisma/client';
import type { BulkArchiveResultDto } from '@sewing/shared/archive';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { indexById, runBulkArchive } from '../../common/bulk-archive.js';
import {
  EquipmentCodeTakenException,
  EquipmentNotFoundException,
  OperationNotFoundException,
} from '../../common/errors.js';

/**
 * Управление каталогом оборудования и его разрешённых операций
 * (см. ADR-0017). Источник истины для seamstress flow на /work — это
 * сервис: он читает таблицу `EquipmentOperation` и отдаёт UI набор
 * операций, доступных для конкретного станка.
 *
 * Запись (`updateOperations`) — полная замена набора: сравниваем
 * текущий состав с пришедшим, удаляем лишние строки, добавляем
 * недостающие, обновляем `sortOrder` в порядке массива. Всё в одной
 * транзакции, чтобы UI никогда не «увидел» промежуточное состояние
 * между удалением и вставкой.
 */
@Injectable()
export class EquipmentService {
  private readonly logger = new Logger(EquipmentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // -------------------------------------------------------------------------
  // LIST
  // -------------------------------------------------------------------------

  async list(): Promise<EquipmentSummaryDto[]> {
    const rows = await this.prisma.equipment.findMany({
      orderBy: { code: 'asc' },
      include: {
        _count: {
          select: {
            allowedOperations: {
              where: { isActive: true, operation: { active: true } },
            },
          },
        },
        // Включение категорий — additive: фронту нужно для группировки
        // `/admin/equipment` по категориям связанных операций
        // (см. ТЗ «Единая группировка», §6). Берём только активные
        // связи с активной операцией, чтобы chip-список совпадал с
        // тем, что менеджер видит в детали оборудования.
        allowedOperations: {
          where: { isActive: true, operation: { active: true } },
          select: { operation: { select: { category: true } } },
        },
      },
    });
    return rows.map((eq) => ({
      id: eq.id,
      code: eq.code,
      qrCode: eq.qrCode,
      name: eq.name,
      displayNumber: eq.displayNumber,
      active: eq.active,
      role: eq.role ?? null,
      allowedOperationsCount: eq._count.allowedOperations,
      operationCategories: this.collectCategories(
        eq.allowedOperations.map((l) => l.operation.category),
      ),
    }));
  }

  /**
   * Возвращает уникальные категории операций, отсортированные по
   * `OPERATION_CATEGORY_ORDER`. Невалидные/легаси-значения отбрасываются —
   * UI всё равно показывает их через shared-helper как «Без категории»,
   * но в массиве `operationCategories` мы держим только канон.
   */
  private collectCategories(
    raw: ReadonlyArray<string | null | undefined>,
  ): string[] {
    const allowed = new Set<string>(OPERATION_CATEGORY_ORDER);
    const seen = new Set<OperationCategory>();
    for (const value of raw) {
      if (value && allowed.has(value)) {
        seen.add(value as OperationCategory);
      }
    }
    return OPERATION_CATEGORY_ORDER.filter((c) => seen.has(c));
  }

  // -------------------------------------------------------------------------
  // DETAIL
  // -------------------------------------------------------------------------

  async getOne(id: string): Promise<EquipmentDetailDto> {
    const row = await this.prisma.equipment.findUnique({
      where: { id },
      include: {
        allowedOperations: {
          orderBy: { sortOrder: 'asc' },
          include: { operation: true },
        },
      },
    });
    if (!row) throw new EquipmentNotFoundException();
    return this.toDetailDto(row);
  }

  // -------------------------------------------------------------------------
  // UPDATE OPERATIONS (полная замена набора)
  // -------------------------------------------------------------------------

  async updateOperations(
    equipmentId: string,
    operationIds: string[],
  ): Promise<EquipmentDetailDto> {
    const equipment = await this.prisma.equipment.findUnique({
      where: { id: equipmentId },
      select: { id: true },
    });
    if (!equipment) throw new EquipmentNotFoundException();

    // Валидируем переданные operationId до старта транзакции — так
    // диагностируем «битые» id одной 404 вместо общей FK-ошибки.
    if (operationIds.length > 0) {
      const found = await this.prisma.operation.findMany({
        where: { id: { in: operationIds } },
        select: { id: true },
      });
      if (found.length !== operationIds.length) {
        throw new OperationNotFoundException();
      }
    }

    await this.prisma.$transaction(async (tx) => {
      const existing = await tx.equipmentOperation.findMany({
        where: { equipmentId },
        select: { id: true, operationId: true },
      });
      const wantedSet = new Set(operationIds);
      const existingSet = new Set(existing.map((e) => e.operationId));

      const toDelete = existing
        .filter((e) => !wantedSet.has(e.operationId))
        .map((e) => e.id);
      if (toDelete.length > 0) {
        await tx.equipmentOperation.deleteMany({
          where: { id: { in: toDelete } },
        });
      }

      for (let i = 0; i < operationIds.length; i += 1) {
        const operationId = operationIds[i]!;
        const sortOrder = (i + 1) * 10;
        if (existingSet.has(operationId)) {
          await tx.equipmentOperation.update({
            where: {
              EquipmentOperation_equipment_operation_uniq: {
                equipmentId,
                operationId,
              },
            },
            data: { sortOrder, isActive: true },
          });
        } else {
          await tx.equipmentOperation.create({
            data: {
              equipmentId,
              operationId,
              sortOrder,
              isActive: true,
            },
          });
        }
      }
    });

    return this.getOne(equipmentId);
  }

  // -------------------------------------------------------------------------
  // INTERNAL
  // -------------------------------------------------------------------------

  private toDetailDto(
    row: Prisma.EquipmentGetPayload<{
      include: {
        allowedOperations: {
          include: { operation: true };
        };
      };
    }>,
  ): EquipmentDetailDto {
    const allowed: EquipmentOperationLinkDto[] = row.allowedOperations.map(
      (l) => ({
        operationId: l.operation.id,
        operationCode: l.operation.code,
        operationName: l.operation.name,
        operationCategory: l.operation.category,
        sortOrder: l.sortOrder,
        isActive: l.isActive && l.operation.active,
      }),
    );
    return {
      id: row.id,
      code: row.code,
      qrCode: row.qrCode,
      name: row.name,
      displayNumber: row.displayNumber,
      active: row.active,
      role: row.role ?? null,
      allowedOperations: allowed,
    };
  }

  // -------------------------------------------------------------------------
  // UPDATE (карточка) — точечное редактирование (MVP: только displayNumber)
  // -------------------------------------------------------------------------

  /**
   * Обновляет «человеческие» поля карточки оборудования: `name`
   * (переименование) и `displayNumber` (ручной номер для физической
   * маркировки, см. ADR-0017, `docs/domain.md §5c`).
   *
   * Контракт остаётся узким: `code`, `qrCode`, `active` через эту
   * ручку не меняются — они либо ставятся при создании, либо требуют
   * отдельного сценария (см. ADR-0017 §5).
   */
  async update(
    equipmentId: string,
    dto: UpdateEquipmentDto,
  ): Promise<EquipmentDetailDto> {
    const equipment = await this.prisma.equipment.findUnique({
      where: { id: equipmentId },
      select: { id: true },
    });
    if (!equipment) throw new EquipmentNotFoundException();

    const data: Prisma.EquipmentUpdateInput = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.displayNumber !== undefined) {
      data.displayNumber = dto.displayNumber;
    }
    if (dto.role !== undefined) {
      // `null` — снять привязку к роли; роль — рабочее место станет
      // точкой скан-переключения (фича «смена роли сканом»).
      data.role = (dto.role as Role | null) ?? null;
    }
    if (Object.keys(data).length > 0) {
      await this.prisma.equipment.update({
        where: { id: equipmentId },
        data,
      });
      this.logger.log(
        `event=equipment.update id=${equipmentId} fields=${Object.keys(data).join(',')}`,
      );
    }
    return this.getOne(equipmentId);
  }

  // -------------------------------------------------------------------------
  // CREATE
  // -------------------------------------------------------------------------

  /**
   * Создаёт новую единицу оборудования (см. `docs/api.md §3a`,
   * `docs/screens.md §10a`). Алгоритм:
   *
   *   1. Если `code` не задан — генерируем slug имени и подбираем
   *      уникальный суффикс через `nextAvailableCode`. Менеджер
   *      получает «overlock-03» из «Оверлок 3» автоматически.
   *   2. Если переданы `operationIds` — pre-flight проверка
   *      существования (отдельная 404 вместо общего FK-сбоя).
   *   3. В одной транзакции:
   *        - создаём `Equipment` с временным `qrCode = equipment-pending:{code}`;
   *        - сразу же обновляем `qrCode` на каноничное `equipment:{id}`
   *          (та же двухфазная схема, что в `prisma/seed.ts`).
   *          Это сохраняет инвариант ADR-0008 — сканер на /work
   *          ищет ровно `equipment:{id}`;
   *        - вставляем связи `EquipmentOperation` с
   *          `sortOrder = (i + 1) * 10` — порядок задаёт менеджер
   *          из формы.
   *
   * Уникальность `code` гарантируется БД. P2002 транслируется в
   * `EQUIPMENT_CODE_TAKEN` (409) — UI подсветит поле «Код».
   */
  async create(dto: CreateEquipmentDto): Promise<EquipmentDetailDto> {
    if (dto.operationIds && dto.operationIds.length > 0) {
      const found = await this.prisma.operation.findMany({
        where: { id: { in: dto.operationIds } },
        select: { id: true },
      });
      if (found.length !== dto.operationIds.length) {
        throw new OperationNotFoundException();
      }
    }

    const code = dto.code ?? (await this.nextAvailableCode(dto.name));
    const operationIds = dto.operationIds ?? [];

    let createdId: string;
    try {
      createdId = await this.prisma.$transaction(async (tx) => {
        const created = await tx.equipment.create({
          data: {
            code,
            name: dto.name,
            displayNumber: dto.displayNumber ?? null,
            role: (dto.role as Role | null) ?? null,
            // qrCode UNIQUE NOT NULL — сначала ставим временный, ниже обновим.
            qrCode: `equipment-pending:${code}`,
            active: true,
          },
        });
        await tx.equipment.update({
          where: { id: created.id },
          data: { qrCode: `equipment:${created.id}` },
        });
        for (let i = 0; i < operationIds.length; i += 1) {
          const operationId = operationIds[i]!;
          await tx.equipmentOperation.create({
            data: {
              equipmentId: created.id,
              operationId,
              sortOrder: (i + 1) * 10,
              isActive: true,
            },
          });
        }
        return created.id;
      });
    } catch (e) {
      this.translateUniqueError(e);
      throw e;
    }

    this.logger.log(
      `event=equipment.create id=${createdId} code=${code} operations=${operationIds.length}`,
    );
    return this.getOne(createdId);
  }

  // -------------------------------------------------------------------------
  // INTERNAL — code generation & error translation
  // -------------------------------------------------------------------------

  /**
   * Преобразует человекочитаемое название в slug, удовлетворяющий
   * `EQUIPMENT_CODE_PATTERN` (`^[a-z0-9][a-z0-9-]*$`):
   *
   *   - кириллица транслитерируется по простой таблице («Оверлок» → `overlok`);
   *   - всё, что не латиница/цифра, заменяется на «-»;
   *   - повторные «-» схлопываются, ведущие/хвостовые удаляются;
   *   - пустой результат заменяется на `equipment` (защита от имён
   *     вроде «—»).
   *
   * Это ровно то, что делает менеджер руками (`overlock-01`,
   * `coverstitch-02`), просто автоматически — чтобы UI создания не
   * требовал ввода технического кода.
   */
  private slugifyName(name: string): string {
    const translit: Record<string, string> = {
      а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh',
      з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o',
      п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts',
      ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu',
      я: 'ya',
    };
    const lower = name.toLowerCase();
    let out = '';
    for (const ch of lower) {
      if (Object.prototype.hasOwnProperty.call(translit, ch)) {
        out += translit[ch];
      } else if (/[a-z0-9]/.test(ch)) {
        out += ch;
      } else {
        out += '-';
      }
    }
    out = out.replace(/-+/g, '-').replace(/^-+|-+$/g, '');
    if (out.length === 0) out = 'equipment';
    return out.slice(0, 56); // оставим запас под суффикс «-NN»
  }

  /**
   * Подбирает уникальный код для нового оборудования: пробуем slug,
   * затем slug-2, slug-3 и т. д. Конкурентная вставка всё равно
   * защищена unique-индексом (на P2002 поднимется
   * `EquipmentCodeTakenException`), но в типичном single-writer
   * сценарии менеджер сразу получает «overlock-03» без коллизий.
   */
  private async nextAvailableCode(name: string): Promise<string> {
    const base = this.slugifyName(name);
    for (let i = 1; i < 1000; i += 1) {
      const candidate = i === 1 ? base : `${base}-${i}`;
      const exists = await this.prisma.equipment.findUnique({
        where: { code: candidate },
        select: { id: true },
      });
      if (!exists) return candidate;
    }
    // Запас в 1000 заведомо хватает; если когда-нибудь упрёмся —
    // явная ошибка лучше тихой коллизии.
    throw new EquipmentCodeTakenException();
  }

  // ===========================================================================
  // АРХИВ ОБОРУДОВАНИЯ — bulk archive / restore / purge
  // ===========================================================================
  //
  // Общий контур справочников админки (`@sewing/shared/archive`).
  // Архив станка — `active = false`: он пропадает из подбора рабочего
  // места и из списков `/work`, но история смен и событий остаётся.
  //
  // Гейт purge: смены (`ShiftSession`), события паспортов
  // (`PassportEvent`), вызовы мастера (`MasterCall`) — все три FK
  // `RESTRICT`, БД и так не даст удалить, но 409 без пояснения хуже,
  // чем понятное «используется». Подкрой (`RecutSession`) и принтеры
  // ссылаются с `SET NULL` — они удалению не мешают. Разрешения на
  // операции (`EquipmentOperation`) уходят каскадом: это часть станка.
  //
  // На практике станок с историей удалить нельзя — и это правильно:
  // для него есть архив.

  private async describeUsage(id: string): Promise<string | null> {
    const [shifts, events, masterCalls] = await Promise.all([
      this.prisma.shiftSession.count({ where: { equipmentId: id } }),
      this.prisma.passportEvent.count({ where: { equipmentId: id } }),
      this.prisma.masterCall.count({ where: { equipmentId: id } }),
    ]);
    const parts: string[] = [];
    if (shifts > 0) parts.push(`смен: ${shifts}`);
    if (events > 0) parts.push(`событий паспортов: ${events}`);
    if (masterCalls > 0) parts.push(`вызовов мастера: ${masterCalls}`);
    return parts.length > 0 ? parts.join(', ') : null;
  }

  async archiveMany(
    ids: string[],
    actorEmployeeId?: string | null,
  ): Promise<BulkArchiveResultDto> {
    const res = await runBulkArchive({
      ids,
      load: async (want) =>
        indexById(
          await this.prisma.equipment.findMany({
            where: { id: { in: want } },
            select: { id: true, active: true },
          }),
        ),
      alreadyDone: (row) => !row.active,
      gate: () => null,
      apply: async (_rows, targetIds) => {
        await this.prisma.$transaction(async (tx) => {
          await tx.equipment.updateMany({
            where: { id: { in: targetIds } },
            data: { active: false },
          });
          await this.audit.log(
            {
              event: 'EQUIPMENTS_ARCHIVED',
              entityType: 'EQUIPMENT',
              entityId: targetIds[0],
              employeeId: actorEmployeeId ?? null,
              payload: { equipmentIds: targetIds },
            },
            tx,
          );
        });
      },
    });
    this.logger.log(
      `event=equipment.archive processed=${res.processed.length} skipped=${res.skipped.length}`,
    );
    return res;
  }

  async restoreMany(
    ids: string[],
    actorEmployeeId?: string | null,
  ): Promise<BulkArchiveResultDto> {
    const res = await runBulkArchive({
      ids,
      load: async (want) =>
        indexById(
          await this.prisma.equipment.findMany({
            where: { id: { in: want } },
            select: { id: true, active: true },
          }),
        ),
      alreadyDone: (row) => row.active,
      gate: () => null,
      apply: async (_rows, targetIds) => {
        await this.prisma.$transaction(async (tx) => {
          await tx.equipment.updateMany({
            where: { id: { in: targetIds } },
            data: { active: true },
          });
          await this.audit.log(
            {
              event: 'EQUIPMENTS_RESTORED',
              entityType: 'EQUIPMENT',
              entityId: targetIds[0],
              employeeId: actorEmployeeId ?? null,
              payload: { equipmentIds: targetIds },
            },
            tx,
          );
        });
      },
    });
    this.logger.log(
      `event=equipment.restore processed=${res.processed.length} skipped=${res.skipped.length}`,
    );
    return res;
  }

  async purgeMany(
    ids: string[],
    actorEmployeeId?: string | null,
  ): Promise<BulkArchiveResultDto> {
    const res = await runBulkArchive({
      ids,
      load: async (want) =>
        indexById(
          await this.prisma.equipment.findMany({
            where: { id: { in: want } },
            select: { id: true, code: true, name: true, active: true },
          }),
        ),
      gate: async (row) => {
        if (row.active) return { reason: 'NOT_ARCHIVED' as const };
        const usage = await this.describeUsage(row.id);
        return usage
          ? {
              reason: 'IN_USE' as const,
              detail: `у станка «${row.code}» есть история (${usage})`,
            }
          : null;
      },
      apply: async (rows) => {
        for (const row of rows) {
          await this.prisma.$transaction(async (tx) => {
            await tx.equipment.delete({ where: { id: row.id } });
            await this.audit.log(
              {
                event: 'EQUIPMENT_DELETED',
                entityType: 'EQUIPMENT',
                entityId: row.id,
                employeeId: actorEmployeeId ?? null,
                payload: { code: row.code, name: row.name, bulk: true },
              },
              tx,
            );
          });
        }
      },
    });
    this.logger.log(
      `event=equipment.purge processed=${res.processed.length} skipped=${res.skipped.length}`,
    );
    return res;
  }

  private translateUniqueError(e: unknown): void {
    if (
      e instanceof Prisma.PrismaClientKnownRequestError &&
      e.code === 'P2002'
    ) {
      const target = (e.meta?.target as string[] | string | undefined) ?? [];
      const fields = Array.isArray(target) ? target : [target];
      if (fields.some((f) => String(f).includes('code'))) {
        throw new EquipmentCodeTakenException();
      }
      // qrCode тоже unique, но он формируется из id — коллизия
      // практически невозможна. На всякий случай транслируем как
      // «код занят», чтобы UI не падал в 500.
      throw new EquipmentCodeTakenException();
    }
  }
}
