-- Webhook 端点名称，以及投递日志的 HTTP 状态、耗时、响应摘要（A8 节点追加）。
--
-- `name` 是必填列，直接 ADD COLUMN 在已有数据的库上会失败。这里先带默认值加列，
-- 用 URL 回填历史行，再删掉默认值：空库和已有数据的库都能跑通同一条迁移。

-- AlterTable
ALTER TABLE "webhook_delivery" ADD COLUMN     "duration_ms" INTEGER,
ADD COLUMN     "http_status" INTEGER,
ADD COLUMN     "response_snippet" TEXT;

-- AlterTable
ALTER TABLE "webhook_endpoint" ADD COLUMN     "name" TEXT NOT NULL DEFAULT '';
UPDATE "webhook_endpoint" SET "name" = "url" WHERE "name" = '';
ALTER TABLE "webhook_endpoint" ALTER COLUMN "name" DROP DEFAULT;
