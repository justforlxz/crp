-- A12 追加：CRP 调用记录表，以及 build_task 上的阻断说明两列。
--
-- 只追加，不改 A5 已定的字段与索引：
--
-- 1. `crp_call_log`：设计契约要求「每次对 CRP 的调用都有请求记录（URL、耗时、状态、响应摘要）可查」，
--    现有表里没有能放请求明细的地方。
-- 2. `build_task.blocked_by_snapshot_id` / `build_task.status_reason`：原表只有状态，
--    没有能说明「因上游 X 失败而阻断」的字段。
--
-- 两个归属列不加外键，与 `session.active_workspace_id` 同一处理方式。

-- CreateTable
CREATE TABLE "crp_call_log" (
    "id" TEXT NOT NULL,
    "release_id" TEXT,
    "snapshot_id" TEXT,
    "method" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "status_code" INTEGER,
    "duration_ms" INTEGER NOT NULL,
    "response_snippet" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "crp_call_log_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "build_task" ADD COLUMN     "blocked_by_snapshot_id" TEXT,
ADD COLUMN     "status_reason" TEXT;

-- CreateIndex
CREATE INDEX "crp_call_log_release_id_created_at_idx" ON "crp_call_log"("release_id", "created_at");

-- CreateIndex
CREATE INDEX "crp_call_log_snapshot_id_idx" ON "crp_call_log"("snapshot_id");
