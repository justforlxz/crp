/**
 * 用例注册（MKACG-985）。
 *
 * 测试名必须「编号开头」，这条要求由这里统一保证 —— 调用方只写编号，标题从用例集里取，
 * 于是三种形态都自然满足：
 *
 * | 入口 | 测试名 | 什么时候用 |
 * | --- | --- | --- |
 * | `acceptanceCase` | `FUNC-03 提测记录页签计数` | 现在就能验的用例 |
 * | `acceptanceWithEnv` | 同上；缺环境时 skip 并写明缺什么 | 要库或要实例的用例 |
 * | `acceptanceTodo` | `FUNC-01 TODO 工作台统计口径` | 用例集里有、实现还要等别的节点的 |
 *
 * 三种都经过 `caseById`：编号写错、写了个文档里没有的编号，在这里就报错。
 */

import test from "node:test";

import { caseById } from "./catalog";
import { missingEnvReason, type EnvNeed } from "./env";

/** 现在就能验的用例。 */
export function acceptanceCase(id: string, body: () => void | Promise<void>): void {
  const item = caseById(id);
  test(`${item.id} ${item.title}`, body);
}

/**
 * 要环境才能验的用例。
 *
 * 缺环境时注册成 skip：`node --test` 的汇总里它是 skipped，不是 passed ——
 * 「没跑」和「通过」必须能分开看。
 */
export function acceptanceWithEnv(
  id: string,
  needs: readonly EnvNeed[],
  body: () => void | Promise<void>,
): void {
  const item = caseById(id);
  const missing = missingEnvReason(needs);

  if (missing !== null) {
    test(`${item.id} ${item.title}`, { skip: missing }, () => undefined);
    return;
  }

  test(`${item.id} ${item.title}`, body);
}

/**
 * 用例集里有、但现在实现不了的用例：注册成带 TODO 的 skip。
 *
 * `reason` 必须写清「卡在什么上」，因为在 `[Result]` 里要逐条列出来，光写「未实现」
 * 没法判断什么时候能补上。
 */
export function acceptanceTodo(id: string, reason: string): void {
  const item = caseById(id);
  test(`${item.id} TODO ${item.title}`, { skip: reason }, () => undefined);
}
