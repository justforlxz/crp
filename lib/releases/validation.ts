/**
 * 创建提测的输入校验。
 *
 * 纯函数：把页面提交的请求体变成结构化结果，或给出逐个字段的错误。
 * 这里只校验「字段填得对不对」；「项目有没有软件清单」「依赖有没有环」「基线同步过吗」
 * 要查库，放在 `service.ts`，判定本身在 `plan.ts`。
 *
 * 自定义 Tag 的格式规则不在这里重写：CRP 侧实测出来的四条限制只有一份，
 * 在 `lib/integrations/crp/tag.ts`，这里直接调它。
 */

import { validateReleaseTag } from "../integrations/crp/tag";
import type { FieldError, ParseResult } from "../projects/validation";

/** 一个软件包本次要固化的分支与 Commit，以及可选的自定义 Tag。 */
export type ReleasePackageInput = {
  /** 源码包名，例如 `kwin`。 */
  packageName: string;
  /** 固化的分支，例如 `develop/eagle`。 */
  branch: string;
  /** 固化的 Commit。 */
  commitSha: string;
  /** 自定义 Tag；没填就是 `null`，提测版本取代码版本。 */
  customTag: string | null;
};

/** 创建提测的输入。 */
export type ReleaseInput = {
  /** 提测归属项目。 */
  projectId: string;
  /** Topic 版本号，同一项目内唯一。 */
  version: string;
  /** 提测说明；没填就是 `null`。 */
  description: string | null;
  /** 清单里每个软件包一行。 */
  packages: ReleasePackageInput[];
};

/** Topic 版本号：不能包含空白字符，长度不超过 CRP 侧能接受的范围。 */
const VERSION_MAX_LENGTH = 100;

/**
 * CRP 只认完整 40 位提交号：短号能建提测、能建 Topic，投递时才被 CRP 拒成
 * `commitID 长度异常 请重新提交`（MKACG-927）。所以入口就按 40 位校验。
 */
const FULL_COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/i;

function asRecord(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return null;
  }

  return raw as Record<string, unknown>;
}

function readText(
  raw: Record<string, unknown>,
  field: string,
  errors: FieldError[],
  options: { required: boolean; label: string; hint?: string; maxLength?: number },
): string | null {
  const value = raw[field];

  if (value === undefined || value === null) {
    if (options.required) {
      errors.push({ field, message: options.hint ?? `${options.label}不能为空。` });
    }
    return null;
  }

  if (typeof value !== "string") {
    errors.push({ field, message: `${options.label}必须是字符串。` });
    return null;
  }

  const text = value.trim();

  if (text === "") {
    if (options.required) {
      errors.push({ field, message: options.hint ?? `${options.label}不能为空。` });
    }
    return null;
  }

  if (options.maxLength !== undefined && text.length > options.maxLength) {
    errors.push({
      field,
      message: `${options.label}不能超过 ${options.maxLength} 个字符（当前 ${text.length} 个）。`,
    });
    return null;
  }

  return text;
}

const NOT_AN_OBJECT: ParseResult<never> = {
  ok: false,
  errors: [{ field: "", message: "输入必须是一组字段。" }],
};

/**
 * 校验一个软件包的提测输入。
 *
 * 分支与 Commit 都必须给：快照要固化「哪个分支的哪个提交」，缺一个都复现不出来。
 * Commit 只接受十六进制提交号，不接受分支名 —— 分支名会随分支移动，快照就不可复现了。
 */
function parsePackage(
  raw: unknown,
  index: number,
  errors: FieldError[],
  /** 这组包在请求体里的字段名：建提测是 `packages`，更新提测是 `append` / `replace`。 */
  listField = "packages",
): ReleasePackageInput | null {
  const record = asRecord(raw);
  const prefix = `${listField}[${index}]`;

  if (record === null) {
    errors.push({ field: prefix, message: `第 ${index + 1} 个软件包的输入必须是一组字段。` });
    return null;
  }

  const before = errors.length;

  const packageName = readText(record, "packageName", errors, {
    required: true,
    label: "软件包名",
    hint: "软件包名不能为空。",
  });

  const branch = readText(record, "branch", errors, {
    required: true,
    label: "分支",
    hint: "请为这个软件包选择要提测的分支。",
  });

  if (branch !== null && /\s/.test(branch)) {
    errors.push({
      field: `${prefix}.branch`,
      message: `分支不能包含空白字符（${branch}）。`,
    });
  }

  const commitSha = readText(record, "commitSha", errors, {
    required: true,
    label: "Commit",
    hint: "请为这个软件包选择要提测的 Commit。",
  });

  if (commitSha !== null && !FULL_COMMIT_SHA_PATTERN.test(commitSha)) {
    errors.push({
      field: `${prefix}.commitSha`,
      message: `Commit 必须是完整的 40 位十六进制提交号（短提交号投递时会被 CRP 拒绝），当前是：${commitSha}。`,
    });
  }

  const customTag = readText(record, "customTag", errors, {
    required: false,
    label: "自定义 Tag",
  });

  if (customTag !== null) {
    const reason = validateReleaseTag(customTag);

    if (reason !== null) {
      errors.push({ field: `${prefix}.customTag`, message: `自定义 Tag 不合法：${reason}。` });
    }
  }

  // 本包的字段名统一加上下标：页面要指出是第几个包出错，不能只显示 `branch`。
  for (let index = before; index < errors.length; index += 1) {
    const error = errors[index];

    if (!error.field.startsWith(prefix)) {
      errors[index] = { ...error, field: `${prefix}.${error.field}` };
    }
  }

  if (errors.length > before) {
    return null;
  }

  return {
    packageName: packageName as string,
    branch: branch as string,
    commitSha: commitSha as string,
    customTag,
  };
}

/**
 * 校验创建提测的请求体。
 *
 * 软件包清单必须非空：MUST 项目清单内全部软件都进提测，一条都没有就没有提测可做。
 * 是否与项目清单一致（不多不少）要查库，在 `service.ts` 里判定。
 */
export function parseReleaseInput(raw: unknown): ParseResult<ReleaseInput> {
  const record = asRecord(raw);

  if (record === null) {
    return NOT_AN_OBJECT;
  }

  const errors: FieldError[] = [];

  const projectId = readText(record, "projectId", errors, {
    required: true,
    label: "项目",
    hint: "请选择要提测的项目。",
  });

  const version = readText(record, "version", errors, {
    required: true,
    label: "Topic 版本号",
    hint: "请填写 Topic 版本号，例如 25.0.2。",
    maxLength: VERSION_MAX_LENGTH,
  });

  if (version !== null && /\s/.test(version)) {
    errors.push({
      field: "version",
      message: `Topic 版本号不能包含空白字符（${version}）。`,
    });
  }

  const description = readText(record, "description", errors, {
    required: false,
    label: "提测说明",
  });

  const rawPackages = record.packages;

  if (!Array.isArray(rawPackages) || rawPackages.length === 0) {
    errors.push({
      field: "packages",
      message: "提测必须包含至少一个软件包。项目清单里的软件包全部要进提测。",
    });
  }

  const packages: ReleasePackageInput[] = [];

  if (Array.isArray(rawPackages)) {
    rawPackages.forEach((item, index) => {
      const parsed = parsePackage(item, index, errors);

      if (parsed !== null) {
        packages.push(parsed);
      }
    });
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    value: {
      projectId: projectId as string,
      version: version as string,
      description,
      packages,
    },
  };
}

/**
 * 提交的软件包清单必须与项目清单完全一致：不多不少。
 *
 * MUST NOT 在清单外加包，MUST 清单内全部软件都进提测（「无变化」也不例外）。
 * 两边都按包名比较，顺序不参与判定 —— 顺序由依赖拓扑排序决定，不由提交方决定。
 */
export function comparePackageSet(
  expected: readonly string[],
  submitted: readonly string[],
): { missing: string[]; unexpected: string[]; duplicated: string[] } {
  const expectedSet = new Set(expected);
  const seen = new Set<string>();
  const unexpected: string[] = [];
  const duplicated: string[] = [];

  for (const name of submitted) {
    if (!expectedSet.has(name)) {
      unexpected.push(name);
      continue;
    }

    if (seen.has(name)) {
      duplicated.push(name);
    }

    seen.add(name);
  }

  const missing = expected.filter((name) => !seen.has(name));

  return { missing, unexpected, duplicated };
}

// ---------------------------------------------------------------------------
// 增量更新（A17）
// ---------------------------------------------------------------------------

/** 更新提测时对一个软件包做的改动：与建提测的包输入同形。 */
export type ReleaseUpdateOperationInput = ReleasePackageInput;

/** 更新提测的输入：补包与换包两组，至少填一组。 */
export type ReleaseUpdateInput = {
  /** 追加的软件包：此刻还不在提测里的包。 */
  append: ReleasePackageInput[];
  /** 换包的软件包：此刻已经在提测里的包，改它的分支 / Commit / 提测版本。 */
  replace: ReleasePackageInput[];
};

/**
 * 校验更新提测的请求体。
 *
 * 这里只校验「字段填得对不对」；「包在不在项目清单里」「包在不在这次提测里」
 * 要查库，在 `update.ts` 里判定。
 *
 * 两组都空要拒绝：一次什么都不改的更新没有意义，也不该占用一次轮次。
 */
export function parseReleaseUpdateInput(raw: unknown): ParseResult<ReleaseUpdateInput> {
  const record = asRecord(raw);

  if (record === null) {
    return NOT_AN_OBJECT;
  }

  const errors: FieldError[] = [];

  const append = parsePackageList(record, "append", errors);
  const replace = parsePackageList(record, "replace", errors);

  if (append.length === 0 && replace.length === 0 && errors.length === 0) {
    errors.push({
      field: "",
      message: "这次更新没有任何改动：至少要在「补包」或「换包」里填一项。",
    });
  }

  const replaced = new Set(replace.map((item) => item.packageName));

  for (const item of append) {
    if (replaced.has(item.packageName)) {
      errors.push({
        field: "append",
        message: `软件包「${item.packageName}」同时出现在补包与换包里，只能选一种。`,
      });
    }
  }

  // 同一个包在一组里出现两次会写出两轮同号的快照，撞唯一索引；这里先挡住，给一句能看懂的话。
  for (const [field, list] of [
    ["append", append],
    ["replace", replace],
  ] as const) {
    const seen = new Set<string>();

    for (const item of list) {
      if (seen.has(item.packageName)) {
        errors.push({
          field,
          message: `软件包「${item.packageName}」在这一组里重复了，每个包只能提交一次。`,
        });
      }

      seen.add(item.packageName);
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return { ok: true, value: { append, replace } };
}

/** 解析 `append` / `replace` 这一组包；字段缺省当空数组，写了不是数组才算错。 */
function parsePackageList(
  record: Record<string, unknown>,
  field: "append" | "replace",
  errors: FieldError[],
): ReleasePackageInput[] {
  const rawList = record[field];

  if (rawList === undefined || rawList === null) {
    return [];
  }

  if (!Array.isArray(rawList)) {
    errors.push({ field, message: `${field} 必须是软件包数组。` });
    return [];
  }

  const parsed: ReleasePackageInput[] = [];

  rawList.forEach((item, index) => {
    const one = parsePackage(item, index, errors, field);

    if (one !== null) {
      parsed.push(one);
    }
  });

  return parsed;
}
