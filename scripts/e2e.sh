#!/usr/bin/env bash
#
# A16 全链路演练的入口（在仓库根执行）。
#
# 它做四件事：检查必备的环境变量 → 起一个真实服务（`next build` + `next start`）→
# 从 base URL 打开一次（`scripts/verify-base-url.ts`，两种身份都查，几秒）→
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
#   - 外部系统凭据按人存在库里（「我的账号」页配置），不再走环境变量；演练用谁配置的凭据
#     由 `--user <平台账号邮箱>` 或 `CREDENTIAL_USER_EMAIL` 指定，这个账号要已经在
#     `/settings/credentials` 里配好 CRP 与 Gerrit 账号。凭据本身不要写进仓库、日志或提交信息。
#
# 必备环境变量：
#   DATABASE_URL                  PostgreSQL 连接串
#   CREDENTIAL_ENCRYPTION_KEY     凭据密文的主密钥（32 字节 base64）
#   PACKAGE_API_TOKEN             POST /api/packages 的独立 token
#   SYNC_JOB_TOKEN                POST /api/jobs/baseline-sync 的独立 token
#   BUILD_DISPATCH_JOB_TOKEN      POST /api/jobs/build-dispatch 的独立 token
#   BUILD_POLL_JOB_TOKEN          POST /api/jobs/build-poll 的独立 token
#   CREDENTIAL_USER_EMAIL         可选：用谁的凭据；也可以用 `--user <邮箱>` 传下去
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
for name in DATABASE_URL CREDENTIAL_ENCRYPTION_KEY \
  PACKAGE_API_TOKEN SYNC_JOB_TOKEN BUILD_DISPATCH_JOB_TOKEN BUILD_POLL_JOB_TOKEN; do
  if [ -z "${!name:-}" ]; then
    missing+=("$name")
  fi
done
if [ "${#missing[@]}" -gt 0 ]; then
  die "缺少环境变量：${missing[*]}。平台密钥与定时任务 token 从环境变量注入，不要写进仓库。"
fi

# 用谁的凭据（`--user <邮箱>` 或 `CREDENTIAL_USER_EMAIL`）：演练会真的建 Topic、投 Release，
# CRP 侧记录的操作人就是这个账号。这里先判一次，免得跑完 build 才在 e2e.ts 里报「没指定账号」。
user_arg=""
email_arg=""
prev=""
for arg in "$@"; do
  case "$arg" in
    --user=*) user_arg="${arg#--user=}" ;;
    --user) ;;
    *) if [ "$prev" = "--user" ]; then user_arg="$arg"; fi ;;
  esac
  prev="$arg"
done
email_arg="${user_arg:-${CREDENTIAL_USER_EMAIL:-}}"
if [ -z "$email_arg" ]; then
  die "缺少演练用的平台账号：用 --user <邮箱> 或 CREDENTIAL_USER_EMAIL 指定。这个账号要已经在「我的账号」里配好凭据。"
fi

export CREDENTIAL_USER_EMAIL="$email_arg"

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

# 从 base URL 打开：主链路要真实 CRP 构建一小时，这条只要几秒，重定向被改坏了先在这里失败。
# 就绪探测仍然打 /login，不打 /：探测只想知道进程起来了，重定向本身由这条检查断言，
# 而 / 被改坏时返回 404，探测会等满 120 秒才报「服务没起来」—— 报的不是真正的原因。
echo "e2e: 从 base URL 打开（不带会话 / 带会话）"
if ! pnpm tsx scripts/verify-base-url.ts --base-url="$base_url" 2>&1 | tee -a "$log_file"; then
  echo "e2e: 从 base URL 打开失败（见上），不进入主链路" >&2
  exit 1
fi

status=0
pnpm tsx scripts/e2e.ts --base-url="$base_url" "$@" 2>&1 | tee -a "$log_file" || status=$?

if [ "$status" -ne 0 ]; then
  echo "e2e: 演练失败（退出码 $status），完整输出在 $log_file" >&2
else
  echo "e2e: 演练通过，完整输出在 $log_file"
fi

exit "$status"
