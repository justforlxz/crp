/**
 * CRP 对提测版本号（Tag）的校验规则。
 *
 * 这里的四条规则不是猜的，全部来自真实响应（见 FINDINGS.md 的「Tag 实测」表）：
 *
 * | 传进去的 Tag | CRP 的答复 |
 * | --- | --- |
 * | 留空 | `version string is empty` |
 * | `7.7.7-rc1` | `版本中不能包含'-'字符` |
 * | `9.9.9_1` | `invalid character in version number` |
 * | `9.9.9 rc` | `version string has embedded spaces` |
 * | `v9.9.9` | `version number does not start with digit` |
 * | `9.9.9`、`9.9.9+deb1`、`9.9.9~rc1` | 接受，按原样存进 Release |
 *
 * 只拦这几条已经证实的规则。其余字符一律放行交给 CRP 判断——本地规则比服务器更严，
 * 会把本来能投的版本号挡在门外，比多一次请求更糟。
 */

/** 返回不可读的原因；合法时返回 null。 */
export function validateReleaseTag(tag: string): string | null {
  if (tag.trim() === "") {
    return "提测版本号不能为空：ChangeLogMode=false 时必须给出版本号（CRP 返回 version string is empty）";
  }

  if (tag.includes("-")) {
    return "提测版本号不能包含半角连字符 '-'（CRP 返回 版本中不能包含'-'字符）";
  }

  if (tag.includes("_")) {
    return "提测版本号不能包含下划线 '_'（CRP 返回 invalid character in version number）";
  }

  if (/\s/.test(tag)) {
    return "提测版本号不能包含空格（CRP 返回 version string has embedded spaces）";
  }

  if (!/^[0-9]/.test(tag)) {
    return "提测版本号必须以数字开头（CRP 返回 version number does not start with digit）";
  }

  return null;
}
