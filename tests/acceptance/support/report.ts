/**
 * 验收用例的断言出口（MKACG-985）。
 *
 * 用例集第七条要求：断言失败必须打印「编号、预期、实际」三项。`node:assert` 只报
 * 「expected true to be false」，对着 77 条编号根本对不上是哪一条、差在哪，所以验收用例
 * 统一走这里 —— 抛出的消息本身就是给人看的报告。
 *
 * 三个入口：
 *
 * | 入口 | 用在哪 |
 * | --- | --- |
 * | `expectEqual` | 期望值能直接写出来（数字、字符串、数组、对象） |
 * | `expectTrue` | 期望一句话，实际是一个布尔判定或一段实际值 |
 * | `expectContains` | 期望「含有某段文字 / 某个元素」，实际是整段内容 |
 *
 * 编号写错不会静默通过：`acceptanceCase` 会先去用例集里查这个编号，查不到直接报错。
 */

import { isDeepStrictEqual } from "node:util";

/** 断言失败：消息里固定含编号、预期、实际三项。 */
export class AcceptanceFailure extends Error {
  constructor(
    readonly id: string,
    readonly label: string,
    readonly expected: string,
    readonly actual: string,
  ) {
    super(`[${id}] ${label}\n  预期：${expected}\n  实际：${actual}`);
    this.name = "AcceptanceFailure";
  }
}

/** 把任意值写成一行，日志里能直接读。 */
export function formatValue(value: unknown): string {
  if (typeof value === "string") {
    return JSON.stringify(value);
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (typeof value === "bigint") {
    return `${value.toString()}n`;
  }

  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    return `[${value.map((item) => JSON.stringify(item)).join(", ")}]`;
  }

  if (value === null || typeof value !== "object") {
    return String(value);
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** 期望与实际相等。 */
export function expectEqual(
  id: string,
  label: string,
  expected: unknown,
  actual: unknown,
): void {
  if (isDeepStrictEqual(expected, actual)) {
    return;
  }

  throw new AcceptanceFailure(id, label, formatValue(expected), formatValue(actual));
}

/** 期望实际值满足一句话描述的条件。`expected` 是那句人话，`actual` 是实际取值。 */
export function expectTrue(
  id: string,
  label: string,
  expected: string,
  actual: boolean,
): void {
  if (actual) {
    return;
  }

  throw new AcceptanceFailure(id, label, expected, "不成立");
}

/** 期望 `haystack` 里含有 `needle`。 */
export function expectContains(
  id: string,
  label: string,
  needle: string,
  haystack: string,
): void {
  if (haystack.includes(needle)) {
    return;
  }

  throw new AcceptanceFailure(
    id,
    label,
    `含有 ${JSON.stringify(needle)}`,
    haystack.trim() === "" ? "（空）" : haystack.slice(0, 400),
  );
}

/** 期望 `haystack` 里不含 `needle`。 */
export function expectOmits(
  id: string,
  label: string,
  needle: string,
  haystack: string,
): void {
  if (!haystack.includes(needle)) {
    return;
  }

  throw new AcceptanceFailure(
    id,
    label,
    `不含有 ${JSON.stringify(needle)}`,
    `含有（片段：${haystack.slice(Math.max(0, haystack.indexOf(needle) - 40), haystack.indexOf(needle) + needle.length + 40)})`,
  );
}

/** 期望数值落在闭区间 `[min, max]` 里，用于带容差的几何与颜色判据。 */
export function expectBetween(
  id: string,
  label: string,
  min: number,
  max: number,
  actual: number,
): void {
  if (Number.isFinite(actual) && actual >= min && actual <= max) {
    return;
  }

  throw new AcceptanceFailure(
    id,
    label,
    `${String(min)} ~ ${String(max)}`,
    formatValue(actual),
  );
}
