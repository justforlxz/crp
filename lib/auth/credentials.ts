/**
 * 账号凭据：邮箱归一化与密码哈希。
 *
 * 密码用 Argon2id，参数取 OWASP 推荐的最低档（19 MiB 内存、2 轮、单线程）。
 * 盐由算法每次随机生成并写进结果串，所以同一个密码两次哈希结果不同，
 * 校验只认 `$argon2id$...` 这种自带盐与参数的编码串。
 *
 * 本模块不碰数据库、不打日志：明文密码与哈希都不出现在任何输出里。
 */
import { hash, verify } from "@node-rs/argon2";

/**
 * Argon2id 参数：内存 19 MiB、2 轮、1 线程。
 *
 * 不传 `algorithm`：`@node-rs/argon2` 的默认值就是 Argon2id，而它的枚举是 const enum，
 * 在 `isolatedModules` 下不能跨模块取值。参数会写进哈希串本身，改这里不影响历史哈希的校验。
 */
const PASSWORD_HASH_OPTIONS = {
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

/** 密码最短长度。第一版不做复杂度规则，只挡住过短的密码。 */
export const PASSWORD_MIN_LENGTH = 8;

/** 邮箱归一化：去首尾空白并转小写，同一邮箱不会因大小写注册出两个账号。 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** 邮箱地址的长度上限，取 RFC 5321 的 254 字符。超长的一律当格式错误，不进入任何查库与计数。 */
export const EMAIL_MAX_LENGTH = 254;

/** 邮箱格式校验。故意写得宽松：只要求「有且只有一个 @、两侧非空、域名含点」，外加长度上限。 */
export function isValidEmail(email: string): boolean {
  const value = normalizeEmail(email);
  const at = value.indexOf("@");

  if (value.length === 0 || value.length > EMAIL_MAX_LENGTH) {
    return false;
  }

  if (at <= 0 || at !== value.lastIndexOf("@") || at === value.length - 1) {
    return false;
  }

  const domain = value.slice(at + 1);
  return !value.includes(" ") && domain.includes(".") && !domain.startsWith(".") && !domain.endsWith(".");
}

/** 密码校验：返回错误文案，通过时返回 null。文案会直接进接口响应，不要写内部细节。 */
export function validatePassword(password: string): string | null {
  if (typeof password !== "string" || password.length < PASSWORD_MIN_LENGTH) {
    return `密码至少 ${PASSWORD_MIN_LENGTH} 个字符`;
  }

  return null;
}

/** 生成哈希。空密码直接拒绝，避免库里出现「空密码也能校验通过」的行。 */
export async function hashPassword(password: string): Promise<string> {
  if (typeof password !== "string" || password.length === 0) {
    throw new Error("密码不能为空");
  }

  return hash(password, PASSWORD_HASH_OPTIONS);
}

/**
 * 校验密码。
 *
 * 哈希串格式不对（占位串、被截断、算法名不认识）一律返回 false，不向外抛异常：
 * 登录路径上任何「这条记录有问题」都不该变成 500。
 */
export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  if (typeof passwordHash !== "string" || !passwordHash.startsWith("$argon2")) {
    return false;
  }

  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}
