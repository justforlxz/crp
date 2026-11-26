/**
 * 咨询锁的集成测试：连真数据库，验证会话级锁的语义与连接出错时的处理。
 *
 * 锁的是三条不能破的约定：
 *
 * - 同一把键在同一时刻只有一个会话能拿到；
 * - 连接一关（会话结束）锁就释放，不依赖显式 `pg_advisory_unlock`；
 * - 连接被对端断开时只记一条日志，不抛成未捕获异常 —— worker 进程不能因此退出。
 *
 * 用本文件自己的锁键（`9_994_001` 起），不碰 `JOB_SPECS` 里的真实锁键，跑完自己关连接。
 */

import "dotenv/config";

import assert from "node:assert/strict";
import test from "node:test";

import { prisma } from "../lib/db";
import {
  ADVISORY_LOCK_APPLICATION_NAME,
  openAdvisoryLockConnection,
} from "../lib/jobs/advisory-lock";

/** 测试专用锁键：与 `JOB_SPECS` 的 7310001-3 隔开一个区间。 */
const LOCK_KEY = 9_994_001;
const OTHER_LOCK_KEY = 9_994_002;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("同一把键同一时刻只有一个会话拿到", async () => {
  const first = await openAdvisoryLockConnection();
  const second = await openAdvisoryLockConnection();

  try {
    assert.equal(await first.tryLock(LOCK_KEY), true, "第一条连接应该抢到");
    assert.equal(await second.tryLock(LOCK_KEY), false, "第二条连接必须抢不到");
  } finally {
    await first.close();
    await second.close();
  }
});

test("关掉连接就释放锁，不需要显式 unlock", async () => {
  const holder = await openAdvisoryLockConnection();

  try {
    assert.equal(await holder.tryLock(LOCK_KEY), true);
  } finally {
    await holder.close();
  }

  const next = await openAdvisoryLockConnection();

  try {
    assert.equal(await next.tryLock(LOCK_KEY), true, "上一个会话结束后应该能抢到");
  } finally {
    await next.close();
  }
});

test("不同作业的锁键互不阻塞", async () => {
  const first = await openAdvisoryLockConnection();
  const second = await openAdvisoryLockConnection();

  try {
    assert.equal(await first.tryLock(LOCK_KEY), true);
    assert.equal(await second.tryLock(OTHER_LOCK_KEY), true);
  } finally {
    await first.close();
    await second.close();
  }
});

test("连接被对端断开：只记一条日志，下一次查询作为普通异常冒出", async () => {
  const lines: string[] = [];
  const connection = await openAdvisoryLockConnection(process.env, {
    log: (line) => lines.push(line),
  });

  assert.equal(await connection.tryLock(LOCK_KEY), true);

  // 模拟 Postgres 重启、主备切换或运维掐连接：从别的会话把这条锁连接掐掉。
  const killed = await prisma.$queryRawUnsafe<{ pg_terminate_backend: boolean }[]>(
    "select pg_terminate_backend(pid) from pg_stat_activity" +
      " where application_name = $1 and datname = current_database()",
    ADVISORY_LOCK_APPLICATION_NAME,
  );
  assert.ok(killed.length >= 1, "没找到锁连接，application_name 没生效？");

  // 断开是异步事件，最多等 5 秒。
  for (let i = 0; i < 100 && lines.length === 0; i += 1) {
    await sleep(50);
  }

  assert.ok(lines.length >= 1, "连接断开后没有记日志：error 事件没有监听器");
  assert.match(lines[0], /^\[worker\] 锁连接出错：/);
  // 服务端掐断时给的是 `terminating connection due to administrator command`；
  // PostgreSQL 重启给的是 `terminating connection because of crash of another server process`。
  assert.match(lines[0], /terminat/i);

  // 连接已经不可用：再查一次应该是个普通异常，交给 runJobRound 记成「本轮失败」。
  await assert.rejects(() => connection.tryLock(LOCK_KEY));

  // 收尾：断开之后再 close 不能抛到调用方之外。
  await connection.close().catch(() => {});
});
