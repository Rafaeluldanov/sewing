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
  TIME_NORM_MODES,
  type OperationCategory,
  type PricingMode,
  type TimeNormMode,
  type UpdateOperationDto,
} from '@sewing/shared/operations';
import { toSeconds } from '@/lib/operations-time-norm';
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

function isTimeNormMode(v: string): v is TimeNormMode {
  return (TIME_NORM_MODES as readonly string[]).includes(v);
}

/**
 * Парсит блок «Норма времени» из FormData. Поля формы:
 *   - `timeNormMode` — `FIXED` / `BY_SIZE`;
 *   - для FIXED: `timeNormMin` + `timeNormSecPart`;
 *   - для BY_SIZE: пары `timeNormMin-<sizeId>` + `timeNormSec-<sizeId>`.
 *
 * Возвращает `{ timeNormMode, timeNormSec, timeNormsBySize }` или
 * `{ error }` при невалидных значениях.
 */
function parseTimeNormFromForm(form: FormData):
  | {
      timeNormMode: TimeNormMode;
      timeNormSec: number | null;
      timeNormsBySize: Array<{ sizeId: string; seconds: number }> | undefined;
    }
  | { error: string } {
  const modeRaw = String(form.get('timeNormMode') ?? '').trim();
  const timeNormMode: TimeNormMode = isTimeNormMode(modeRaw) ? modeRaw : 'FIXED';

  if (timeNormMode === 'FIXED') {
    const min = String(form.get('timeNormMin') ?? '').trim();
    const sec = String(form.get('timeNormSecPart') ?? '').trim();
    if (sec.length > 0) {
      const secNum = Number(sec.replace(',', '.'));
      if (!Number.isFinite(secNum) || secNum < 0 || secNum > 59) {
        return { error: 'Секунды нормы времени — от 0 до 59' };
      }
    }
    if (min.length > 0) {
      const minNum = Number(min.replace(',', '.'));
      if (!Number.isFinite(minNum) || minNum < 0) {
        return { error: 'Минуты нормы времени не могут быть отрицательными' };
      }
    }
    const total = toSeconds(min, sec);
    return {
      timeNormMode,
      timeNormSec: total,
      timeNormsBySize: undefined,
    };
  }

  // BY_SIZE: собираем пары по sizeId.
  const minBySize = new Map<string, string>();
  const secBySize = new Map<string, string>();
  for (const [key, raw] of form.entries()) {
    const valStr = String(raw ?? '').trim();
    if (key.startsWith('timeNormMin-')) {
      const sizeId = key.slice('timeNormMin-'.length);
      if (sizeId) minBySize.set(sizeId, valStr);
    } else if (key.startsWith('timeNormSec-')) {
      const sizeId = key.slice('timeNormSec-'.length);
      if (sizeId) secBySize.set(sizeId, valStr);
    }
  }
  const sizeIds = new Set<string>([...minBySize.keys(), ...secBySize.keys()]);
  const timeNormsBySize: Array<{ sizeId: string; seconds: number }> = [];
  for (const sizeId of sizeIds) {
    const min = minBySize.get(sizeId) ?? '';
    const sec = secBySize.get(sizeId) ?? '';
    if (sec.length > 0) {
      const secNum = Number(sec.replace(',', '.'));
      if (!Number.isFinite(secNum) || secNum < 0 || secNum > 59) {
        return { error: `Секунды нормы для ${sizeId} — от 0 до 59` };
      }
    }
    if (min.length > 0) {
      const minNum = Number(min.replace(',', '.'));
      if (!Number.isFinite(minNum) || minNum < 0) {
        return { error: `Минуты нормы для ${sizeId} не могут быть отрицательными` };
      }
    }
    const total = toSeconds(min, sec);
    if (total !== null && total > 0) {
      timeNormsBySize.push({ sizeId, seconds: total });
    }
    // Пустые строки — пропускаем (норма не задана для этого размера).
  }

  return { timeNormMode, timeNormSec: null, timeNormsBySize };
}

/**
 * Парсит блок «Плановая окладная стоимость» из FormData. Поля формы:
 *   - `salaryPlanRubPerShift` — стоимость одной смены, ₽
 *     (`> 0`, иначе трактуется как «не задано»);
 *   - `salaryPlanShiftHours` — длительность смены, часы
 *     (`> 0`, default 8 часов).
 *
 * Возвращает `{ salaryPlanRubPerShift, salaryPlanShiftSeconds }` или
 * `{ error }` при невалидных значениях.
 *
 * Контракты:
 *   - оба поля пусты ⇒ оба `null` (UI показывает «ставка не задана»);
 *   - указана только ставка ⇒ длительность по умолчанию = 8 часов
 *     (28800 секунд);
 *   - указана только длительность без ставки ⇒ ставка `null`
 *     (длительность сама по себе бессмысленна, но мы отдадим её
 *     бэкенду — он сам решит).
 */
function parseSalaryPlanFromForm(form: FormData):
  | {
      salaryPlanRubPerShift: number | null;
      salaryPlanShiftSeconds: number | null;
    }
  | { error: string } {
  const rateRaw = String(form.get('salaryPlanRubPerShift') ?? '').trim();
  const hoursRaw = String(form.get('salaryPlanShiftHours') ?? '').trim();

  let salaryPlanRubPerShift: number | null = null;
  if (rateRaw.length > 0) {
    const num = Number(rateRaw.replace(',', '.'));
    if (!Number.isFinite(num) || num <= 0) {
      return {
        error:
          'Плановая стоимость смены должна быть положительным числом',
      };
    }
    salaryPlanRubPerShift = num;
  }

  let salaryPlanShiftSeconds: number | null = null;
  if (hoursRaw.length > 0) {
    const hours = Number(hoursRaw.replace(',', '.'));
    if (!Number.isFinite(hours) || hours <= 0) {
      return {
        error: 'Длительность смены (часы) должна быть положительным числом',
      };
    }
    if (hours > 48) {
      return { error: 'Длительность смены не может быть больше 48 часов' };
    }
    salaryPlanShiftSeconds = Math.floor(hours * 3600);
  } else if (salaryPlanRubPerShift !== null) {
    // Ставку задали без длительности — подставляем 8 часов по умолчанию.
    salaryPlanShiftSeconds = 28800;
  }

  return { salaryPlanRubPerShift, salaryPlanShiftSeconds };
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

  // Норма времени: на форме создания — только режим FIXED + единая
  // норма (опц.). Поразмерная матрица заполняется на карточке после
  // создания (по тому же паттерну, что и BY_SIZE-ставки).
  const timeNorm = parseTimeNormFromForm(form);
  if ('error' in timeNorm) return { error: timeNorm.error };

  // Плановая окладная ставка — отдельная ось от тарифа и от нормы.
  // Особенно полезна для `pricingMode = SALARY_ONLY` (без неё план
  // окладных операций считается = 0). См. ТЗ «Плановая стоимость
  // окладных операций».
  const salaryPlan = parseSalaryPlanFromForm(form);
  if ('error' in salaryPlan) return { error: salaryPlan.error };

  // Признак выпуска готовой продукции (см.
  // `prisma/schema.prisma::Operation.producesFinishedGoods`,
  // `apps/api/src/modules/finished-goods/finished-goods.service.ts::recordPassportOutputInTx`).
  // Чекбокс включён → прохождение этой операции по паспорту
  // создаёт `FinishedGoodsMovement PRODUCTION_RECEIPT IN`.
  const producesFinishedGoods = form.get('producesFinishedGoods') === 'on';

  let createdId: string | null = null;
  try {
    const created = await createOperation({
      code,
      name,
      category: categoryRaw,
      pricingMode: pricingModeRaw,
      ...(fixedRate !== undefined ? { fixedRate } : {}),
      timeNormMode: timeNorm.timeNormMode,
      ...(timeNorm.timeNormMode === 'FIXED' && timeNorm.timeNormSec !== null
        ? { timeNormSec: timeNorm.timeNormSec }
        : {}),
      ...(timeNorm.timeNormMode === 'BY_SIZE' &&
      timeNorm.timeNormsBySize !== undefined
        ? { timeNormsBySize: timeNorm.timeNormsBySize }
        : {}),
      ...(salaryPlan.salaryPlanRubPerShift !== null
        ? { salaryPlanRubPerShift: salaryPlan.salaryPlanRubPerShift }
        : {}),
      ...(salaryPlan.salaryPlanShiftSeconds !== null
        ? { salaryPlanShiftSeconds: salaryPlan.salaryPlanShiftSeconds }
        : {}),
      producesFinishedGoods,
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

  // Норма времени — отдельная ось от тарифа. Её обновляем независимо
  // от pricingMode: операция с SALARY_ONLY всё равно может иметь
  // плановую норму (см. recon §10).
  const timeNorm = parseTimeNormFromForm(form);
  if ('error' in timeNorm) return { error: timeNorm.error };
  dto.timeNormMode = timeNorm.timeNormMode;
  if (timeNorm.timeNormMode === 'FIXED') {
    dto.timeNormSec = timeNorm.timeNormSec;
  } else {
    dto.timeNormSec = null;
    if (timeNorm.timeNormsBySize !== undefined) {
      dto.timeNormsBySize = timeNorm.timeNormsBySize;
    }
  }

  // Плановая окладная ставка — также отдельная ось. Бэкенд:
  //   - `null` → обнулить ставку;
  //   - `number` → проставить;
  //   - не передавать → не трогать (но мы здесь всегда передаём,
  //     потому что форма отдала бы как минимум пустые строки).
  const salaryPlan = parseSalaryPlanFromForm(form);
  if ('error' in salaryPlan) return { error: salaryPlan.error };
  dto.salaryPlanRubPerShift = salaryPlan.salaryPlanRubPerShift;
  dto.salaryPlanShiftSeconds = salaryPlan.salaryPlanShiftSeconds;

  // Признак выпуска готовой продукции (см.
  // `prisma/schema.prisma::Operation.producesFinishedGoods`,
  // `apps/api/src/modules/finished-goods/finished-goods.service.ts::recordPassportOutputInTx`).
  // Forms send `'on'` для checked checkbox; иначе ключа в FormData нет
  // — отправляем `false` явно, чтобы менеджер мог его выключить.
  dto.producesFinishedGoods = form.get('producesFinishedGoods') === 'on';

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
