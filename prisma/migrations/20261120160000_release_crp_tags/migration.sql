-- MKACG-929：CRP 侧的版本号与我们的提测版本不一定相同。
--
-- `BaseTag` 是我们提交的值，`Tag` 是 CRP 自己记的那份（实测形态见
-- lib/integrations/crp/FINDINGS.md 第 6.1 节：末位数字加一、追加序号、带 suffix）。
-- 只追加两列，可空、不加约束、不改已有列：
--   - 两列为空表示「还没从 CRP 同步过 Tag」，与本迁移之前的行为一致；
--   - 不需要回填历史数据，回滚就是删掉这两列。
-- `release_package_snapshot.release_version` 不动：那是我们提交的值。

-- AlterTable
ALTER TABLE "release_repository_record" ADD COLUMN "crp_base_tag" TEXT;
ALTER TABLE "release_repository_record" ADD COLUMN "crp_tag" TEXT;
