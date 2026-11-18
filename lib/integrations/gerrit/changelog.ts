/**
 * `debian/changelog` 首条条目的解析。
 *
 * 这里是纯函数：只做字符串到结构体的转换，不读网络、不读环境变量。
 * 平台判断「某个分支是哪个版本」靠的是真实 changelog，所以解析失败一律抛错，
 * 不允许返回空版本号让调用方当成正常结果。
 */

/** changelog 首条条目里平台用得到的字段。 */
export type ChangelogEntry = {
  /** 软件包名，取自标题行括号前。 */
  packageName: string;
  /** 版本号，取自标题行括号内，原样保留 epoch、修订号与 ~ 后缀。 */
  version: string;
  /** 目标发行版，取自标题行分号前，可能包含多个发行版。 */
  distribution: string;
  /** 紧急度，取自 `urgency=` 之后。 */
  urgency: string;
  /** 维护者时间行里的时间原样字符串，不做时区换算。 */
  date: string;
};

/** changelog 无法解析时抛出，消息里带上是哪一行读不懂。 */
export class ChangelogParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChangelogParseError";
  }
}

/**
 * Debian 标题行：`package (version) distribution; urgency=level`。
 * 版本号里允许除圆括号外的任意字符；发行版与紧急度之间用 `;` 分隔。
 */
const HEADER_PATTERN = /^(\S+)\s+\(([^()]+)\)\s+([^;]+);\s*urgency=(\S*)\s*$/;

/**
 * 维护者时间行：` -- Name <email>  Mon, 06 Nov 2023 10:00:00 +0800`。
 * 姓名与时间之间按 Debian 惯例是两个及以上空格；没有邮箱时同样能拆开。
 */
const TRAILER_PATTERN = /^ -- (.+?)\s{2,}(\S.*?)\s*$/;

/**
 * 解析 `debian/changelog` 文本的首条条目。
 *
 * 只读首条：第二条及之后的内容全部忽略，因为平台要的是「这个 ref 当前的版本」。
 */
export function parseChangelog(text: string): ChangelogEntry {
  // CRLF 与单独的 CR 统一成 LF，后面只按 \n 切行。
  const lines = text.replace(/\r\n?/g, "\n").split("\n");

  const headerIndex = lines.findIndex((line) => line.trim() !== "");
  if (headerIndex === -1) {
    throw new ChangelogParseError(
      "changelog 内容为空，找不到首条条目的标题行。",
    );
  }

  const header = lines[headerIndex].trim();
  const headerMatched = HEADER_PATTERN.exec(header);
  if (!headerMatched) {
    throw new ChangelogParseError(
      `无法解析 changelog 首条条目的标题行，期望形如「软件包名 (版本号) 发行版; urgency=级别」，实际是：${header}`,
    );
  }

  const [, packageName, version, distribution, urgency] = headerMatched;

  const trailerIndex = lines.findIndex(
    (line, index) => index > headerIndex && line.startsWith(" -- "),
  );
  if (trailerIndex === -1) {
    throw new ChangelogParseError(
      `changelog 首条条目缺少维护者时间行，期望以「 -- 姓名 <邮箱>  时间」开头，标题行是：${header}`,
    );
  }

  const trailerMatched = TRAILER_PATTERN.exec(lines[trailerIndex]);
  if (!trailerMatched) {
    throw new ChangelogParseError(
      `无法从维护者时间行里读出时间：${lines[trailerIndex].trim()}`,
    );
  }

  return {
    packageName,
    version,
    distribution: distribution.trim(),
    urgency,
    date: trailerMatched[2],
  };
}
