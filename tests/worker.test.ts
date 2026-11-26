/**
 * 调度骨架的单元测试：不连数据库，锁用假连接替换。
 *
 * 锁的是运行契约第二节里几条不能破的约定：
 *
 * - 三条作业的频率固定（每小时 / 每 2 分钟 / 每 5 分钟），锁键固定且互不相同；
 * - 抢不到锁就跳过这一轮：作业一次都不跑，日志写「被其他实例占用」；
 * - 单轮抛错只记日志，`runJobRound` 不向外抛 —— worker 进程不能因为一轮失败退出；
 * - 连不上数据库、抢锁语句失败也只算这一轮失败，同样不抛；
 * - 锁连接每轮都关掉：会话级咨询锁靠关连接释放，漏关就等于锁泄漏。
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  JOB_SPECS,
  runJobRound,
  type JobSpec,
  type LockConnection,
} from "../lib/jobs/scheduler";

/** 与真实作业表解耦的测试用作业：行为测试只关心这一段调度，不依赖真实频率数值。 */
const SPEC: JobSpec = { name: "build-poll", intervalMs: 5 * 60 * 1000, lockKey: 42 };

/** 每次取时间往前走 5 毫秒，日志里的「耗时」就是可以逐字断言的 5ms。 */
function steppingClock(startIso: string, stepMs: number): () => Date {
  let ms = Date.parse(startIso);

  return () => {
    const value = new Date(ms);
    ms += stepMs;

    return value;
  };
}

type FakeConnection = {
  connection: LockConnection;
  /** `tryLock` 收到的锁键，按调用顺序。 */
  tryLockKeys: number[];
  /** 关了几次。 */
  closed: number;
};

function fakeConnection(options: {
  locked?: boolean;
  tryLockError?: Error;
  closeError?: Error;
}): FakeConnection {
  const fake: FakeConnection = {
    tryLockKeys: [],
    closed: 0,
    connection: {
      async tryLock(lockKey) {
        fake.tryLockKeys.push(lockKey);

        if (options.tryLockError !== undefined) {
          throw options.tryLockError;
        }

        return options.locked ?? true;
      },
      async close() {
        fake.closed += 1;

        if (options.closeError !== undefined) {
          throw options.closeError;
        }
      },
    },
  };

  return fake;
}

test("三条作业的频率固定，锁键固定且互不相同", () => {
  assert.deepEqual(
    JOB_SPECS.map((spec) => [spec.name, spec.intervalMs]),
    [
      ["baseline-sync", 60 * 60 * 1000],
      ["build-dispatch", 2 * 60 * 1000],
      ["build-poll", 5 * 60 * 1000],
    ],
  );

  const lockKeys = JOB_SPECS.map((spec) => spec.lockKey);
  assert.equal(new Set(lockKeys).size, lockKeys.length, "三个作业的锁键不能重复");
  for (const lockKey of lockKeys) {
    assert.equal(Number.isSafeInteger(lockKey), true, `锁键必须是整数：${lockKey}`);
  }
});

test("抢到锁：跑一轮、日志一行、结果成功、锁连接关掉", async () => {
  const fake = fakeConnection({ locked: true });
  const lines: string[] = [];
  let runs = 0;

  const result = await runJobRound(
    SPEC,
    async () => {
      runs += 1;
    },
    {
      openConnection: async () => fake.connection,
      log: (line) => lines.push(line),
      now: steppingClock("2026-11-25T02:00:00.000Z", 5),
    },
  );

  assert.equal(result, "success");
  assert.equal(runs, 1);
  assert.deepEqual(fake.tryLockKeys, [SPEC.lockKey]);
  assert.equal(fake.closed, 1);
  assert.deepEqual(lines, [
    "[worker] 作业=build-poll 开始=2026-11-25T02:00:00.000Z 耗时=5ms 结果=成功",
  ]);
});

test("抢不到锁：作业一次都不跑，日志写被占用，锁连接照样关掉", async () => {
  const fake = fakeConnection({ locked: false });
  const lines: string[] = [];
  let runs = 0;

  const result = await runJobRound(
    SPEC,
    async () => {
      runs += 1;
    },
    {
      openConnection: async () => fake.connection,
      log: (line) => lines.push(line),
      now: steppingClock("2026-11-25T02:00:00.000Z", 5),
    },
  );

  assert.equal(result, "skipped");
  assert.equal(runs, 0);
  assert.equal(fake.closed, 1);
  assert.deepEqual(lines, [
    "[worker] 作业=build-poll 开始=2026-11-25T02:00:00.000Z 耗时=5ms 结果=跳过 原因=被其他实例占用",
  ]);
});

test("作业抛错：只记日志、结果失败，不向外抛，锁连接照样关掉", async () => {
  const fake = fakeConnection({ locked: true });
  const lines: string[] = [];

  const result = await runJobRound(
    SPEC,
    async () => {
      throw new Error("CRP 认证失败");
    },
    {
      openConnection: async () => fake.connection,
      log: (line) => lines.push(line),
      now: steppingClock("2026-11-25T02:00:00.000Z", 5),
    },
  );

  assert.equal(result, "failed");
  assert.equal(fake.closed, 1);
  assert.deepEqual(lines, [
    "[worker] 作业=build-poll 开始=2026-11-25T02:00:00.000Z 耗时=5ms 结果=失败 原因=Error: CRP 认证失败",
  ]);
});

test("连不上数据库：结果失败，作业不跑，不向外抛", async () => {
  const lines: string[] = [];
  let runs = 0;

  const result = await runJobRound(
    SPEC,
    async () => {
      runs += 1;
    },
    {
      openConnection: async () => {
        throw new Error("connect ECONNREFUSED 127.0.0.1:5432");
      },
      log: (line) => lines.push(line),
      now: steppingClock("2026-11-25T02:00:00.000Z", 5),
    },
  );

  assert.equal(result, "failed");
  assert.equal(runs, 0);
  assert.deepEqual(lines, [
    "[worker] 作业=build-poll 开始=2026-11-25T02:00:00.000Z 耗时=5ms 结果=失败" +
      " 原因=Error: connect ECONNREFUSED 127.0.0.1:5432",
  ]);
});

test("抢锁语句本身失败：结果失败，作业不跑，不向外抛", async () => {
  const fake = fakeConnection({
    tryLockError: new Error("function pg_try_advisory_lock does not exist"),
  });
  const lines: string[] = [];
  let runs = 0;

  const result = await runJobRound(
    SPEC,
    async () => {
      runs += 1;
    },
    {
      openConnection: async () => fake.connection,
      log: (line) => lines.push(line),
      now: steppingClock("2026-11-25T02:00:00.000Z", 5),
    },
  );

  assert.equal(result, "failed");
  assert.equal(runs, 0);
  // 抢锁失败也要关连接：漏关的话每一轮都泄漏一条数据库连接（build-dispatch 一天 720 轮）。
  assert.equal(fake.closed, 1, "抢锁语句失败时锁连接必须关掉");
  assert.match(lines[0], /结果=失败 原因=Error: function pg_try_advisory_lock does not exist/);
});

test("关锁连接失败：本轮结果不受影响，另记一行为什么", async () => {
  const fake = fakeConnection({ locked: true, closeError: new Error("连接已断开") });
  const lines: string[] = [];

  const result = await runJobRound(
    SPEC,
    async () => {},
    {
      openConnection: async () => fake.connection,
      log: (line) => lines.push(line),
      now: steppingClock("2026-11-25T02:00:00.000Z", 5),
    },
  );

  assert.equal(result, "success");
  assert.deepEqual(lines, [
    "[worker] 关闭锁连接失败：Error: 连接已断开",
    "[worker] 作业=build-poll 开始=2026-11-25T02:00:00.000Z 耗时=5ms 结果=成功",
  ]);
});
