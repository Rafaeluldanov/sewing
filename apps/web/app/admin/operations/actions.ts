'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { ApiRequestError } from '@/lib/api';
import {
  getEquipment,
  updateEquipmentOperations,
} from '@/lib/equipment-api';
import { createOperation, updateOperation } from '@/lib/operations-api';
import {
  OPERATION_CATEGORIES,
  PRICING_MODES,
  type OperationCategory,
  type PricingMode,
  type UpdateOperationDto,
} from '@sewing/shared/operations';
import type {
  CreateOperationState,
  UpdateOperationState,
} from './form-state';

/**
 * Server actions для управленческого блока «Операции» (см. ADR-0017,
 * `docs/api.md §15a`, `docs/screens.md §10c`). RBAC — на backend
 * (`@Roles('SHOP_MANAGER', 'ADMIN')`). Frontend дополнительно скрывает
 * раздел через `app/admin/layout.tsx`.
 *
 * Принцип: формы шлют простые FormData, action разбирает их в DTO
 * и зовёт `lib/operations-api.ts`. Любая бизнес-ошибка backend (например,
 * `OPERATION_CODE_TAKEN` или `OPERATION_RATE_MISSING`) транслируется
 * в `state.error` — компоненты подсветят её рядом с формой.
 */

// ---------------------------------------------------------------------------
// CREATE
// ---------------------------------------------------------------------------

function isPricingMode(v: string): v is PricingMode {
  return (PRICING_MODES as readonly string[]).includes(v);
}

function isCategory(v: string): v is OperationCategory {
  return (OPERATION_CATEGORIES as readonly string[]).includes(v);
}

export async function createOperationAction(
  _prev: CreateOperationState,
  form: FormData,
): Promise<CreateOperationState> {
  const code = String(form.get('code') ?? '').trim().toUpperCase();
  const name = String(form.get('name') ?? '').trim();
  const categoryRaw = String(form.get('category') ?? '').trim();
  const pricingModeRaw = String(form.get('pricingMode') ?? '').trim();
  const fixedRateRaw = String(form.get('fixedRate') ?? '').trim();

  // Опциональная сразу-привязка к оборудованию (см. `docs/screens.md §10c`).
  // Чек-листы в форме шлют все отмеченные значения с одним name —
  // дубликаты тут невозможны, но всё равно нормализуем set'ом, чтобы
  // не зависеть от поведения форм.
  const equipmentIds = Array.from(
    new Set(
      form
        .getAll('equipmentIds')
        .map((v) => String(v).trim())
        .filter((v) => v.length > 0),
    ),
  );

  if (code.length === 0) return { error: 'Введите код операции' };
  if (name.length === 0) return { error: 'Введите название операции' };
  if (!isCategory(categoryRaw)) return { error: 'Выберите категорию' };
  if (!isPricingMode(pricingModeRaw)) return { error: 'Выберите тип тарифа' };

  // Минимальный create — без BY_SIZE-таблицы (это менеджер потом
  // заполняет на карточке). Если выбран FIXED, fixedRate обязателен.
  let fixedRate: number | undefined;
  if (pricingModeRaw === 'FIXED') {
    const num = Number(fixedRateRaw.replace(',', '.'));
    if (!Number.isFinite(num) || num < 0) {
      return { error: 'Введите валидную фиксированную ставку' };
    }
    fixedRate = num;
  }

  let createdId: string | null = null;
  try {
    const created = await createOperation({
      code,
      name,
      category: categoryRaw,
      pricingMode: pricingModeRaw,
      ...(fixedRate !== undefined ? { fixedRate } : {}),
    });
    createdId = created.id;
    revalidatePath('/admin/operations');
  } catch (e) {
    if (e instanceof ApiRequestError) {
      return {
        error: `${e.message}${e.code ? ` (${e.code})` : ''}`,
        errorRequestId: e.requestId,
      };
    }
    return { error: 'Не удалось создать операцию' };
  }

  // Привязка к выбранному оборудованию.
  //
  // Backend `PATCH /api/equipment/:id/operations` — это full-replace
  // набора операций, поэтому, чтобы не стереть уже разрешённые на
  // конкретном станке операции, мы для каждого выбранного equipment
  // сначала читаем текущий allow-list, потом дописываем новый id
  // (если его там ещё нет) и шлём PATCH. Доменную модель и
  // contract-эндпоинта не меняем (см. ADR-0017, `docs/api.md §3a`).
  //
  // Параллелить запросы здесь не имеет смысла: чек-лист обычно
  // 1–3 станка, и последовательная обработка даёт более понятную
  // диагностику ошибок (мы знаем, какой именно станок упал).
  const linkErrors: string[] = [];
  let linkedRequestId: string | undefined;
  if (createdId && equipmentIds.length > 0) {
    for (const equipmentId of equipmentIds) {
      try {
        const eq = await getEquipment(equipmentId);
        const current = eq.allowedOperations.map((l) => l.operationId);
        if (current.includes(createdId)) {
          continue;
        }
        await updateEquipmentOperations(equipmentId, {
          operationIds: [...current, createdId],
        });
        revalidatePath(`/admin/equipment/${equipmentId}`);
      } catch (e) {
        if (e instanceof ApiRequestError) {
          linkErrors.push(
            `${equipmentId}: ${e.message}${e.code ? ` (${e.code})` : ''}`,
          );
          if (!linkedRequestId) linkedRequestId = e.requestId;
        } else {
          linkErrors.push(`${equipmentId}: неизвестная ошибка`);
        }
      }
    }

    if (linkErrors.length > 0) {
      // Операция уже создана (и видна в списке), но часть привязок
      // упала. Не редиректим, чтобы менеджер сразу увидел, что не
      // всё прошло чисто, и мог переоткрыть карточки оборудования.
      // Не удаляем уже созданную операцию — её код мог быть
      // намеренно разовым (UPPER_SNAKE_CASE с pipeline-зависимостями).
      revalidatePath('/admin/equipment');
      revalidatePath('/work');
      return {
        partialOperationId: createdId,
        error:
          `Операция создана, но не удалось привязать её к оборудованию: ` +
          linkErrors.join('; '),
        errorRequestId: linkedRequestId,
      };
    }

    revalidatePath('/admin/equipment');
    revalidatePath('/work');
  }

  if (createdId) {
    redirect(`/admin/operations/${createdId}`);
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// UPDATE
// ---------------------------------------------------------------------------

/**
 * Универсальный update: одна форма на карточке операции, в которой
 * менеджер меняет всё сразу — meta, тарифный режим, ставки. Ставки
 * приходят из FormData как пары `rate-<sizeId>=<value>`. Пустые
 * значения трактуем как «оставить как есть» (пропускаем строку), —
 * чтобы менеджер мог заполнять таблицу постепенно. Полная очистка —
 * через явный action «Сменить режим на FIXED/SALARY_ONLY», который
 * на backend стирает все строки `OperationRateBySize`.
 */
export async function updateOperationAction(
  operationId: string,
  _prev: UpdateOperationState,
  form: FormData,
): Promise<UpdateOperationState> {
  const name = String(form.get('name') ?? '').trim();
  const categoryRaw = String(form.get('category') ?? '').trim();
  const pricingModeRaw = String(form.get('pricingMode') ?? '').trim();
  const isActive = form.get('isActive') === 'on';
  const fixedRateRaw = String(form.get('fixedRate') ?? '').trim();

  if (name.length === 0) return { error: 'Введите название операции' };
  if (!isCategory(categoryRaw)) return { error: 'Выберите категорию' };
  if (!isPricingMode(pricingModeRaw)) return { error: 'Выберите тип тарифа' };

  const dto: UpdateOperationDto = {
    name,
    category: categoryRaw,
    pricingMode: pricingModeRaw,
    isActive,
  };

  if (pricingModeRaw === 'FIXED') {
    const num = Number(fixedRateRaw.replace(',', '.'));
    if (!Number.isFinite(num) || num < 0) {
      return { error: 'Введите валидную фиксированную ставку' };
    }
    dto.fixedRate = num;
  } else {
    // BY_SIZE / SALARY_ONLY: явно обнуляем fixedRate, чтобы UI и
    // backend не оставались с расходящимися значениями.
    dto.fixedRate = null;
  }

  if (pricingModeRaw === 'BY_SIZE') {
    // Парсим пары rate-<sizeId>=<value>. Пустые значения — пропуск.
    const ratesBySize: Array<{ sizeId: string; rate: number }> = [];
    for (const [key, raw] of form.entries()) {
      if (!key.startsWith('rate-')) continue;
      const sizeId = key.slice('rate-'.length);
      if (!sizeId) continue;
      const valStr = String(raw ?? '').trim();
      if (valStr.length === 0) continue;
      const num = Number(valStr.replace(',', '.'));
      if (!Number.isFinite(num) || num < 0) {
        return {
          error: `Невалидная ставка для размера ${sizeId}: «${valStr}»`,
        };
      }
      ratesBySize.push({ sizeId, rate: num });
    }
    dto.ratesBySize = ratesBySize;
  } else {
    // FIXED / SALARY_ONLY → не передаём ratesBySize, backend и так
    // удалит все строки в одной транзакции (см. OperationsService.update).
  }

  try {
    await updateOperation(operationId, dto);
    revalidatePath('/admin/operations');
    revalidatePath(`/admin/operations/${operationId}`);
    return {
      ok: true,
      successMessage: 'Сохранено.',
    };
  } catch (e) {
    if (e instanceof ApiRequestError) {
      return {
        error: `${e.message}${e.code ? ` (${e.code})` : ''}`,
        errorRequestId: e.requestId,
      };
    }
    return { error: 'Не удалось сохранить операцию' };
  }
}
