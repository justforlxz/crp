-- MKACG-912：投递用的架构集合来自基线，不再写死在代码里。
--
-- 只追加一列，可空语义由默认值表达、不加唯一约束、不改已有列的含义：
--   - 默认空数组表示「这条基线还没有架构列表」，投递时直接报错，不退回代码里的默认架构；
--   - 不需要回填历史数据：下一次基线同步会写入；回滚就是删掉这一列。
--
-- 为什么需要它：投递 Release 的 `Arches` 原本是常量 `amd64;mips64el;arm64;sw64;loong64`，
-- 在 `eagle-1071` 上 CRP 会因为 `sw64`、`loong64` 这两个名字在 apply 阶段直接失败，
-- 一个构建作业都不起（实测见 lib/integrations/crp/FINDINGS.md 第十二节）。

-- AlterTable
ALTER TABLE "baseline" ADD COLUMN "arches" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
