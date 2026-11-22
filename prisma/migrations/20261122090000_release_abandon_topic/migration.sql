-- MKACG-950 追加：支持「放弃提测主题」。
--
-- 放弃主题是一个危险操作，要留一行「谁、什么时候、放弃的是哪个 Topic」的旁证。
-- A17 的 `release_update_record` 本来就是提测的人工操作留痕表，这里只追加一个动作值
-- 与一列 Topic ID，不改已有字段与索引。
--
-- `abandoned_topic_id` 允许为空：补包 / 换包那两行动作没有主题 ID，
-- 已有数据也不回填 —— 它们本来就不是放弃主题。

-- AlterEnum
ALTER TYPE "release_update_action" ADD VALUE 'abandon_topic';

-- AlterTable
ALTER TABLE "release_update_record" ADD COLUMN "abandoned_topic_id" TEXT;
