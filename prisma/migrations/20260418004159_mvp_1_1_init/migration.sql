-- CreateEnum
CREATE TYPE "Role" AS ENUM ('SHOP_MANAGER', 'CUTTER', 'CUTTER_ASSISTANT', 'SEAMSTRESS', 'QC', 'IRONING', 'PACKING', 'ADMIN');

-- CreateEnum
CREATE TYPE "OperationCategory" AS ENUM ('CUTTING', 'SEWING', 'QC', 'IRONING', 'PACKING');

-- CreateEnum
CREATE TYPE "PaymentType" AS ENUM ('SALARY', 'PIECEWORK');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('DRAFT', 'IN_PRODUCTION', 'DONE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PassportStatus" AS ENUM ('CREATED', 'IN_PROGRESS', 'PACKED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PassportEventType" AS ENUM ('CREATED', 'OPERATION_STARTED', 'OPERATION_FINISHED', 'MOVED', 'DEFECT_RECORDED', 'CELL_PLACED', 'CELL_REMOVED', 'ISSUED_TO_EMPLOYEE', 'OPERATION_SCAN', 'PACKED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "EntryStatus" AS ENUM ('PENDING', 'PENDING_RELEASE', 'APPROVED', 'CANCELLED', 'REVERSED');

-- CreateEnum
CREATE TYPE "ApprovalMode" AS ENUM ('IMMEDIATE', 'AFTER_RELEASE');

-- CreateEnum
CREATE TYPE "EarningSource" AS ENUM ('PASSPORT_CREATED', 'OPERATION_TRANSITION');

-- CreateTable
CREATE TABLE "Size" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Size_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Product" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Operation" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" "OperationCategory" NOT NULL,
    "sortOrder" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Operation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Employee" (
    "id" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "login" TEXT NOT NULL,
    "pinHash" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "paymentType" "PaymentType" NOT NULL,
    "salaryBase" DECIMAL(12,2),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Employee_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Equipment" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "qrCode" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Equipment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShiftSession" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "equipmentId" TEXT NOT NULL,
    "operationId" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),

    CONSTRAINT "ShiftSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Order" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "customer" TEXT,
    "orderDate" TIMESTAMP(3) NOT NULL,
    "dueDate" TIMESTAMP(3),
    "color" TEXT,
    "comment" TEXT,
    "status" "OrderStatus" NOT NULL DEFAULT 'DRAFT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderItem" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "sizeId" TEXT NOT NULL,
    "qtyPlan" INTEGER NOT NULL,

    CONSTRAINT "OrderItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Passport" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "qrCode" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "sizeId" TEXT NOT NULL,
    "color" TEXT NOT NULL,
    "rollNumber" TEXT NOT NULL,
    "cutDate" TIMESTAMP(3) NOT NULL,
    "qtyPlan" INTEGER NOT NULL,
    "qtyCut" INTEGER NOT NULL,
    "qtyDefect" INTEGER NOT NULL DEFAULT 0,
    "qtyGood" INTEGER NOT NULL,
    "status" "PassportStatus" NOT NULL DEFAULT 'CREATED',
    "currentOperationId" TEXT,
    "currentEmployeeId" TEXT,
    "currentCellId" TEXT,
    "cutterId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "pdfUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Passport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PassportEvent" (
    "id" TEXT NOT NULL,
    "passportId" TEXT NOT NULL,
    "type" "PassportEventType" NOT NULL,
    "operationId" TEXT,
    "fromOperationId" TEXT,
    "employeeId" TEXT,
    "qty" INTEGER,
    "defectQty" INTEGER,
    "cellId" TEXT,
    "boxId" TEXT,
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PassportEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OperationEntry" (
    "id" TEXT NOT NULL,
    "passportId" TEXT NOT NULL,
    "operationId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "qty" INTEGER NOT NULL,
    "ratePerUnit" DECIMAL(12,2) NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "status" "EntryStatus" NOT NULL DEFAULT 'PENDING_RELEASE',
    "approvalMode" "ApprovalMode" NOT NULL DEFAULT 'AFTER_RELEASE',
    "sourceEventType" "EarningSource" NOT NULL DEFAULT 'OPERATION_TRANSITION',
    "sourceEventId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedAt" TIMESTAMP(3),

    CONSTRAINT "OperationEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PieceRate" (
    "id" TEXT NOT NULL,
    "operationId" TEXT NOT NULL,
    "productId" TEXT,
    "sizeId" TEXT,
    "ratePerUnit" DECIMAL(12,2) NOT NULL,
    "validFrom" TIMESTAMP(3) NOT NULL,
    "validTo" TIMESTAMP(3),

    CONSTRAINT "PieceRate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Cell" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "qrCode" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Cell_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CellContent" (
    "id" TEXT NOT NULL,
    "cellId" TEXT NOT NULL,
    "sizeId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "CellContent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Box" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "qrCode" TEXT NOT NULL,
    "totalQty" INTEGER NOT NULL DEFAULT 0,
    "maxQty" INTEGER NOT NULL DEFAULT 100,
    "closedAt" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Box_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BoxItem" (
    "id" TEXT NOT NULL,
    "boxId" TEXT NOT NULL,
    "passportId" TEXT NOT NULL,
    "qty" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BoxItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DefectType" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DefectType_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PassportDefect" (
    "id" TEXT NOT NULL,
    "passportId" TEXT NOT NULL,
    "defectTypeId" TEXT NOT NULL,
    "qty" INTEGER NOT NULL,
    "comment" TEXT,
    "createdByEmployeeId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PassportDefect_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Size_code_key" ON "Size"("code");

-- CreateIndex
CREATE UNIQUE INDEX "Operation_code_key" ON "Operation"("code");

-- CreateIndex
CREATE INDEX "Operation_sortOrder_idx" ON "Operation"("sortOrder");

-- CreateIndex
CREATE INDEX "Operation_category_idx" ON "Operation"("category");

-- CreateIndex
CREATE UNIQUE INDEX "Employee_login_key" ON "Employee"("login");

-- CreateIndex
CREATE INDEX "Employee_role_idx" ON "Employee"("role");

-- CreateIndex
CREATE UNIQUE INDEX "Equipment_code_key" ON "Equipment"("code");

-- CreateIndex
CREATE UNIQUE INDEX "Equipment_qrCode_key" ON "Equipment"("qrCode");

-- CreateIndex
CREATE INDEX "ShiftSession_employeeId_endedAt_idx" ON "ShiftSession"("employeeId", "endedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Order_number_key" ON "Order"("number");

-- CreateIndex
CREATE INDEX "Order_status_idx" ON "Order"("status");

-- CreateIndex
CREATE INDEX "Order_orderDate_idx" ON "Order"("orderDate");

-- CreateIndex
CREATE INDEX "Order_createdAt_idx" ON "Order"("createdAt");

-- CreateIndex
CREATE INDEX "OrderItem_productId_sizeId_idx" ON "OrderItem"("productId", "sizeId");

-- CreateIndex
CREATE UNIQUE INDEX "OrderItem_orderId_productId_sizeId_key" ON "OrderItem"("orderId", "productId", "sizeId");

-- CreateIndex
CREATE UNIQUE INDEX "Passport_number_key" ON "Passport"("number");

-- CreateIndex
CREATE UNIQUE INDEX "Passport_qrCode_key" ON "Passport"("qrCode");

-- CreateIndex
CREATE INDEX "Passport_status_currentOperationId_idx" ON "Passport"("status", "currentOperationId");

-- CreateIndex
CREATE INDEX "Passport_orderId_idx" ON "Passport"("orderId");

-- CreateIndex
CREATE INDEX "Passport_sizeId_status_idx" ON "Passport"("sizeId", "status");

-- CreateIndex
CREATE INDEX "Passport_createdAt_idx" ON "Passport"("createdAt");

-- CreateIndex
CREATE INDEX "Passport_currentCellId_idx" ON "Passport"("currentCellId");

-- CreateIndex
CREATE INDEX "PassportEvent_passportId_createdAt_idx" ON "PassportEvent"("passportId", "createdAt");

-- CreateIndex
CREATE INDEX "PassportEvent_type_createdAt_idx" ON "PassportEvent"("type", "createdAt");

-- CreateIndex
CREATE INDEX "PassportEvent_operationId_createdAt_idx" ON "PassportEvent"("operationId", "createdAt");

-- CreateIndex
CREATE INDEX "OperationEntry_employeeId_status_createdAt_idx" ON "OperationEntry"("employeeId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "OperationEntry_status_createdAt_idx" ON "OperationEntry"("status", "createdAt");

-- CreateIndex
CREATE INDEX "OperationEntry_passportId_idx" ON "OperationEntry"("passportId");

-- CreateIndex
CREATE UNIQUE INDEX "OperationEntry_passportId_operationId_employeeId_sourceEven_key" ON "OperationEntry"("passportId", "operationId", "employeeId", "sourceEventType");

-- CreateIndex
CREATE INDEX "PieceRate_operationId_productId_sizeId_validFrom_idx" ON "PieceRate"("operationId", "productId", "sizeId", "validFrom");

-- CreateIndex
CREATE UNIQUE INDEX "Cell_code_key" ON "Cell"("code");

-- CreateIndex
CREATE UNIQUE INDEX "Cell_qrCode_key" ON "Cell"("qrCode");

-- CreateIndex
CREATE UNIQUE INDEX "CellContent_cellId_sizeId_key" ON "CellContent"("cellId", "sizeId");

-- CreateIndex
CREATE UNIQUE INDEX "Box_number_key" ON "Box"("number");

-- CreateIndex
CREATE UNIQUE INDEX "Box_qrCode_key" ON "Box"("qrCode");

-- CreateIndex
CREATE INDEX "Box_closedAt_idx" ON "Box"("closedAt");

-- CreateIndex
CREATE UNIQUE INDEX "BoxItem_passportId_key" ON "BoxItem"("passportId");

-- CreateIndex
CREATE UNIQUE INDEX "BoxItem_boxId_passportId_key" ON "BoxItem"("boxId", "passportId");

-- CreateIndex
CREATE UNIQUE INDEX "DefectType_code_key" ON "DefectType"("code");

-- CreateIndex
CREATE INDEX "DefectType_sortOrder_idx" ON "DefectType"("sortOrder");

-- CreateIndex
CREATE INDEX "PassportDefect_passportId_createdAt_idx" ON "PassportDefect"("passportId", "createdAt");

-- CreateIndex
CREATE INDEX "PassportDefect_defectTypeId_createdAt_idx" ON "PassportDefect"("defectTypeId", "createdAt");

-- AddForeignKey
ALTER TABLE "ShiftSession" ADD CONSTRAINT "ShiftSession_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShiftSession" ADD CONSTRAINT "ShiftSession_equipmentId_fkey" FOREIGN KEY ("equipmentId") REFERENCES "Equipment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShiftSession" ADD CONSTRAINT "ShiftSession_operationId_fkey" FOREIGN KEY ("operationId") REFERENCES "Operation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_sizeId_fkey" FOREIGN KEY ("sizeId") REFERENCES "Size"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Passport" ADD CONSTRAINT "Passport_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Passport" ADD CONSTRAINT "Passport_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Passport" ADD CONSTRAINT "Passport_sizeId_fkey" FOREIGN KEY ("sizeId") REFERENCES "Size"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Passport" ADD CONSTRAINT "Passport_currentOperationId_fkey" FOREIGN KEY ("currentOperationId") REFERENCES "Operation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Passport" ADD CONSTRAINT "Passport_currentEmployeeId_fkey" FOREIGN KEY ("currentEmployeeId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Passport" ADD CONSTRAINT "Passport_currentCellId_fkey" FOREIGN KEY ("currentCellId") REFERENCES "Cell"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Passport" ADD CONSTRAINT "Passport_cutterId_fkey" FOREIGN KEY ("cutterId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Passport" ADD CONSTRAINT "Passport_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PassportEvent" ADD CONSTRAINT "PassportEvent_passportId_fkey" FOREIGN KEY ("passportId") REFERENCES "Passport"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PassportEvent" ADD CONSTRAINT "PassportEvent_operationId_fkey" FOREIGN KEY ("operationId") REFERENCES "Operation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PassportEvent" ADD CONSTRAINT "PassportEvent_fromOperationId_fkey" FOREIGN KEY ("fromOperationId") REFERENCES "Operation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PassportEvent" ADD CONSTRAINT "PassportEvent_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PassportEvent" ADD CONSTRAINT "PassportEvent_cellId_fkey" FOREIGN KEY ("cellId") REFERENCES "Cell"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PassportEvent" ADD CONSTRAINT "PassportEvent_boxId_fkey" FOREIGN KEY ("boxId") REFERENCES "Box"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OperationEntry" ADD CONSTRAINT "OperationEntry_passportId_fkey" FOREIGN KEY ("passportId") REFERENCES "Passport"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OperationEntry" ADD CONSTRAINT "OperationEntry_operationId_fkey" FOREIGN KEY ("operationId") REFERENCES "Operation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OperationEntry" ADD CONSTRAINT "OperationEntry_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PieceRate" ADD CONSTRAINT "PieceRate_operationId_fkey" FOREIGN KEY ("operationId") REFERENCES "Operation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PieceRate" ADD CONSTRAINT "PieceRate_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PieceRate" ADD CONSTRAINT "PieceRate_sizeId_fkey" FOREIGN KEY ("sizeId") REFERENCES "Size"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CellContent" ADD CONSTRAINT "CellContent_cellId_fkey" FOREIGN KEY ("cellId") REFERENCES "Cell"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CellContent" ADD CONSTRAINT "CellContent_sizeId_fkey" FOREIGN KEY ("sizeId") REFERENCES "Size"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Box" ADD CONSTRAINT "Box_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BoxItem" ADD CONSTRAINT "BoxItem_boxId_fkey" FOREIGN KEY ("boxId") REFERENCES "Box"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BoxItem" ADD CONSTRAINT "BoxItem_passportId_fkey" FOREIGN KEY ("passportId") REFERENCES "Passport"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PassportDefect" ADD CONSTRAINT "PassportDefect_passportId_fkey" FOREIGN KEY ("passportId") REFERENCES "Passport"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PassportDefect" ADD CONSTRAINT "PassportDefect_defectTypeId_fkey" FOREIGN KEY ("defectTypeId") REFERENCES "DefectType"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PassportDefect" ADD CONSTRAINT "PassportDefect_createdByEmployeeId_fkey" FOREIGN KEY ("createdByEmployeeId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;
