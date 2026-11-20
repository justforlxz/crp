#!/usr/bin/env bash
#
# A16 全链路演练的入口（在仓库根执行）。
#
# 它做三件事：检查必备的环境变量 → 起一个真实服务（`next build` + `next start`）→
# 调 `scripts/e2e.ts` 在真实 CRP 上跑完整链路（含一次基线同步，投递用的架构来自基线）。
# 参数原样透传给 `scripts/e2e.ts`：
#
#   scripts/e2e.sh                        # 跑完整演练（含 A17），跑完自动清理
#   scripts/e2e.sh --skip-a17             # 只跑主链路
#   scripts/e2e.sh --poll-seconds=9000    # 加长等待 CRP 构建的时间
#   scripts/e2e.sh --keep                 # 保留本次的提测、项目与 CRP Topic（便于人工看详情页）
#
# 前置条件：
#   - 库已经 `pnpm db:migrate` + `pnpm db:seed`。演练会新建项目与提测并在结束时删掉它们，
#     但库里只要还有上一次 `pnpm test` 留下的数据，样式门禁就过不了 —— 样式门禁要求纯种子库。
#     顺序建议：`pnpm db:reset` → `scripts/style-check/container.sh` → `scripts/e2e.sh`。
#   - `E2E_BASE_URL` 未设置时自己起服务；设置了就复用已有服务（不再 build、不再起进程）。
#   - 外部系统凭据只从环境变量注入，不要写进仓库、日志或提交信息。
#
# 必备环境变量：
#   DATABASE_URL                  PostgreSQL 连接串
#   CRP_USERNAME / CRP_PASSWORD   CRP 登录用 LDAP 账号（投递与轮询会真的调 CRP）
#   GERRIT_USERNAME / GERRIT_HTTP_PASSWORD   Gerrit HTTP 凭据（读分支、提交与 changelog）
#   PACKAGE_API_TOKEN             POST /api/packages 的独立 token
#   SYNC_JOB_TOKEN                POST /api/jobs/baseline-sync 的独立 token
#   BUILD_DISPATCH_JOB_TOKEN      POST /api/jobs/build-dispatch 的独立 token
#   BUILD_POLL_JOB_TOKEN          POST /api/jobs/build-poll 的独立 token
#
# 可选：
#   E2E_BASE_URL      已有服务的地址，例如 http://127.0.0.1:3000
#   E2E_PORT          自己起服务时监听的端口，默认 3200
#   E2E_SKIP_BUILD    设为 1 时跳过 `next build`（只给反复调脚本时用；改了代码必须重新构建）

set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo"

port="${E2E_PORT:-3200}"
base_url="${E2E_BASE_URL:-}"

die() {
  echo "e2e: $*" >&2
  exit 2
}

# 缺变量时一次列全，不要跑到一半才失败。
missing=()
for name in DATABASE_URL CRP_USERNAME CRP_PASSWORD GERRIT_USERNAME GERRIT_HTTP_PASSWORD \
  PACKAGE_API_TOKEN SYNC_JOB_TOKEN BUILD_DISPATCH_JOB_TOKEN BUILD_POLL_JOB_TOKEN; do
  if [ -z "${!name:-}" ]; then
    missing+=("$name")
  fi
done
if [ "${#missing[@]}" -gt 0 ]; then
  die "缺少环境变量：${missing[*]}。凭据从环境变量注入，不要写进仓库。"
fi

log_dir="${XDG_CACHE_HOME:-$HOME/.cache}/crp"
mkdir -p "$log_dir"
log_file="$log_dir/e2e-$(date +%Y%m%d-%H%M%S).log"

server_pid=""

cleanup() {
  if [ -n "$server_pid" ] && kill -0 "$server_pid" 2>/dev/null; then
    kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

wait_for_http() {
  local url="$1"
  local deadline=$((SECONDS + 120))

  while [ "$SECONDS" -lt "$deadline" ]; do
    if curl -fsS -o /dev/null "$url"; then
      return 0
    fi
    sleep 2
  done

  return 1
}

if [ -z "$base_url" ]; then
  if [ "${E2E_SKIP_BUILD:-}" != "1" ]; then
    echo "e2e: next build（日志 $log_file）"
    pnpm build >>"$log_file" 2>&1 || {
      echo "e2e: next build 失败，看 $log_file" >&2
      exit 1
    }
  fi

  echo "e2e: next start -p $port"
  pnpm exec next start -p "$port" >>"$log_file" 2>&1 &
  server_pid=$!

  base_url="http://127.0.0.1:$port"
  if ! wait_for_http "$base_url/login"; then
    echo "e2e: 服务 120 秒内没起来，看 $log_file" >&2
    exit 1
  fi
fi

echo "e2e: 目标服务 $base_url；完整输出写入 $log_file"
status=0
pnpm tsx scripts/e2e.ts --base-url="$base_url" "$@" 2>&1 | tee -a "$log_file" || status=$?

if [ "$status" -ne 0 ]; then
  echo "e2e: 演练失败（退出码 $status），完整输出在 $log_file" >&2
else
  echo "e2e: 演练通过，完整输出在 $log_file"
fi

exit "$status"
