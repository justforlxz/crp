/**
 * 项目经理与项目的输入校验。
 *
 * 纯函数：把页面表单或接口传进来的值变成结构化结果，或给出逐个字段的错误。
 * 这里只校验「字段填得对不对」；「项目经理属于这个工作区吗」「基线同步过吗」要查库，
 * 放在 `service.ts`。分开是为了让这层能被单测固定住，不需要数据库。
 */

export type FieldError = {
  /** 出错的字段，与表单里的 `name` 一致。 */
  field: string;
  message: string;
};

export type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; errors: FieldError[] };

/** 项目经理的输入。账号绑定不走表单，见 `service.ts` 的说明。 */
export type ManagerInput = {
  name: string;
  /** 联系邮箱；没填就是 `null`。 */
  email: string | null;
};

/** 新建与编辑项目共用的输入。 */
export type ProjectInput = {
  name: string;
  /** 项目标识，用于 URL 与外部引用，例如 `desktop-v25`。 */
  key: string;
  /** 项目经理 id。 */
  projectManagerId: string;
  /** CRP 基线 id，单选。 */
  baselineId: string;
  /** 说明；没填就是 `null`。 */
  description: string | null;
};

/** 往项目软件清单里加一项、或改一项的跟踪分支。 */
export type ProjectSoftwareInput = {
  packageId: string;
  trackedBranch: string;
};

/** 邮箱：只做「像不像一个邮箱」的粗校验，真正的可达性不在这里判断。 */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** 项目标识：小写字母或数字开头，只允许小写字母、数字与连字符，例如 `desktop-v25`。 */
const KEY_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

function readText(
  raw: Record<string, unknown>,
  field: string,
  errors: FieldError[],
  options: { required: boolean; pattern?: RegExp; hint?: string; label: string },
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

  if (options.pattern && !options.pattern.test(text)) {
    errors.push({
      field,
      message: `${options.label}格式不对（${text}）。${options.hint ?? ""}`.trim(),
    });
    return null;
  }

  return text;
}

function asRecord(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return null;
  }

  return raw as Record<string, unknown>;
}

const NOT_AN_OBJECT: ParseResult<never> = {
  ok: false,
  errors: [{ field: "", message: "输入必须是一组字段。" }],
};

/** 校验项目经理的姓名。同一工作区内重名由数据库唯一约束挡住，这里只管填没填。 */
export function parseManagerInput(raw: unknown): ParseResult<ManagerInput> {
  const record = asRecord(raw);

  if (record === null) {
    return NOT_AN_OBJECT;
  }

  const errors: FieldError[] = [];
  const name = readText(record, "name", errors, {
    required: true,
    label: "项目经理姓名",
    hint: "项目经理姓名不能为空。",
  });
  // 邮箱可空：没填就是 `null`，不编一个占位地址。
  const email = readText(record, "email", errors, {
    required: false,
    label: "邮箱",
    pattern: EMAIL_PATTERN,
    hint: "邮箱格式像 name@uniontech.com。",
  });

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return { ok: true, value: { name: name as string, email } };
}

/**
 * 校验项目字段。新建、编辑、复制三处入口共用。
 *
 * 两个「必须指定」的提示写在同一处，这样「没选项目经理」「没选基线」在页面上显示的话
 * 完全一致，不会因为走了复制入口就换一种说法。
 */
export function parseProjectInput(raw: unknown): ParseResult<ProjectInput> {
  const record = asRecord(raw);

  if (record === null) {
    return NOT_AN_OBJECT;
  }

  const errors: FieldError[] = [];

  const name = readText(record, "name", errors, {
    required: true,
    label: "项目名称",
    hint: "项目名称不能为空。",
  });

  const key = readText(record, "key", errors, {
    required: true,
    pattern: KEY_PATTERN,
    label: "项目标识",
    hint: "项目标识用小写字母、数字与连字符，例如 desktop-v25。",
  });

  const projectManagerId = readText(record, "projectManagerId", errors, {
    required: true,
    label: "项目经理",
    hint: "请选择项目经理。项目必须指定一位属于本工作区的项目经理。",
  });

  const baselineId = readText(record, "baselineId", errors, {
    required: true,
    label: "CRP 基线",
    hint: "请选择 CRP 基线。项目必须绑定一个已同步的基线。",
  });

  const description = readText(record, "description", errors, {
    required: false,
    label: "项目说明",
  });

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    value: {
      name: name as string,
      key: key as string,
      projectManagerId: projectManagerId as string,
      baselineId: baselineId as string,
      description,
    },
  };
}

/** 校验「往清单里加一个包」「改一项的跟踪分支」这两种提交。 */
export function parseProjectSoftwareInput(raw: unknown): ParseResult<ProjectSoftwareInput> {
  const record = asRecord(raw);

  if (record === null) {
    return NOT_AN_OBJECT;
  }

  const errors: FieldError[] = [];

  const packageId = readText(record, "packageId", errors, {
    required: true,
    label: "软件包",
    hint: "请选择要加入清单的软件包。",
  });

  const trackedBranch = readText(record, "trackedBranch", errors, {
    required: true,
    label: "跟踪分支",
    hint: "跟踪分支形如 develop/eagle，不能包含空白字符。",
  });

  if (trackedBranch !== null && /\s/.test(trackedBranch)) {
    errors.push({
      field: "trackedBranch",
      message: `跟踪分支不能包含空白字符（${trackedBranch}）。`,
    });
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    value: { packageId: packageId as string, trackedBranch: trackedBranch as string },
  };
}

/** 把字段错误拼成一句给人看的话。表单一次只显示一段提示，不做逐字段标注。 */
export function joinFieldErrors(errors: readonly FieldError[]): string {
  return errors.map((error) => error.message).join("；");
}
