"use client";

/**
 * 轻提示（界面规范 v2 第七节 `.toast`）：操作结果的反馈，数秒后自己消失。
 *
 * 类名由页面给出：成功写 `"toast ok"`，失败写 `"toast bad"`（原型 `.toast.ok` / `.toast.bad`）。
 * 图标跟着无障碍角色走 —— `role="alert"` 是「失败要立刻播报」，配警告号；其余配勾。
 * 这样页面只描述一次档位（类名 + 角色），组件不用再从字符串里猜。
 *
 * 停留 4.2 秒（design.md 第四节「轻提示」）。消失是直接移除，不做淡出 —— 第九节「不加动画」。
 * `message` 一变就重新计时，所以后续操作产生的提示不会被上一条的计时提前收走。
 *
 * 多条提示同时存在时由调用方摆进 `.toast-stack` 里（原型是右下角的竖排容器）。
 */

import { useEffect, useState } from "react";

import { Icon } from "./icons";

/** 提示停留时长（毫秒）：design.md 第四节的 4.2 秒。 */
export const TOAST_VISIBLE_MS = 4200;

export type ToastProps = {
  /** 原型模块名与视觉档位，由页面给出：`"toast ok"` 或 `"toast bad"`。 */
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
      <Icon name={role === "alert" ? "alert" : "check"} />
      <div>{message}</div>
    </div>
  );
}
