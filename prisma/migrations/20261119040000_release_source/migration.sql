-- A18 追加：提测记录的来源。
--
-- 只追加一列，不改 A5 / A11 / A17 已有字段：从 CRP 导入的提测与平台创建出来的提测
-- 在后续流程里行为一致，但列表与详情要能标出「这条是从 CRP 接管进来的」。
--
-- 默认值 `platform`：已有的行全部是平台创建的，补列不需要回填脚本。

-- CreateEnum
CREATE TYPE "release_source" AS ENUM ('platform', 'imported');

-- AlterTable
ALTER TABLE "release" ADD COLUMN "source" "release_source" NOT NULL DEFAULT 'platform';
