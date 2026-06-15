import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import {
  UpdateTreasurySettingsSchema,
  type UpdateTreasurySettingsDto,
  CreateCashAccountSchema,
  UpdateCashAccountSchema,
  ListCashAccountsQuerySchema,
  CreateCashFlowItemSchema,
  UpdateCashFlowItemSchema,
  ListCashFlowItemsQuerySchema,
  CreateCashFlowEntrySchema,
  StornoCashFlowEntrySchema,
  ListCashFlowEntriesQuerySchema,
  type CreateCashAccountDto,
  type UpdateCashAccountDto,
  type ListCashAccountsQuery,
  type CreateCashFlowItemDto,
  type UpdateCashFlowItemDto,
  type ListCashFlowItemsQuery,
  type CreateCashFlowEntryDto,
  type StornoCashFlowEntryDto,
  type ListCashFlowEntriesQuery,
} from '@sewing/shared/treasury';

import { ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import { CurrentUser, Roles } from '../auth/auth.decorators.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { TreasuryService } from './treasury.service.js';

/**
 * Контроллер модуля «Казначейство» (Фаза 0 — журнал ДДС).
 *
 * Endpoints:
 *   GET   /api/treasury/accounts
 *   GET   /api/treasury/accounts/:id
 *   POST  /api/treasury/accounts
 *   PATCH /api/treasury/accounts/:id
 *
 *   GET   /api/treasury/items
 *   POST  /api/treasury/items
 *   PATCH /api/treasury/items/:id
 *
 *   GET   /api/treasury/entries
 *   POST  /api/treasury/entries           (ручная проводка)
 *   POST  /api/treasury/entries/:id/storno
 *
 *   GET   /api/treasury/balances
 *
 * RBAC — `ADMIN` / `SHOP_MANAGER` (новые роли не вводим).
 */
@Controller('treasury')
@Roles('ADMIN', 'SHOP_MANAGER')
export class TreasuryController {
  constructor(private readonly treasury: TreasuryService) {}

  // --- Счета ---------------------------------------------------------------

  @Get('accounts')
  listAccounts(
    @Query(new ZodValidationPipe(ListCashAccountsQuerySchema))
    query: ListCashAccountsQuery,
  ) {
    return this.treasury.listAccounts(query);
  }

  @Get('accounts/:id')
  getAccount(@Param('id') id: string) {
    return this.treasury.getAccount(id);
  }

  @Post('accounts')
  createAccount(
    @Body(new ZodValidationPipe(CreateCashAccountSchema))
    body: CreateCashAccountDto,
  ) {
    return this.treasury.createAccount(body);
  }

  @Patch('accounts/:id')
  updateAccount(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(UpdateCashAccountSchema))
    body: UpdateCashAccountDto,
  ) {
    return this.treasury.updateAccount(id, body);
  }

  // --- Статьи ДДС ----------------------------------------------------------

  @Get('items')
  listItems(
    @Query(new ZodValidationPipe(ListCashFlowItemsQuerySchema))
    query: ListCashFlowItemsQuery,
  ) {
    return this.treasury.listItems(query);
  }

  @Post('items')
  createItem(
    @Body(new ZodValidationPipe(CreateCashFlowItemSchema))
    body: CreateCashFlowItemDto,
  ) {
    return this.treasury.createItem(body);
  }

  @Patch('items/:id')
  updateItem(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(UpdateCashFlowItemSchema))
    body: UpdateCashFlowItemDto,
  ) {
    return this.treasury.updateItem(id, body);
  }

  // --- Проводки журнала ----------------------------------------------------

  @Get('entries')
  listEntries(
    @Query(new ZodValidationPipe(ListCashFlowEntriesQuerySchema))
    query: ListCashFlowEntriesQuery,
  ) {
    return this.treasury.listEntries(query);
  }

  @Post('entries')
  createEntry(
    @Body(new ZodValidationPipe(CreateCashFlowEntrySchema))
    body: CreateCashFlowEntryDto,
    @CurrentUser() user: AuthPrincipal,
  ) {
    return this.treasury.createEntry(body, user.employeeId);
  }

  @Post('entries/:id/storno')
  storno(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(StornoCashFlowEntrySchema))
    body: StornoCashFlowEntryDto,
    @CurrentUser() user: AuthPrincipal,
  ) {
    return this.treasury.storno(id, body, user.employeeId);
  }

  // --- Остатки -------------------------------------------------------------

  @Get('balances')
  balances() {
    return this.treasury.balances();
  }

  // --- Настройки модуля ----------------------------------------------------

  @Get('settings')
  getSettings() {
    return this.treasury.getSettings();
  }

  @Put('settings')
  updateSettings(
    @Body(new ZodValidationPipe(UpdateTreasurySettingsSchema))
    body: UpdateTreasurySettingsDto,
  ) {
    return this.treasury.updateSettings(body);
  }
}
