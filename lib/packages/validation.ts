/**
 * 软件包登记的输入校验。
 *
 * 只校验「登记软件包」这一件事需要的五个字段，不猜别的业务 —— 依赖关系与版本怎么用
 * 是后续节点的事。纯函数：把任意 JSON 变成结构化结果，或给出逐个字段的错误，
 * 好让 `POST /api/packages` 把错误原样放进 400 响应里。
 *
 * 其中 `crpProjectName` 的规则与 Debian 包名不同，实现在 `crpProject.ts`：
 * 前者是 CRP 侧的名字（允许下划线），后者是源码包名（不允许下划线），不要混用。
 */

import {
  CRP_PROJECT_NAME_MAX_LENGTH,
  isValidCrpProjectName,
} from "./crpProject";

export type PackageInput = {
  /** 源码包名，例如 `kwin`。 */
  name: string;
  /** 仓库路径，例如 `deepin-kde/kwin`。 */
  repoPath: string;
  /** 默认跟踪分支，例如 `develop/eagle`。 */
  defaultBranch: string;
  /** 当前版本；没填就是 `null`。 */
  currentVersion: string | null;
  /**
   * CRP 里这个软件包的项目名；没填就是 `null`，表示与 `name` 相同。
   *
   * 校验规则与 Debian 包名不同（CRP 项目名允许下划线），见 `crpProject.ts`。
   */
  crpProjectName: string | null;
};

export type FieldError = {
  /** 出错的字段；批量提交时带上下标，例如 `items[1].name`。 */
  field: string;
  message: string;
};

export type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; errors: FieldError[] };

/** Debian 源码包名：小写字母开头，只允许小写字母、数字与 `+` `-` `.`。 */
const NAME_PATTERN = /^[a-z0-9][a-z0-9+.-]*$/;

/** 仓库路径：`deepin-kde/kwin` 这种形式，不允许首尾斜杠与空段。 */
export const REPO_PATH_PATTERN = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;

/** 一次提交最多多少条，防止一个请求把库塞满。 */
export const MAX_PAYLOAD_ITEMS = 200;

function readText(
  raw: Record<string, unknown>,
  field: string,
  errors: FieldError[],
  options: { required: boolean; pattern?: RegExp; hint: string },
): string | null {
  const value = raw[field];

  if (value === undefined || value === null || value === "") {
    if (options.required) {
      errors.push({ field, message: `${field} 不能为空。${options.hint}` });
    }
    return null;
  }

  if (typeof value !== "string") {
    errors.push({ field, message: `${field} 必须是字符串。${options.hint}` });
    return null;
  }

  const text = value.trim();

  if (text === "") {
    if (options.required) {
      errors.push({ field, message: `${field} 不能为空。${options.hint}` });
    }
    return null;
  }

  if (options.pattern && !options.pattern.test(text)) {
    errors.push({ field, message: `${field} 格式不对（${text}）。${options.hint}` });
    return null;
  }

  return text;
}

/** 校验单条。字段错误带原始字段名前缀，由批量入口决定是否加下标。 */
function parseOne(raw: unknown): ParseResult<PackageInput> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return {
      ok: false,
      errors: [{ field: "", message: "每条记录必须是一个 JSON 对象。" }],
    };
  }

  const record = raw as Record<string, unknown>;
  const errors: FieldError[] = [];

  const name = readText(record, "name", errors, {
    required: true,
    pattern: NAME_PATTERN,
    hint: "源码包名用小写字母、数字与 + - . 组成，例如 kwin。",
  });

  const repoPath = readText(record, "repoPath", errors, {
    required: true,
    pattern: REPO_PATH_PATTERN,
    hint: "仓库路径形如 deepin-kde/kwin，不能有首尾斜杠或空段。",
  });

  const defaultBranch = readText(record, "defaultBranch", errors, {
    required: true,
    hint: "默认跟踪分支形如 develop/eagle，不能包含空白字符。",
  });

  const currentVersion = readText(record, "currentVersion", errors, {
    required: false,
    hint: "版本号不能包含空白字符。",
  });

  // CRP 项目名与包名不是一套规则：允许下划线，只要求非空、无空白、不超长。
  //
  // 这里不能直接交给 readText 收尾：它把空白串当成「没填」，而只填了空白字符是填错了 ——
  // 静默当成「与包名相同」，就会在投递时按包名去 CRP 找一个（可能根本不存在的）项目。
  const rawCrpProjectName = record.crpProjectName;
  const crpProjectName = readText(record, "crpProjectName", errors, {
    required: false,
    hint: "留空表示与包名相同；填了就必须是 CRP 里那个软件包的项目名。",
  });

  const blanksOnly =
    typeof rawCrpProjectName === "string" &&
    rawCrpProjectName.trim() === "" &&
    rawCrpProjectName !== "";

  if (blanksOnly) {
    errors.push({
      field: "crpProjectName",
      message:
        "crpProjectName 只填了空白字符。留空表示与包名相同；" +
        "要填就填 CRP 里那个软件包的项目名。",
    });
  } else if (crpProjectName !== null && !isValidCrpProjectName(crpProjectName)) {
    errors.push({
      field: "crpProjectName",
      message:
        `crpProjectName 格式不对（${crpProjectName}）。` +
        `不能包含空白字符，长度不超过 ${CRP_PROJECT_NAME_MAX_LENGTH} 个字符；` +
        "留空表示与包名相同。",
    });
  }

  if (defaultBranch !== null && /\s/.test(defaultBranch)) {
    errors.push({
      field: "defaultBranch",
      message: `defaultBranch 不能包含空白字符（${defaultBranch}）。`,
    });
  }

  if (currentVersion !== null && /\s/.test(currentVersion)) {
    errors.push({
      field: "currentVersion",
      message: `currentVersion 不能包含空白字符（${currentVersion}）。`,
    });
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    value: {
      name: name as string,
      repoPath: repoPath as string,
      defaultBranch: defaultBranch as string,
      currentVersion,
      crpProjectName,
    },
  };
}

/** 校验一条记录（页面表单、接口单条提交都走这里）。 */
export function parsePackageInput(raw: unknown): ParseResult<PackageInput> {
  return parseOne(raw);
}

/**
 * 校验接口请求体：既接受单条对象，也接受数组。
 *
 * 与单条校验的差别只有两点：数组下标进错误字段名，方便调用方定位；
 * 一条不合法就整批拒绝，不做部分写入 —— 幂等接口不该留下半批数据。
 */
export function parsePackagePayload(raw: unknown): ParseResult<PackageInput[]> {
  if (raw === null || typeof raw !== "object") {
    const message = Array.isArray(raw)
      ? "请求体不能为空数组，至少提交一条记录。"
      : "请求体必须是 JSON 对象或 JSON 数组。";
    return { ok: false, errors: [{ field: "", message }] };
  }

  if (!Array.isArray(raw)) {
    const single = parseOne(raw);
    return single.ok ? { ok: true, value: [single.value] } : single;
  }

  if (raw.length === 0) {
    return {
      ok: false,
      errors: [{ field: "", message: "请求体不能为空数组，至少提交一条记录。" }],
    };
  }

  if (raw.length > MAX_PAYLOAD_ITEMS) {
    return {
      ok: false,
      errors: [
        {
          field: "",
          message: `一次最多提交 ${MAX_PAYLOAD_ITEMS} 条记录，本次 ${raw.length} 条。`,
        },
      ],
    };
  }

  const values: PackageInput[] = [];
  const errors: FieldError[] = [];

  raw.forEach((item, index) => {
    const result = parseOne(item);
    if (result.ok) {
      values.push(result.value);
      return;
    }

    for (const error of result.errors) {
      const field = error.field === "" ? `items[${index}]` : `items[${index}].${error.field}`;
      errors.push({ field, message: error.message });
    }
  });

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return { ok: true, value: values };
}
