-- A16 缺陷修复：软件包名与 CRP 项目名不是一个名字，显式存下后者。
--
-- 只追加一列，可空、不加唯一约束、不改已有列的含义：
--   - 为空表示「与包名相同」，也就是本迁移之前的全部行为原样保留；
--   - 不需要回填历史数据，回滚就是删掉这一列。
--
-- 为什么需要它：CRP 的项目名带下划线（`deepin-kde/kwin` 与 `deepin-kde/wayland` 在
-- CRP 上只有带下划线的项目名），而 `name` 必须是 Debian 源码包名、不允许下划线。
-- 没有这一列时，投递按包名查 CRP 项目一定查不到，导入也落不回本地软件包。

-- AlterTable
ALTER TABLE "package" ADD COLUMN "crp_project_name" TEXT;
