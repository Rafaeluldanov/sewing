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
import { PayrollPayoutsModule } from './modules/payroll-payouts/payroll-payouts.module.js';
import { EmployeesModule } from './modules/employees/employees.module.js';
import { CostsModule } from './modules/costs/costs.module.js';
import { DashboardModule } from './modules/dashboard/dashboard.module.js';
import { PrintersModule } from './modules/printers/printers.module.js';
import { RoutesModule } from './modules/routes/routes.module.js';
import { TechCardsModule } from './modules/tech-cards/tech-cards.module.js';
import { ConstructorTasksModule } from './modules/constructor-tasks/constructor-tasks.module.js';
import { CuttingTasksModule } from './modules/cutting-tasks/cutting-tasks.module.js';
import { DisplayScreensModule } from './modules/display-screens/display-screens.module.js';
import { AuditModule } from './modules/audit/audit.module.js';
import { DiagnosticsModule } from './modules/diagnostics/diagnostics.module.js';
import { MasterCallsModule } from './modules/master-calls/master-calls.module.js';
import { MasterActionsModule } from './modules/master-actions/master-actions.module.js';
import { ProductionBoardModule } from './modules/production-board/production-board.module.js';
import { MasterEmployeeStatsModule } from './modules/master-employee-stats/master-employee-stats.module.js';
import { TimeTrackingModule } from './modules/time-tracking/time-tracking.module.js';
import { CutReleasePolicyModule } from './modules/cut-release-policy/cut-release-policy.module.js';
import { OrderCutIssueRulesModule } from './modules/order-cut-issue-rules/order-cut-issue-rules.module.js';
import { ClientsModule } from './modules/clients/clients.module.js';
import { CompanySettingsModule } from './modules/company-settings/company-settings.module.js';
import { PatternsModule } from './modules/patterns/patterns.module.js';
import { PatternCategoriesModule } from './modules/pattern-categories/pattern-categories.module.js';
import { WorkshopNeedsModule } from './modules/workshop-needs/workshop-needs.module.js';
import { SuppliersModule } from './modules/suppliers/suppliers.module.js';
import { PurchaseOrdersModule } from './modules/purchase-orders/purchase-orders.module.js';
import { SupplierPaymentRequestsModule } from './modules/supplier-payment-requests/supplier-payment-requests.module.js';
import { PurchaseReceiptsModule } from './modules/purchase-receipts/purchase-receipts.module.js';
import { CutReadinessModule } from './modules/cut-readiness/cut-readiness.module.js';
import { OrderApplicationsModule } from './modules/order-applications/order-applications.module.js';
import { OrderMaterialArrivalsModule } from './modules/order-material-arrivals/order-material-arrivals.module.js';
import { OrderExtraCostsModule } from './modules/order-extra-costs/order-extra-costs.module.js';
import { SizesModule } from './modules/sizes/sizes.module.js';
import { PayrollAccrualDocumentsModule } from './modules/payroll-accrual-documents/payroll-accrual-documents.module.js';
import { MaterialIssuesModule } from './modules/material-issues/material-issues.module.js';
import { OrderSamplesModule } from './modules/order-samples/order-samples.module.js';
import { StockModule } from './modules/stock/stock.module.js';
import { FinishedGoodsModule } from './modules/finished-goods/finished-goods.module.js';
import { WorkInProgressModule } from './modules/work-in-progress/work-in-progress.module.js';
import { MeModule } from './modules/me/me.module.js';
import { BootstrapModule } from './modules/bootstrap/bootstrap.module.js';
import { PushModule } from './modules/push/push.module.js';
import { TreasuryModule } from './modules/treasury/treasury.module.js';
import { SuperadminModule } from './modules/superadmin/superadmin.module.js';

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
    PayrollPayoutsModule,
    EmployeesModule,
    CostsModule,
    TreasuryModule,
    DashboardModule,
    PrintersModule,
    RoutesModule,
    TechCardsModule,
    ConstructorTasksModule,
    CuttingTasksModule,
    DisplayScreensModule,
    DiagnosticsModule,
    MasterCallsModule,
    MasterActionsModule,
    ProductionBoardModule,
    MasterEmployeeStatsModule,
    TimeTrackingModule,
    CutReleasePolicyModule,
    OrderCutIssueRulesModule,
    ClientsModule,
    CompanySettingsModule,
    PatternsModule,
    PatternCategoriesModule,
    WorkshopNeedsModule,
    SuppliersModule,
    PurchaseOrdersModule,
    SupplierPaymentRequestsModule,
    PurchaseReceiptsModule,
    CutReadinessModule,
    OrderApplicationsModule,
    OrderMaterialArrivalsModule,
    OrderExtraCostsModule,
    SizesModule,
    PayrollAccrualDocumentsModule,
    MaterialIssuesModule,
    OrderSamplesModule,
    StockModule,
    FinishedGoodsModule,
    WorkInProgressModule,
    MeModule,
    BootstrapModule,
    PushModule,
    SuperadminModule,
  ],
})
export class AppModule {}
