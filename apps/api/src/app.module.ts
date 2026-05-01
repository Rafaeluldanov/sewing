import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from './prisma/prisma.module.js';
import { OrdersModule } from './modules/orders/orders.module.js';
import { CatalogModule } from './modules/catalog/catalog.module.js';
import { PassportsModule } from './modules/passports/passports.module.js';
import { ShiftsModule } from './modules/shifts/shifts.module.js';
import { QcModule } from './modules/qc/qc.module.js';
import { WtoModule } from './modules/wto/wto.module.js';
import { PackingModule } from './modules/packing/packing.module.js';
import { EarningsModule } from './modules/earnings/earnings.module.js';
import { ShopfloorModule } from './modules/shopfloor/shopfloor.module.js';
import { AdminModule } from './modules/admin/admin.module.js';
import { EquipmentModule } from './modules/equipment/equipment.module.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { HealthModule } from './modules/health/health.module.js';
import { CuttingClosureModule } from './modules/cutting-closure/cutting-closure.module.js';
import { WarehousesModule } from './modules/warehouses/warehouses.module.js';
import { OperationsModule } from './modules/operations/operations.module.js';
import { SalaryModule } from './modules/salary/salary.module.js';
import { EmployeesModule } from './modules/employees/employees.module.js';
import { CostsModule } from './modules/costs/costs.module.js';
import { DashboardModule } from './modules/dashboard/dashboard.module.js';
import { PrintersModule } from './modules/printers/printers.module.js';
import { RoutesModule } from './modules/routes/routes.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    AuthModule,
    HealthModule,
    CatalogModule,
    OrdersModule,
    PassportsModule,
    CuttingClosureModule,
    ShiftsModule,
    QcModule,
    WtoModule,
    PackingModule,
    EarningsModule,
    ShopfloorModule,
    AdminModule,
    EquipmentModule,
    WarehousesModule,
    OperationsModule,
    SalaryModule,
    EmployeesModule,
    CostsModule,
    DashboardModule,
    PrintersModule,
    RoutesModule,
  ],
})
export class AppModule {}
