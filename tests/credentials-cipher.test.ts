/**
 * 凭据密文的加解密（MKACG-986）。
 *
 * 这一层是纯函数，不连库、不发请求，锁住契约第五节的三条：
 *
 * - 主密钥只从环境变量来，缺了或格式不对就直接报错（不退回默认密钥）；
 * - AAD 绑定「谁 + 哪一套系统」，把 A 的密文抄进 B 的名下就解不开（CRED-8）；
 * - 明文只活在内存里，密文与错误消息里都不出现明文。
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  credentialAad,
  decryptSecret,
  encryptSecret,
  readMasterKey,
  type MasterKey,
} from "../lib/credentials/cipher";
import { CredentialDecryptError, CredentialKeyError } from "../lib/credentials/errors";

/** 一把固定的测试主密钥：32 字节的 base64。 */
const TEST_KEY = Buffer.alloc(32, 7).toString("base64");
const MASTER: MasterKey = { key: Buffer.alloc(32, 7), version: 1 };

const USER_A = "0199aaaa-0000-7000-8000-000000000001";
const USER_B = "0199aaaa-0000-7000-8000-000000000002";

test("加密再解密拿回原密码", () => {
  const sealed = encryptSecret("s3cr3t-密码", {
    userId: USER_A,
    kind: "crp",
    master: MASTER,
  });

  assert.equal(
    decryptSecret({ ...sealed, userId: USER_A, kind: "crp" }, MASTER),
    "s3cr3t-密码",
  );
});

test("CRED-8：A 的密文抄进 B 的名下解不开", () => {
  const sealed = encryptSecret("a-only", { userId: USER_A, kind: "crp", master: MASTER });

  assert.throws(
    () => decryptSecret({ ...sealed, userId: USER_B, kind: "crp" }, MASTER),
    (error: unknown) => {
      assert.ok(error instanceof CredentialDecryptError);
      // 报错要说清「这条密文不属于当前账号」，但不能带出明文。
      assert.match(error.message, /不属于当前账号|主密钥不匹配/);
      assert.ok(!error.message.includes("a-only"));
      return true;
    },
  );
});

test("把 CRP 的密文挪到 Gerrit 名下同样解不开", () => {
  const sealed = encryptSecret("crp-only", { userId: USER_A, kind: "crp", master: MASTER });

  assert.throws(
    () => decryptSecret({ ...sealed, userId: USER_A, kind: "gerrit" }, MASTER),
    CredentialDecryptError,
  );
});

test("AAD 用换行分隔两个字段，不会把不同的组合拼成同一串", () => {
  assert.notDeepEqual(credentialAad("ab", "crp"), credentialAad("a", "crp"));
  assert.notDeepEqual(credentialAad(USER_A, "crp"), credentialAad(USER_A, "gerrit"));
});

test("主密钥版本对不上时不拿错密钥硬解", () => {
  const sealed = encryptSecret("old", { userId: USER_A, kind: "crp", master: MASTER });

  assert.throws(
    () =>
      decryptSecret(
        { ...sealed, userId: USER_A, kind: "crp" },
        { key: MASTER.key, version: 2 },
      ),
    (error: unknown) => {
      assert.ok(error instanceof CredentialDecryptError);
      assert.match(error.message, /密钥版本/);
      return true;
    },
  );
});

test("密文里不含明文，同一密码每次加密的向量与标签都不同", () => {
  const first = encryptSecret("same-password", {
    userId: USER_A,
    kind: "crp",
    master: MASTER,
  });
  const second = encryptSecret("same-password", {
    userId: USER_A,
    kind: "crp",
    master: MASTER,
  });

  const raw = Buffer.from(first.ciphertext, "base64").toString("utf8");
  assert.ok(!raw.includes("same-password"));
  assert.notEqual(first.iv, second.iv);
  assert.notEqual(first.tag, second.tag);
  assert.notEqual(first.ciphertext, second.ciphertext);
});

test("缺少主密钥时直接报错，并指出是哪个环境变量", () => {
  assert.throws(
    () => readMasterKey({}),
    (error: unknown) => {
      assert.ok(error instanceof CredentialKeyError);
      assert.match(error.message, /CREDENTIAL_ENCRYPTION_KEY/);
      return true;
    },
  );
});

test("主密钥不是 32 字节时同样报错，不截断也不补齐", () => {
  for (const raw of [Buffer.alloc(16, 1).toString("base64"), "not-base64", "aGk="]) {
    assert.throws(() => readMasterKey({ CREDENTIAL_ENCRYPTION_KEY: raw }), CredentialKeyError);
  }
});

test("读得到主密钥与版本；版本不填按 1，填了不是正整数就报错", () => {
  assert.deepEqual(readMasterKey({ CREDENTIAL_ENCRYPTION_KEY: TEST_KEY }), {
    key: Buffer.alloc(32, 7),
    version: 1,
  });
  assert.equal(
    readMasterKey({ CREDENTIAL_ENCRYPTION_KEY: TEST_KEY, CREDENTIAL_ENCRYPTION_KEY_VERSION: "3" })
      .version,
    3,
  );
  assert.throws(
    () =>
      readMasterKey({
        CREDENTIAL_ENCRYPTION_KEY: TEST_KEY,
        CREDENTIAL_ENCRYPTION_KEY_VERSION: "0",
      }),
    CredentialKeyError,
  );
});
