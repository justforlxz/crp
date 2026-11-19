-- A14 追加：构建调度事件流水表。
--
-- 只追加，不改 A5 已定的字段与索引。
--
-- 设计契约 MUST 要求「调度事件流水记录：时间、软件包、事件、触发条件、结果」。
-- 现有表都不适合：`crp_call_log` 记单个 CRP 请求，`sync_run` 记一整批同步，
-- `build_task` 只保留最新状态。
--
-- `release_id` 建外键并级联删除：事件属于一次提测，提测被清理时流水跟着走；
-- 队列页要按工作区查流水，靠这条外键做关联查询。

-- CreateTable
CREATE TABLE "build_poll_event" (
    "id" TEXT NOT NULL,
    "release_id" TEXT NOT NULL,
    "snapshot_id" TEXT,
    "package_name" TEXT,
    "event" TEXT NOT NULL,
    "condition" TEXT NOT NULL,
    "result" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "build_poll_event_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "build_poll_event_release_id_created_at_idx" ON "build_poll_event"("release_id", "created_at");

-- CreateIndex
CREATE INDEX "build_poll_event_created_at_idx" ON "build_poll_event"("created_at");

-- AddForeignKey
ALTER TABLE "build_poll_event" ADD CONSTRAINT "build_poll_event_release_id_fkey" FOREIGN KEY ("release_id") REFERENCES "release"("id") ON DELETE CASCADE ON UPDATE CASCADE;
