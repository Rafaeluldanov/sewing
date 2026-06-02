-- CreateTable
CREATE TABLE "CuttingTask" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'NEW',
    "assignedToId" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CuttingTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CuttingTaskSizeRow" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL,
    "sizeId" TEXT,
    "sizeCodeSnapshot" TEXT NOT NULL,
    "qtyPlan" INTEGER NOT NULL,
    "perLayerQty" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "CuttingTaskSizeRow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CuttingTaskRoll" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "layers" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "CuttingTaskRoll_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CuttingTask_orderId_key" ON "CuttingTask"("orderId");

-- CreateIndex
CREATE INDEX "CuttingTask_status_idx" ON "CuttingTask"("status");

-- CreateIndex
CREATE INDEX "CuttingTaskSizeRow_taskId_sortOrder_idx" ON "CuttingTaskSizeRow"("taskId", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "CuttingTaskSizeRow_taskId_sizeId_key" ON "CuttingTaskSizeRow"("taskId", "sizeId");

-- CreateIndex
CREATE INDEX "CuttingTaskRoll_taskId_ordinal_idx" ON "CuttingTaskRoll"("taskId", "ordinal");

-- CreateIndex
CREATE UNIQUE INDEX "CuttingTaskRoll_taskId_ordinal_key" ON "CuttingTaskRoll"("taskId", "ordinal");

-- AddForeignKey
ALTER TABLE "CuttingTask" ADD CONSTRAINT "CuttingTask_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CuttingTask" ADD CONSTRAINT "CuttingTask_assignedToId_fkey" FOREIGN KEY ("assignedToId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CuttingTaskSizeRow" ADD CONSTRAINT "CuttingTaskSizeRow_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "CuttingTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CuttingTaskSizeRow" ADD CONSTRAINT "CuttingTaskSizeRow_sizeId_fkey" FOREIGN KEY ("sizeId") REFERENCES "Size"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CuttingTaskRoll" ADD CONSTRAINT "CuttingTaskRoll_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "CuttingTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;

