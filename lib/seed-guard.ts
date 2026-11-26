/**
 * 部署实例的种子数据自检（`.agents/spec/product/runtime.md` 第一节，RT-3 / RT-4）。
 *
 * 种子数据只允许出现在本地开发、单元测试、CI 与界面截图门禁里。部署给人用的实例上出现种子数据，
 * 会让人把演示项目当成真实提测、把演示基线当成「同步坏了」—— 这件事已经发生过两次
 * （部署容器的启动命令里带着 `pnpm db:seed`；基线页长期只显示 4 条演示基线）。
 *
 * 所以部署入口（`pnpm start`）先跑本模块，检测到种子特征就写错误日志并以非零退出。
 *
 * ## 为什么判定只看「占位凭据」
 *
 * 种子里的工作区名（`desktop-core` / 桌面核心组）、基线名（`eagle-1071` 等）与账号邮箱
 * 在真实库里**本来就会出现**：
 *
 * - RUNBOOK 3.6 让生产环境手工建的第一个工作区就叫 `desktop-core` / 桌面核心组；
 * - 基线同步从 CRP 拉下来的分支就叫 `eagle-1071`、`snipe-2500u2`；
 * - `admin@uniontech.com` 这类邮箱是真实同事的账号。
 *
 * 拿它们做判定，真实部署会起不来。真正只可能来自种子的是两个占位值：
 *
 * - `app_user.password_hash` 以 `seed-not-a-real-hash-` 开头 —— 真实哈希是
 *   `$argon2id$v=19$...`（见 `lib/auth/credentials.ts`），`verifyPassword` 对这种串直接返回 false；
 * - `webhook_endpoint.secret` 以 `seed-webhook-secret-` 开头。
 *
 * 这两条是**决定性特征**：命中即拒绝启动。工作区、基线与账号邮箱仍然会查，但只作为
 * 「库里还有这些演示行」的证据写进日志，单独出现不拒绝启动 —— 只清了一半的部署也要能起来。
 */

/** 种子账号的占位密码哈希前缀；真实哈希是 `$argon2id$...`。 */
export const SEED_PASSWORD_HASH_PREFIX = "seed-not-a-real-hash-";

/** 种子 Webhook 端点的占位签名密钥前缀。 */
export const SEED_WEBHOOK_SECRET_PREFIX = "seed-webhook-secret-";

/** 种子里的工作区。`prisma/seed.ts` 的 `WORKSPACES`。 */
export const SEED_WORKSPACES = [
  { slug: "desktop-core", name: "桌面核心组" },
  { slug: "system-apps", name: "系统应用组" },
  { slug: "security", name: "安全组" },
] as const;

/** 种子里的四条基线。`prisma/seed.ts` 的 `BASELINES`。 */
export const SEED_BASELINES = [
  { name: "eagle-1071", description: "V20 桌面交付分支" },
  { name: "eagle-1076", description: "V20 安全组件交付分支" },
  { name: "snipe-2500u1", description: "V25 首轮交付分支" },
  { name: "snipe-2500u2", description: "V25 第二轮交付分支" },
] as const;

/** 种子里的账号邮箱。`prisma/seed.ts` 的 `USERS`。 */
export const SEED_USER_EMAILS = [
  "admin@uniontech.com",
  "liwei@uniontech.com",
  "chenhao@uniontech.com",
  "zhangmin@uniontech.com",
  "wangfang@uniontech.com",
] as const;

/**
 * 自检要读的那几张表。
 *
 * 只取判定需要的列：这是启动路径上的一次查询，不要 `select *`。
 */
export type SeedGuardSnapshot = {
  users: { email: string; passwordHash: string }[];
  workspaces: { slug: string; name: string }[];
  baselines: { name: string; description: string | null }[];
  webhookEndpoints: { url: string; secret: string }[];
};

/** 一条命中的种子特征。 */
export type SeedFinding = {
  /** 命中的表名，与库里的表名一致，方便直接照着清理。 */
  table: "app_user" | "workspace" | "baseline" | "webhook_endpoint";
  /** 命中的是什么，写进日志给人看。 */
  what: string;
  /** 命中的具体值。 */
  values: string[];
  /** 这一条单独就足以判定为种子数据；为 false 时只作为证据。 */
  decisive: boolean;
};

/** 库里有没有决定性特征：有就拒绝启动。 */
export function hasDecisiveFinding(findings: SeedFinding[]): boolean {
  return findings.some((item) => item.decisive);
}

/**
 * 从四张表的快照里找出种子特征。
 *
 * 纯函数：不查库、不读环境变量，输入输出都是普通对象，单测直接喂两套快照。
 */
export function detectSeedData(snapshot: SeedGuardSnapshot): SeedFinding[] {
  const findings: SeedFinding[] = [];

  const seededUsers = snapshot.users.filter((item) =>
    item.passwordHash.startsWith(SEED_PASSWORD_HASH_PREFIX),
  );
  if (seededUsers.length > 0) {
    findings.push({
      table: "app_user",
      what: "占位密码哈希（任何密码都登不进去）",
      values: seededUsers.map((item) => item.email),
      decisive: true,
    });
  }

  const seededEndpoints = snapshot.webhookEndpoints.filter((item) =>
    item.secret.startsWith(SEED_WEBHOOK_SECRET_PREFIX),
  );
  if (seededEndpoints.length > 0) {
    findings.push({
      table: "webhook_endpoint",
      what: "占位签名密钥",
      values: seededEndpoints.map((item) => item.url),
      decisive: true,
    });
  }

  // 以下三条只作为证据：名字与邮箱在真实库里本来就会出现（见文件头）。
  //
  // 工作区要求**三个种子工作区同时存在**才算命中：生产环境按 RUNBOOK 3.6 手工建的那一个
  // 就叫 `desktop-core` / 桌面核心组，只看单个必然误报。
  const seededWorkspaces = snapshot.workspaces.filter((item) =>
    SEED_WORKSPACES.some((seed) => seed.slug === item.slug && seed.name === item.name),
  );
  if (seededWorkspaces.length === SEED_WORKSPACES.length) {
    findings.push({
      table: "workspace",
      what: "种子工作区（标识与名称都与种子一致）",
      values: seededWorkspaces.map((item) => item.slug),
      decisive: false,
    });
  }

  const seededBaselines = snapshot.baselines.filter((item) =>
    SEED_BASELINES.some((seed) => seed.name === item.name && seed.description === item.description),
  );
  if (seededBaselines.length > 0) {
    findings.push({
      table: "baseline",
      what: "种子基线（分支名与描述都与种子一致）",
      values: seededBaselines.map((item) => item.name),
      decisive: false,
    });
  }

  const seededEmails = snapshot.users.filter((item) =>
    (SEED_USER_EMAILS as readonly string[]).includes(item.email),
  );
  // 上面已经按占位哈希报过同一批账号时不再重复报。
  if (seededEmails.length > 0 && seededUsers.length === 0) {
    findings.push({
      table: "app_user",
      what: "种子账号邮箱",
      values: seededEmails.map((item) => item.email),
      decisive: false,
    });
  }

  return findings;
}

/**
 * 把命中结果排成一段可读的日志。
 *
 * 三件事必须写清：命中的是哪张表的哪些值、这是怎么进来的、怎么清理。
 * 结论由 `hasDecisiveFinding` 决定，和调用方的动作保持一致：
 * 有决定性特征才写「拒绝启动」，只有证据时写明「不拒绝启动」。
 *
 * 两段的收尾文案**必须**跟着判定走：真实库（RUNBOOK 3.6 建的工作区、CRP 拉下来的基线）
 * 会命中「证据」这几条，那时若照「把上面列出的演示行删掉」去做，删掉的是真实数据。
 */
export function formatSeedReport(findings: SeedFinding[]): string {
  const decisive = hasDecisiveFinding(findings);
  const lines = [
    decisive
      ? "[seed-guard] 检测到种子数据，拒绝启动："
      : "[seed-guard] 检测到种子形状的数据（只有证据，本次不拒绝启动）：",
  ];

  for (const item of findings) {
    const mark = item.decisive ? "拒绝启动" : "证据";
    lines.push(`  - ${item.table}（${mark}）：${item.what} —— ${item.values.join("、")}`);
  }

  lines.push("");

  if (decisive) {
    lines.push(
      "部署实例上不允许出现种子数据（.agents/spec/product/runtime.md 第一节）。",
      "这些行来自 `pnpm db:seed`；部署路径不允许调用它，它只该出现在本地开发、测试与 CI 里。",
      "清理办法：把上面列出的演示行删掉（或换一个干净的库）再启动，",
      "步骤见 docs/RUNBOOK.md 第 3.7 节「种子数据政策与启动自检」。",
    );
  } else {
    lines.push(
      "这些是按名字命中的证据（工作区名、基线名、账号邮箱），真实库里本来就会出现，本次不拒绝启动。",
      "决定性特征只有占位密码哈希与占位签名密钥；上面一条都没有，说明这个库不是纯种子库。",
      "若这些行确实来自 `pnpm db:seed`，按 docs/RUNBOOK.md 第 3.7 节清理即可，不影响启动。",
    );
  }

  return lines.join("\n");
}
