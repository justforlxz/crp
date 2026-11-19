/**
 * 投递用的架构集合：把 Shuttle `repo/info` 给的架构列表变成 CRP 的 `Arches` 字符串。
 *
 * 只用这一处做转换，投递与基线展示都调它，避免两处各写一套规则。
 *
 * 实测结论（见 FINDINGS.md 第十二节）：CRP 的 apply 阶段认的就是 Shuttle 这一套名字，
 * `sw_64`、`loongarch64` 原样发就能进构建；换成 `sw64`、`loong64` 反而 APPLY_FAILED。
 * 所以这里**不改名**，只做三件事：
 *
 * 1. 去掉 `source` 这类非 CPU 架构项 —— 它不是编译目标，发给 CRP 只会让 apply 失败；
 * 2. 去重 —— Shuttle 的列表不保证唯一，重复项会让同一个架构出两份作业；
 * 3. 按字母排序 —— 结果只由集合决定，与 Shuttle 返回的顺序无关，便于逐项对照与写测试。
 */

/** 不是编译目标的架构项。`source` 是源码包索引的「架构」，不是 CPU 架构。 */
const NON_CPU_ARCHES: ReadonlySet<string> = new Set(["source"]);

/**
 * 转成投递用的架构列表：去非 CPU 项、去重、排序。
 *
 * 输入里没有可用的 CPU 架构时返回空数组（调用方据此判错），不在这里抛异常：
 * 基线同步要把「确实没有架构」如实存下来，投递才需要报错。
 */
export function toCrpArchList(arches: readonly string[]): string[] {
  const unique = new Set<string>();

  for (const item of arches) {
    const name = item.trim();

    if (name === "" || NON_CPU_ARCHES.has(name.toLowerCase())) {
      continue;
    }

    unique.add(name);
  }

  return [...unique].sort();
}

/** 转成 CRP 请求体里的 `Arches`：分号分隔，顺序由 `toCrpArchList` 决定。 */
export function toCrpArches(arches: readonly string[]): string {
  return toCrpArchList(arches).join(";");
}
