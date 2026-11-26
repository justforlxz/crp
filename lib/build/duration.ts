/**
 * 耗时写成给人看的一句话。
 *
 * 单独一个文件、不碰库：队列页的作业详情弹窗是客户端组件，而 `lib/build` 的其它模块都会把
 * Prisma 带进浏览器包，所以这条纯格式化的逻辑必须自己待在一个没有数据库依赖的模块里。
 * 对外的入口仍是 `lib/build`（`index.ts` 从这里导出），服务端的用法不变。
 *
 * 构建动辄几十分钟，秒级精度没有意义，所以只到分钟：不足一分钟的给人「不到 1 分钟」。
 */
export function formatDuration(durationMs: number | null): string {
  if (durationMs === null) {
    return "—";
  }

  const totalMinutes = Math.floor(durationMs / 60_000);

  if (totalMinutes < 1) {
    return "不到 1 分钟";
  }

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  return hours === 0 ? `${minutes} 分钟` : `${hours} 小时 ${minutes} 分钟`;
}
