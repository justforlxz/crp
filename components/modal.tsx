"use client";

/**
 * 弹层（界面规范 v2 第七节 `.scrim` / `.modal` 一族）。
 *
 * 分两层，职责各一半：
 *
 * - `ModalScrim` 只管**关闭行为**：一层遮罩、点空白处关闭、按 Esc 关闭。它不决定里面放什么。
 * - `Modal` 用 `ModalScrim` 包一整套最简弹窗（`.modal` + 头部 + 主体 + 底部），适合「一段说明 +
 *   两个按钮」这种普通弹窗。
 *
 * 为什么把遮罩单独拆出来：`check:modules` 只从**页面源码**里读 `className`，而「创建提测」这一页
 * 在 `modules.json` 里声明的模块包含 `.modal-hd` / `.modal-bd` / `.modal-ft`。创建提测的向导又有
 * 自己的结构（头部与主体之间要插步骤条、底部按钮随步骤变化），所以它自己写那三段类名，
 * 只复用这里的关闭行为 —— 类名在向导源码里，门禁与人都看得到。
 *
 * 关闭行为照原型（design.md 第九节）：点右上角 ×、点遮罩空白处、按 Esc，三种都生效。
 * 遮罩只在「点在遮罩本身」时关闭 —— 弹窗内部的点击会冒泡到遮罩，用 `target === currentTarget`
 * 判断，点里面的东西不会误关。
 *
 * 不加动画：没有淡入、没有缩放入场。
 */

import { useEffect, useId, type ReactNode } from "react";

import { Icon } from "./icons";

export type ModalScrimProps = {
  /** 关闭：点遮罩空白处、按 Esc 都调它。 */
  onClose: () => void;
  children: ReactNode;
};

/** 遮罩层：只管「点空白处 / 按 Esc 关闭」，里面放什么由调用方决定。 */
export function ModalScrim({ onClose, children }: ModalScrimProps) {
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        onClose();
      }
    }

    document.addEventListener("keydown", handleKeyDown);

    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return (
    <div
      className="scrim"
      onClick={(event) => {
        // 只认「点到遮罩本身」。弹窗内部任何点击都会冒泡到这里，不能关。
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      {children}
    </div>
  );
}

export type ModalProps = {
  /** 根节点类名：`"modal"` 或 `"modal is-wide"`（原型 `.modal.is-wide` 是宽版）。 */
  className: string;
  /** 头部标题，同时作为对话框的无障碍名字。 */
  title: ReactNode;
  /** 标题后面那句小字，例如「第 2 步，共 3 步」。 */
  subtitle?: ReactNode;
  children: ReactNode;
  /** 底部操作区；不传就只出头部与主体。 */
  footer?: ReactNode;
  /** 关闭：遮罩点击、× 按钮、Esc 都调它。 */
  onClose: () => void;
};

/** 最简弹窗：遮罩 + 头部（标题、可选小字、关闭按钮）+ 主体 + 可选底部操作区。 */
export function Modal({ className, title, subtitle, children, footer, onClose }: ModalProps) {
  const titleId = useId();

  return (
    <ModalScrim onClose={onClose}>
      <div className={className} role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="modal-hd">
          <h2 id={titleId}>{title}</h2>
          {subtitle === undefined ? null : <span className="modal-sub">{subtitle}</span>}
          <div className="spacer" />
          <button type="button" className="icon-btn" onClick={onClose} aria-label="关闭">
            <Icon name="x" />
          </button>
        </div>

        <div className="modal-bd">{children}</div>

        {footer === undefined ? null : <div className="modal-ft">{footer}</div>}
      </div>
    </ModalScrim>
  );
}
