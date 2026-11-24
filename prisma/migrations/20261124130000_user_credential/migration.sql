-- MKACG-986 追加：CRP 与 Gerrit 凭据改为按人存放。
--
-- 改造前全平台共用一个环境变量账号，CRP 侧看到的提交人永远是同一个人，审计链断掉；
-- 那个人的密码一改，全平台提测一起挂。这一张表让每个成员存自己的凭据，平台按当前
-- 操作人调用，后台作业按提测的创建者调用。
--
-- 密码只存密文（AES-256-GCM）：`secret_ciphertext` / `secret_iv` / `secret_tag` 三件套，
-- AAD 绑定 `user_id + kind`，把 A 的密文挪到 B 名下会解密失败。明文不入库、不出接口。
--
-- `key_version` 给主密钥轮换用：解密时版本对不上直接报错，不拿错密钥硬解。

-- CreateEnum
CREATE TYPE "credential_kind" AS ENUM ('crp', 'gerrit');

-- CreateTable
CREATE TABLE "user_credential" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "kind" "credential_kind" NOT NULL,
    "username" TEXT NOT NULL,
    "secret_ciphertext" TEXT NOT NULL,
    "secret_iv" TEXT NOT NULL,
    "secret_tag" TEXT NOT NULL,
    "key_version" INTEGER NOT NULL,
    "verified_at" TIMESTAMPTZ(3),
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "user_credential_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_credential_user_id_kind_key" ON "user_credential"("user_id", "kind");

-- AddForeignKey
ALTER TABLE "user_credential" ADD CONSTRAINT "user_credential_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
