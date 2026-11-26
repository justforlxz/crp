/**
 * 提测记录列表的 CSV 导出（界面规范 v2 提测记录页的「导出」）。
 *
 * 导出的就是**当前筛选出来的那几行**，与页面上的表格一一对应：同一个筛选条件、同一份行、
 * 同一个顺序，不再单独查一遍。这与详情页的单条快照导出（`api/releases/[id]/export`）是两件事：
 * 那份是「这条提测固化了哪些软件包」，这份是「当前视图里有哪些提测」。
 *
 * 纯函数，不碰浏览器也不碰数据库：页面负责拼行，这里只负责转成 CSV 文本。
 */

/** 一行提测记录在导出文件里的内容。字段都是页面上已经显示过的值。 */
export type ReleaseListCsvRow = {
  version: string;
  projectName: string;
  projectKey: string;
  revision: number;
  packageCount: number;
  statusLabel: string;
  createdByName: string;
  /** 已经格式化好的时间字符串，与表格里显示的一致。 */
  createdAt: string;
};

/** 表头顺序与表格列顺序一致。 */
const CSV_HEADER = [
  "提测版本",
  "所属项目",
  "项目标识",
  "轮次",
  "软件包数",
  "状态",
  "创建人",
  "创建时间",
] as const;

/**
 * 以这些字符开头的值会被 Excel / WPS / LibreOffice 当成公式求值。
 *
 * 提测版本、项目名、创建人显示名都是成员可写的，导出成 CSV 再被打开时就成了一条可执行的公式
 * （CSV 注入）。RFC 4180 的引号转义挡不住它 —— 加了引号照样求值。
 */
const FORMULA_PREFIXES = ["=", "+", "-", "@", "\t", "\r"] as const;

/**
 * 一个字段转成 CSV 单元格。
 *
 * 两件事：
 *
 * 1. 含逗号、双引号或换行的值整体加引号，内部的双引号写两遍（RFC 4180）；
 * 2. 以公式前缀开头的值前面加一个单引号，让表格软件按文本处理。
 */
function cell(value: string | number): string {
  const raw = String(value);
  const text = FORMULA_PREFIXES.some((prefix) => raw.startsWith(prefix)) ? `'${raw}` : raw;

  return /[",\n\r]/u.test(text) ? `"${text.replace(/"/gu, '""')}"` : text;
}

/** 把当前视图的行拼成 CSV 文本。空列表也出表头，导出的文件不是空文件。 */
export function buildReleaseListCsv(rows: readonly ReleaseListCsvRow[]): string {
  const lines = [
    CSV_HEADER.join(","),
    ...rows.map((row) =>
      [
        row.version,
        row.projectName,
        row.projectKey,
        row.revision,
        row.packageCount,
        row.statusLabel,
        row.createdByName,
        row.createdAt,
      ]
        .map(cell)
        .join(","),
    ),
  ];

  // 末尾留一个换行：绝大多数表格软件按行读，最后一行没有换行也照样能读，
  // 但补上之后与「每行都以换行结束」的直觉一致，diff 也更好看。
  return `${lines.join("\n")}\n`;
}
