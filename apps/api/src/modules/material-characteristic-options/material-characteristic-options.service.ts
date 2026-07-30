import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { MATERIAL_SUBTYPES } from '@sewing/shared/material-characteristics';
import {
  mergeCharacteristicOptions,
  normalizeMaterialCharacteristicOptionValue,
  type CreateMaterialCharacteristicOptionDto,
  type ListMaterialCharacteristicOptionsQuery,
  type MaterialCharacteristicOptionDto,
} from '@sewing/shared/material-characteristic-options';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';

/**
 * Справочник значений поля «Характеристика» строки материала техкарты.
 *
 * Список, который видит менеджер, склеен из двух источников (см. шапку
 * `@sewing/shared/material-characteristic-options`):
 *   - ВСТРОЕННЫЕ значения — лейблы подтипов из `MATERIAL_SUBTYPES`, живут в
 *     коде. В БД их нет и быть не должно: подтипы правятся релизом, и копия
 *     в таблице немедленно разъехалась бы с кодом;
 *   - ПОЛЬЗОВАТЕЛЬСКИЕ — строки этой таблицы, добавленные из комбобокса.
 *
 * Поэтому `list` читает из БД только пользовательские значения и отдаёт уже
 * слитый список — UI не должен знать про два источника.
 */
@Injectable()
export class MaterialCharacteristicOptionsService {
  private readonly logger = new Logger(MaterialCharacteristicOptionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Значения справочника. Без `roleKey` отдаём весь справочник — по всем
   * ролям, у которых есть хоть что-то (встроенное или своё): комбобокс
   * тянет список один раз и переключает роли уже локально.
   */
  async list(
    query: ListMaterialCharacteristicOptionsQuery = {},
  ): Promise<MaterialCharacteristicOptionDto[]> {
    const rows = await this.prisma.materialCharacteristicOption.findMany({
      where: query.roleKey ? { roleKey: query.roleKey } : undefined,
      orderBy: [{ roleKey: 'asc' }, { value: 'asc' }],
      select: { id: true, roleKey: true, value: true },
    });

    // Роли, для которых собираем списки: запрошенная одна — либо все, где
    // есть свои значения, плюс все роли встроенных подтипов (иначе роль без
    // единой пользовательской записи вернулась бы пустой).
    const roleKeys = query.roleKey
      ? [query.roleKey]
      : [...new Set([...ROLE_KEYS_WITH_BUILTINS, ...rows.map((r) => r.roleKey)])];

    const byRole = new Map<string, Array<{ id: string; value: string }>>();
    for (const row of rows) {
      const list = byRole.get(row.roleKey) ?? [];
      list.push({ id: row.id, value: row.value });
      byRole.set(row.roleKey, list);
    }

    return roleKeys.flatMap((roleKey) =>
      mergeCharacteristicOptions(roleKey, byRole.get(roleKey) ?? []),
    );
  }

  /**
   * Добавить пользовательское значение.
   *
   * Идемпотентно и по встроенным, и по своим значениям:
   *   - значение совпало со встроенным (после нормализации) → строку в БД НЕ
   *     создаём, возвращаем встроенную опцию. Дубля «Молния»/«молния» в
   *     списке не будет, а UI получит тот же контракт;
   *   - значение уже добавлено раньше → возвращаем существующую строку.
   * Повторный клик «+ Добавить» (double-submit) поэтому безопасен.
   */
  async create(
    dto: CreateMaterialCharacteristicOptionDto,
    actorEmployeeId?: string | null,
  ): Promise<MaterialCharacteristicOptionDto> {
    const valueNorm = normalizeMaterialCharacteristicOptionValue(dto.value);

    const builtin = mergeCharacteristicOptions(dto.roleKey, []).find(
      (o) => normalizeMaterialCharacteristicOptionValue(o.value) === valueNorm,
    );
    if (builtin) return builtin;

    const existing = await this.prisma.materialCharacteristicOption.findUnique({
      where: { roleKey_valueNorm: { roleKey: dto.roleKey, valueNorm } },
      select: { id: true, roleKey: true, value: true },
    });
    if (existing) {
      return {
        id: existing.id,
        roleKey: existing.roleKey,
        value: existing.value,
        isBuiltin: false,
        subtypeKey: null,
      };
    }

    const created = await this.prisma.materialCharacteristicOption.create({
      data: {
        roleKey: dto.roleKey,
        value: dto.value,
        valueNorm,
        createdById: actorEmployeeId ?? null,
      },
      select: { id: true, roleKey: true, value: true },
    });
    this.logger.log(
      `event=material_characteristic_option.create id=${created.id} ` +
        `role=${created.roleKey} value="${created.value}"`,
    );
    await this.audit.log({
      event: 'MATERIAL_CHARACTERISTIC_OPTION_CREATED',
      entityType: 'MATERIAL_CHARACTERISTIC_OPTION',
      entityId: created.id,
      payload: { roleKey: created.roleKey, value: created.value },
      employeeId: actorEmployeeId ?? null,
    });
    return {
      id: created.id,
      roleKey: created.roleKey,
      value: created.value,
      isBuiltin: false,
      subtypeKey: null,
    };
  }

  /**
   * Убрать пользовательское значение из списка.
   *
   * Удаляется ТОЛЬКО подсказка. Техкарты, где это значение уже проставлено,
   * не трогаем: значение живёт в `fabricType` строки, справочник им не
   * владеет. Встроенные значения удалить нельзя — их просто нет в таблице,
   * и запрос вернёт 404.
   */
  async remove(id: string, actorEmployeeId?: string | null): Promise<void> {
    const row = await this.prisma.materialCharacteristicOption.findUnique({
      where: { id },
      select: { id: true, roleKey: true, value: true },
    });
    if (!row) throw new NotFoundException('Значение справочника не найдено');

    await this.prisma.materialCharacteristicOption.delete({ where: { id } });
    this.logger.log(
      `event=material_characteristic_option.delete id=${row.id} ` +
        `role=${row.roleKey} value="${row.value}"`,
    );
    await this.audit.log({
      event: 'MATERIAL_CHARACTERISTIC_OPTION_DELETED',
      entityType: 'MATERIAL_CHARACTERISTIC_OPTION',
      entityId: row.id,
      payload: { roleKey: row.roleKey, value: row.value },
      employeeId: actorEmployeeId ?? null,
    });
  }
}

/**
 * Роли, у которых есть встроенные значения (группы подтипов). Список
 * подтипов статичен, поэтому считаем один раз на модуль.
 */
const ROLE_KEYS_WITH_BUILTINS: string[] = [
  ...new Set(MATERIAL_SUBTYPES.map((s) => s.groupRoleKey)),
];
