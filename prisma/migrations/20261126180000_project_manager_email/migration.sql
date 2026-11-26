-- MKACG-1017：项目经理卡与清单表显示邮箱，不再显示「平台账号」绑定状态。
--
-- 邮箱是项目经理自己的联系信息：新建与编辑弹窗里填，卡片第二行与清单表的「邮箱」列显示它。
-- 可空 —— 已有的行没有邮箱，界面显示「未填写邮箱」，不编一个假地址。
--
-- 存量数据从已绑定的平台账号回填一次：这些行的邮箱本来就在 `app_user.email` 里，
-- 回填后卡片立刻能显示真实地址，不用人工逐条补。

-- AlterTable
ALTER TABLE "project_manager" ADD COLUMN "email" TEXT;

-- 回填：已绑定平台账号的项目经理，邮箱取账号的邮箱。
UPDATE "project_manager" AS pm
SET "email" = u."email"
FROM "app_user" AS u
WHERE pm."user_id" = u."id" AND pm."email" IS NULL;
