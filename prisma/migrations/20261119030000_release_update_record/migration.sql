-- A17 追加：提测增量更新的留痕表与动作枚举。
--
-- 只追加，不改 A5 / A12 已有字段：
-- 「每轮变更留痕：谁、什么时候、加了什么、放弃了什么、重投了什么」在现有表里没有落点。
-- `sync_run` 是同步类记录（基线、软件包元数据、提测状态），不适合承载人工操作。
--
-- 两个列表列都存包名 / Release ID 的原文，不做外键：留痕是复盘用的旁证，
-- 被删掉的 CRP Release 与后来改名的包也不该让这行失效。

-- CreateEnum
CREATE TYPE "release_update_action" AS ENUM ('append', 'replace');

-- CreateTable
CREATE TABLE "release_update_record" (
    "id" TEXT NOT NULL,
    "release_id" TEXT NOT NULL,
    "operator_id" TEXT NOT NULL,
    "action" "release_update_action" NOT NULL,
    "package_names" TEXT[],
    "revision_before" INTEGER NOT NULL,
    "revision_after" INTEGER NOT NULL,
    "abandoned_crp_release_ids" TEXT[],
    "redispatched_package_names" TEXT[],
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "release_update_record_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "release_update_record_release_id_created_at_idx" ON "release_update_record"("release_id", "created_at");

-- AddForeignKey
ALTER TABLE "release_update_record" ADD CONSTRAINT "release_update_record_release_id_fkey" FOREIGN KEY ("release_id") REFERENCES "release"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "release_update_record" ADD CONSTRAINT "release_update_record_operator_id_fkey" FOREIGN KEY ("operator_id") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
