/**
 * 项目列表的搜索（MKACG-971）。
 *
 * 只看项目名：`.filters` 里的搜索框按名称过滤，与改动前「一眼能找到某个项目」的用法一致，
 * 不做多余的条件组合。大小写不敏感、去首尾空白；关键字为空时原样返回，清空搜索框即恢复全量。
 *
 * 纯函数，所以「输入什么得到什么」这一层能用单测固定住，页面只负责把查询串传进来。
 */

export function filterProjectsByName<T extends { name: string }>(
  projects: readonly T[],
  keyword: string,
): T[] {
  const needle = keyword.trim().toLowerCase();

  if (needle === "") {
    return [...projects];
  }

  return projects.filter((project) => project.name.toLowerCase().includes(needle));
}
