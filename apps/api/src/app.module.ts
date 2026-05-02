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
import { PayrollModule } from './modules/payroll/payroll.module.js';
import { EmployeesModule } from './modules/employees/employees.module.js';
import { CostsModule } from './modules/costs/costs.module.js';
import { DashboardModule } from './modules/dashboard/dashboard.module.js';
import { PrintersModule } from './modules/printers/printers.module.js';
import { RoutesModule } from './modules/routes/routes.module.js';
import { TechCardsModule } from './modules/tech-cards/tech-cards.module.js';
import { DisplayScreensModule } from './modules/display-screens/display-screens.module.js';
import { AuditModule } from './modules/audit/audit.module.js';
import { DiagnosticsModule } from './modules/diagnostics/diagnostics.module.js';
import { MasterCallsModule } from './modules/master-calls/master-calls.module.js';
import { MasterActionsModule } from './modules/master-actions/master-actions.module.js';
import { CutReleasePolicyModule } from './modules/cut-release-policy/cut-release-policy.module.js';
import { OrderCutIssueRulesModule } from './modules/order-cut-issue-rules/order-cut-issue-rules.module.js';
import { ClientsModule } from './modules/clients/clients.module.js';
import { CompanySettingsModule } from './modules/company-settings/company-settings.module.js';
import { PatternsModule } from './modules/patterns/patterns.module.js';
import { PatternCategoriesModule } from './modules/pattern-categories/pattern-categories.module.js';
import { WorkshopNeedsModule } from './modules/workshop-needs/workshop-needs.module.js';
import { SuppliersModule } from './modules/suppliers/suppliers.module.js';
import { PurchaseOrdersModule } from './modules/purchase-orders/purchase-orders.module.js';
import { PurchaseReceiptsModule } from './modules/purchase-receipts/purchase-receipts.module.js';
import { CutReadinessModule } from './modules/cut-readiness/cut-readiness.module.js';
import { OrderApplicationsModule } from './modules/order-applications/order-applications.module.js';
import { OrderMaterialArrivalsModule } from './modules/order-material-arrivals/order-material-arrivals.module.js';
import { SizesModule } from './modules/sizes/sizes.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    AuditModule,
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
    PayrollModule,
    EmployeesModule,
    CostsModule,
    DashboardModule,
    PrintersModule,
    RoutesModule,
    TechCardsModule,
    DisplayScreensModule,
    DiagnosticsModule,
    MasterCallsModule,
    MasterActionsModule,
    CutReleasePolicyModule,
    OrderCutIssueRulesModule,
    ClientsModule,
    CompanySettingsModule,
    PatternsModule,
    PatternCategoriesModule,
    WorkshopNeedsModule,
    SuppliersModule,
    PurchaseOrdersModule,
    PurchaseReceiptsModule,
    CutReadinessModule,
    OrderApplicationsModule,
    OrderMaterialArrivalsModule,
    SizesModule,
  ],
})
export class AppModule {}
