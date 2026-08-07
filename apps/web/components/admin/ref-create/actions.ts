'use server';

/**
 * Inline server actions контура «＋ Добавить…» в select-ах справочников.
 *
 * Отличие от «страничных» `create*Action` в `app/admin/<раздел>/actions.ts`:
 *   - НЕ редиректят (модалка остаётся на текущей странице);
 *   - возвращают созданный DTO — клиент сам мержит его в список опций
 *     и автоматически выбирает (эталон —
 *     `app/admin/orders/new/inline-product-actions.ts`);
 *   - НЕ вызывают revalidatePath/Tag: страницы справочников читают API
 *     с `cache: 'no-store'` и увидят запись при следующем заходе, а
 *     revalidate из action дёрнул бы RSC-refresh текущей страницы
 *     посреди заполнения формы хоста.
 *
 * Валидация — теми же Zod-схемами `@sewing/shared`, что и backend.
 * Правило файла: только async-экспорты ('use server').
 */

import {
  CreateClientSchema,
  type ClientDto,
} from '@sewing/shared/clients';
import {
  CreateCompanyDivisionSchema,
  type CompanyDivisionDto,
} from '@sewing/shared/company-divisions';
import {
  CreateSupplierSchema,
  type SupplierDetailDto,
} from '@sewing/shared/suppliers';
import {
  CreateWarehouseLineSchema,
  CreateWarehouseSchema,
  type CreateWarehouseLineResultDto,
  type WarehouseDetailDto,
} from '@sewing/shared/warehouses';
import {
  CreateCashAccountSchema,
  CreateCashFlowItemSchema,
  type CashAccountDto,
  type CashFlowItemDto,
} from '@sewing/shared/treasury';
import {
  CreateOperationSchema,
  type OperationDetailDto,
} from '@sewing/shared/operations';
import {
  CreatePrinterSchema,
  type PrinterDetailDto,
} from '@sewing/shared/printers';
import {
  CreateAppRoleSchema,
  type AppRoleDto,
} from '@sewing/shared/app-roles';
import { ApiRequestError, errorText } from '@/lib/api';
import { createClient } from '@/lib/clients-api';
import { createCompanyDivision } from '@/lib/company-settings-api';
import { createSupplier } from '@/lib/suppliers-api';
import {
  createWarehouse,
  createWarehouseLine,
  listWarehouses,
} from '@/lib/warehouses-api';
import { createCashAccount, createCashFlowItem } from '@/lib/treasury-api';
import { createOperation } from '@/lib/operations-api';
import { createPrinter } from '@/lib/printers-api';
import { createAppRole } from '@/lib/app-roles-api';
import type { LoadWarehousesResult, RefActionResult } from './types';

function explainApiError(e: unknown): string {
  if (e instanceof ApiRequestError) {
    return errorText(e);
  }
  return 'Не удалось выполнить запрос';
}

async function runCreate<S extends { safeParse: (raw: unknown) => any }, T>(
  schema: S,
  raw: unknown,
  create: (dto: any) => Promise<T>,
  fallbackError: string,
): Promise<RefActionResult<T>> {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? fallbackError };
  }
  try {
    const dto = await create(parsed.data);
    return { ok: true, dto };
  } catch (e) {
    return { error: explainApiError(e) };
  }
}

export async function createClientInlineAction(
  raw: unknown,
): Promise<RefActionResult<ClientDto>> {
  return runCreate(
    CreateClientSchema,
    raw,
    createClient,
    'Не удалось создать клиента',
  );
}

export async function createCompanyDivisionInlineAction(
  raw: unknown,
): Promise<RefActionResult<CompanyDivisionDto>> {
  return runCreate(
    CreateCompanyDivisionSchema,
    raw,
    createCompanyDivision,
    'Не удалось создать подразделение',
  );
}

export async function createSupplierInlineAction(
  raw: unknown,
): Promise<RefActionResult<SupplierDetailDto>> {
  return runCreate(
    CreateSupplierSchema,
    raw,
    createSupplier,
    'Не удалось создать поставщика',
  );
}

export async function createWarehouseInlineAction(
  raw: unknown,
): Promise<RefActionResult<WarehouseDetailDto>> {
  return runCreate(
    CreateWarehouseSchema,
    raw,
    createWarehouse,
    'Не удалось создать склад',
  );
}

export async function createCashFlowItemInlineAction(
  raw: unknown,
): Promise<RefActionResult<CashFlowItemDto>> {
  return runCreate(
    CreateCashFlowItemSchema,
    raw,
    createCashFlowItem,
    'Не удалось создать статью ДДС',
  );
}

export async function createCashAccountInlineAction(
  raw: unknown,
): Promise<RefActionResult<CashAccountDto>> {
  return runCreate(
    CreateCashAccountSchema,
    raw,
    createCashAccount,
    'Не удалось создать счёт',
  );
}

export async function createOperationInlineAction(
  raw: unknown,
): Promise<RefActionResult<OperationDetailDto>> {
  return runCreate(
    CreateOperationSchema,
    raw,
    createOperation,
    'Не удалось создать операцию',
  );
}

export async function createPrinterInlineAction(
  raw: unknown,
): Promise<RefActionResult<PrinterDetailDto>> {
  return runCreate(
    CreatePrinterSchema,
    raw,
    createPrinter,
    'Не удалось создать принтер',
  );
}

export async function createAppRoleInlineAction(
  raw: unknown,
): Promise<RefActionResult<AppRoleDto>> {
  return runCreate(
    CreateAppRoleSchema,
    raw,
    createAppRole,
    'Не удалось создать роль',
  );
}

export async function createWarehouseCellsInlineAction(
  warehouseId: string,
  raw: unknown,
): Promise<RefActionResult<CreateWarehouseLineResultDto>> {
  if (!warehouseId) {
    return { error: 'Не выбран склад для новой линии ячеек' };
  }
  return runCreate(
    CreateWarehouseLineSchema,
    raw,
    (dto) => createWarehouseLine(warehouseId, dto),
    'Не удалось создать ячейки',
  );
}

/**
 * Список складов для модалки ячеек, когда хост не зафиксировал склад
 * (`context.lockWarehouse` не задан) — например, оприходование.
 */
export async function loadWarehousesForCellsAction(): Promise<LoadWarehousesResult> {
  try {
    const dto = await listWarehouses();
    return { ok: true, dto };
  } catch (e) {
    return { error: explainApiError(e) };
  }
}
