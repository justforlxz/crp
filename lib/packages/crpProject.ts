/**
 * 「软件包」与「CRP 项目」之间的名字换算（A16 缺陷修复）。
 *
 * 二者不是一回事，仓库里必须显式分开：
 *
 * - `Package.name` 是 Debian 源码包名，例如 `kwin`。它与 `debian/changelog` 的解析结果、
 *   基线软件包索引（`baseline_package_version.package_name`）共用一套命名，不允许下划线。
 * - CRP 的项目名是 CRP 自己起的名字，实测带下划线（`deepin-kde/kwin`、`deepin-kde/wayland`
 *   在 CRP 上只有带下划线的项目），按名字查 ProjectID 时必须拿这个名字去查。
 *
 * 两件事只在这里实现一次：
 *
 * 1. **解析**：`crpProjectName` 为空就退回包名，保持这一列出现之前的行为不变。
 *    投递与认领都必须调 `resolveCrpProjectName`，不许各写一遍。
 * 2. **校验**：CRP 项目名的规则与 Debian 包名不同 —— 只要非空、不含空白字符、不超过
 *    `CRP_PROJECT_NAME_MAX_LENGTH` 个字符。**不要**复用 `validation.ts` 的 `NAME_PATTERN`：
 *    它会把带下划线的 CRP 项目名判成非法。
 */

/** CRP 项目名的长度上限。CRP 侧没有公布硬限制，这里按「明显异常的长串」兜底。 */
export const CRP_PROJECT_NAME_MAX_LENGTH = 100;

/** 登记的 CRP 项目名不合法。属于配置错误，不是 CRP 侧的问题，所以不复用 `CrpError`。 */
export class CrpProjectNameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CrpProjectNameError";
  }
}

/**
 * CRP 项目名是否合法：去空白后非空、不含任何空白字符、长度不超过上限。
 *
 * 允许下划线与大写字母：那是 CRP 侧的命名习惯，不归 Debian 包名规则管。
 */
export function isValidCrpProjectName(value: string): boolean {
  const text = value.trim();

  if (text === "" || text.length > CRP_PROJECT_NAME_MAX_LENGTH) {
    return false;
  }

  return !/\s/.test(text);
}

/** 解析时只关心这两列，不要求调用方把整行软件包查出来。 */
export type CrpProjectNameSource = {
  /** Debian 源码包名。 */
  name: string;
  /** CRP 项目名；为空表示与 `name` 相同。 */
  crpProjectName?: string | null;
};

/**
 * 投递与认领共用的解析函数：这个软件包在 CRP 里叫哪个名字。
 *
 * 空值退回包名；登记了但不合法（只有空白字符、超长、含空白字符）直接抛错 ——
 * 库里出现这种值说明写入路径绕过了校验，此时按包名投出去会投到别的项目上，
 * 构建还能成功、问题要等装包才发现，所以宁可当场失败。
 */
export function resolveCrpProjectName(pkg: CrpProjectNameSource): string {
  const configured = pkg.crpProjectName;

  if (configured === null || configured === undefined) {
    return pkg.name;
  }

  if (!isValidCrpProjectName(configured)) {
    throw new CrpProjectNameError(
      `软件包 ${pkg.name} 登记的 CRP 项目名不合法：${JSON.stringify(configured)}。` +
        `要求去空白后非空、不含任何空白字符、长度不超过 ${CRP_PROJECT_NAME_MAX_LENGTH} 个字符；` +
        "留空表示与包名相同。",
    );
  }

  return configured.trim();
}

/**
 * 一个已经解析出来的 CRP 项目名，配上软件包自己的名字，用于错误提示。
 *
 * 投递失败时人要能一眼看出「这次用的是哪个 CRP 项目名、对应哪个包」，
 * 否则只看到一个陌生的项目名无从判断是配置错了还是 CRP 那边改了名。
 */
export function describeCrpProjectName(packageName: string, crpProjectName: string): string {
  return crpProjectName === packageName
    ? `「${crpProjectName}」（与包名相同）`
    : `「${crpProjectName}」（软件包 ${packageName} 登记的 CRP 项目名）`;
}
