"use client";

/**
 * 详情页的确认弹窗：渲染到 `document.body` 上（MKACG-1011 评审返工）。
 *
 * 为什么不直接用 `components/modal.tsx` 的 `Modal`：`.scrim` 在样式表里是
 * `position: absolute`（`app/globals.css:646`），它的定位基准是最近的已定位祖先。详情页有两个
 * 位置会把这个基准弄坏，实测都能复现「点了看不到确认框」：
 *
 * - **顶栏**（撤回）：`PageShell` 的 `actions` 槽在 `.topbar` 里，而 `.topbar` 是
 *   `position: sticky` 且带 `backdrop-filter`（`app/globals.css:177`、`:182`）。后者会给
 *   `position: fixed` 的后代也建立包含块，所以「补一层 `.modal-root`」在这里不够：遮罩只有
 *   顶栏那么高（55px），弹窗头部落在视口上方，看不见也点不到；
 * - **快照表单元格**（单包重投）：`<td>` 到 `.page` 之间没有已定位祖先，遮罩退回初始包含块，
 *   滚到表格再点，弹窗整块在视口上方。
 *
 * 因此这里用 `createPortal` 把 `.modal-root` + `Modal` 挂到 `document.body` 上：`body` 之上
 * 没有任何会建立包含块的祖先，遮罩就是整块视口，`z-index` 也压得住吸顶表头。
 *
 * 不加动画、不改样式表；`Modal` 的关闭语义（×、遮罩空白处、Esc）原样继承。
 */

import { createPortal } from "react-dom";

import { Modal, type ModalProps } from "@/components/modal";

export function DetailModal(props: ModalProps) {
  // 弹窗只在点开之后才渲染（首屏没有它），所以正常路径下 `document` 一定存在。
  // 保留这个判断只是为了让「将来有人在服务端把它渲染成打开态」时不会炸在渲染里。
  if (typeof document === "undefined") {
    return null;
  }

  return createPortal(
    <div className="modal-root">
      <Modal {...props} />
    </div>,
    document.body,
  );
}
