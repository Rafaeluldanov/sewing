/**
 * Управленческий «Дашборд начальника производства».
 *
 * Read-only единый экран, который собирает KPI / pipeline / трейд /
 * простой / алерты в одном ответе `GET /api/dashboard/production`.
 * Не вводит ни новых таблиц, ни новых событий — переиспользует уже
 * работающие сервисы (`CostsModule` для себестоимости и длительностей
 * стадий, shopfloor projection для pipeline).
 */
import { Module } from '@nestjs/common';
import { CostsModule } from '../costs/costs.module.js';
import { DashboardController } from './dashboard.controller.js';
import { DashboardService } from './dashboard.service.js';

@Module({
  imports: [CostsModule],
  controllers: [DashboardController],
  providers: [DashboardService],
})
export class DashboardModule {}
