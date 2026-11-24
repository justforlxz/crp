"use client";

/**
 * 原型的 `.toast` 轻提示（MKACG-972）：操作成功/失败的反馈用它呈现，数秒后自动消失。
 *
 * 为什么 `className` 由调用方给：`.toast` 是 `.agents/spec/design/modules.json` 里的**全局模块**，
 * 而 `pnpm check:modules` 只从页面源码里读 `className`。模块名藏在组件内部，门禁就看不到它。
 * 所以页面自己写 `className="toast alert alert--info"`（成功/信息）或 `"toast alert alert--error"`
 * （失败）—— 模块表达「这是一条会自己消失的提示」，视觉沿用已有的 `.alert`。
 *
 * 消失是直接隐藏，不做淡出（design.md 第九节「不加动效」）。`message` 一变就重新计时，
 * 所以后续操作产生的提示不会被上一条的计时提前收走，多条提示也能同时存在（各占一个实例）。
 */

import { useEffect, useState } from "react";

/** 提示停留时长（毫秒）：数秒后自动消失，不需要用户点。 */
export const TOAST_VISIBLE_MS = 4000;

export type ToastProps = {
  /** 原型模块名与视觉档位，由页面给出，例如 `"toast alert alert--info"`。 */
  className: string;
  /** 提示内容；`null` 表示这次没有提示，什么都不渲染。 */
  message: string | null;
  /** 无障碍角色：失败用 `alert`（会被读屏立刻播报），其余用 `status`。 */
  role?: "status" | "alert";
};

export function Toast({ className, message, role = "status" }: ToastProps) {
  // 记住「哪一条提示已经消失」而不是一个布尔值：`message` 换成另一条时自动重新显示，
  // 不需要在 effect 里改 state（`react-hooks/set-state-in-effect` 禁止那样写）。
  const [dismissed, setDismissed] = useState<string | null>(null);

  useEffect(() => {
    if (message === null) {
      return;
    }

    const timer = setTimeout(() => setDismissed(message), TOAST_VISIBLE_MS);

    return () => clearTimeout(timer);
  }, [message]);

  if (message === null || dismissed === message) {
    return null;
  }


  return (
    <div className={className} role={role}>
      {message}
    </div>
  );
}
