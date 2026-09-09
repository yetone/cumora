#!/usr/bin/env bash
# Trusted root bootstrap for the agent-computer image.
#
# This script is PID 1. It performs only mount preparation and FUSE readiness
# validation, then execs setpriv -> non-root tini -> agent-entrypoint. Keeping
# the root phase small is deliberate: browser, OpenCLI, Node, and their
# children are never started while this process still has capabilities.
set -Eeuo pipefail
umask 077

MODEL_UID=65532
MODEL_GID=65532
FUSE_UID=65533
BOOTSTRAP_PID=$$
RUN_DIR=/run/cumora
TOKEN_FILE="$RUN_DIR/fuse-token"
WORKSPACE=/workspace
FUSE_BIN=/usr/local/bin/cumora-fuse
SUPERVISOR=/usr/local/bin/agent-entrypoint
READY_TIMEOUT_SECONDS="${CUMORA_FUSE_READY_TIMEOUT_SECONDS:-60}"

fail() {
  echo "[agent-bootstrap] $1" >&2
  exit 1
}

stop_fuse_during_bootstrap_failure() {
  local pid=${FUSE_PID:-}
  [[ "$pid" =~ ^[1-9][0-9]*$ ]] || return 0
  kill -TERM "$pid" 2>/dev/null || true
  # No model has started yet. If the daemon is stuck in mount setup, do not
  # leave a root child holding the container open while the bootstrap exits.
  sleep 0.2
  kill -KILL "$pid" 2>/dev/null || true
}

if [[ "$(id -u)" -ne 0 ]]; then
  fail 'must start as root'
fi

if [[ ! -x "$FUSE_BIN" || ! -x /usr/bin/setpriv || ! -x /usr/bin/tini ]]; then
  fail 'required runtime binaries are missing'
fi
if [[ ! -x "$SUPERVISOR" ]]; then
  fail 'agent supervisor is missing'
fi
if [[ ! "$READY_TIMEOUT_SECONDS" =~ ^[1-9][0-9]*$ ]]; then
  fail 'invalid FUSE readiness timeout'
fi

cap_has() {
  local hex=$1 bit=$2 value
  value=$((16#$hex))
  (( (value & (1 << bit)) != 0 ))
}

require_capability() {
  local name=$1 bit=$2 hex
  hex=$(awk '/^CapEff:/ { print $2; exit }' "/proc/$BOOTSTRAP_PID/status")
  if [[ -z "$hex" ]] || ! cap_has "$hex" "$bit"; then
    fail "missing bootstrap capability: $name"
  fi
}

# SYS_ADMIN mounts FUSE; SETUID/SETGID and SETPCAP are required for the Go
# driver's all-thread demotion. Failing before model startup is part of the
# boundary and is covered by the negative image smoke.
require_capability CAP_SYS_ADMIN 21
require_capability CAP_SETUID 7
require_capability CAP_SETGID 6
require_capability CAP_SETPCAP 8
require_capability CAP_KILL 5

if [[ -L "$WORKSPACE" ]]; then
  fail '/workspace must not be a symlink'
fi
mkdir -p "$WORKSPACE"
workspace_owner=$(stat -c '%u:%g' "$WORKSPACE") || fail 'cannot inspect /workspace'
[[ "$workspace_owner" == "0:0" ]] || fail '/workspace is not root-owned'
workspace_mode=$(stat -c '%a' "$WORKSPACE") || fail 'cannot inspect /workspace mode'
workspace_mode_value=$((8#$workspace_mode))
# Group/world write would make an unmounted local directory a model write
# surface. The image creates 0755; a PVC or operator override must remain
# root-owned and equally non-writable.
(( (workspace_mode_value & 0022) == 0 )) || fail '/workspace is writable outside root'

if [[ -L "$RUN_DIR" ]]; then
  fail "$RUN_DIR must not be a symlink"
fi
mkdir -p "$RUN_DIR"
run_owner=$(stat -c '%u:%g' "$RUN_DIR") || fail 'cannot inspect token directory'
[[ "$run_owner" == "0:0" ]] || fail 'token directory is not root-owned'
chmod 0700 "$RUN_DIR"
run_mode=$(stat -c '%a' "$RUN_DIR") || fail 'cannot inspect token directory mode'
[[ "$run_mode" == "700" ]] || fail 'token directory is not private'

if [[ -z "${CUMORA_AGENT_RUNTIME_URL:-}" ]]; then
  fail 'CUMORA_AGENT_RUNTIME_URL is required'
fi
if [[ -z "${CUMORA_AGENT_RUNTIME_TOKEN:-}" ]]; then
  fail 'CUMORA_AGENT_RUNTIME_TOKEN is required'
fi

if [[ -e "$TOKEN_FILE" || -L "$TOKEN_FILE" ]]; then
  fail 'stale FUSE token file exists'
fi
printf '%s' "$CUMORA_AGENT_RUNTIME_TOKEN" >"$TOKEN_FILE"
chmod 0400 "$TOKEN_FILE"
token_owner=$(stat -c '%u:%g:%a' "$TOKEN_FILE") || fail 'cannot inspect FUSE token'
[[ "$token_owner" == "0:0:400" ]] || fail 'FUSE token has unsafe ownership or mode'

NOTIFY_FIFO="$RUN_DIR/notify.$$.fifo"
rm -f "$NOTIFY_FIFO"
mkfifo -m 0600 "$NOTIFY_FIFO"

cleanup_bootstrap() {
  rm -f "$NOTIFY_FIFO" "$TOKEN_FILE"
}
trap cleanup_bootstrap EXIT
trap 'stop_fuse_during_bootstrap_failure; exit 143' INT TERM

# Opening the FIFO read/write in this root process prevents startup races.
# READY and lifetime are two write descriptions of this same FIFO, as checked
# by cumora-fuse. The child closes the bootstrap description before execing Go,
# and this process replaces itself after closing its own writer, so no
# parent/model writer can keep EOF from arriving on the lifetime read end.
exec 3<>"$NOTIFY_FIFO"
(
  exec 4>"$NOTIFY_FIFO"
  exec 5>"$NOTIFY_FIFO"
  exec 3>&-
  exec env -u CUMORA_AGENT_RUNTIME_TOKEN \
    CUMORA_FUSE_TOKEN_FILE="$TOKEN_FILE" \
    CUMORA_FUSE_READY_FD=4 \
    CUMORA_FUSE_LIFETIME_FD=5 \
    /usr/local/bin/cumora-fuse \
      --runtime-base-url "$CUMORA_AGENT_RUNTIME_URL" \
      --mount-point "$WORKSPACE" \
      --token-file "$TOKEN_FILE" \
      --ready-fd 4 \
      --lifetime-fd 5 \
      --log-file /tmp/cumora-fuse.log
) &
FUSE_PID=$!

# One read description is duplicated so READY cannot be consumed by the
# lifetime reader. Bootstrap reads fd 7, then closes it; the same open-file
# description remains as fd 8 for the post-setpriv supervisor.
exec 7<"$NOTIFY_FIFO"
exec 8<&7
exec 3>&-
rm -f "$NOTIFY_FIFO"

marker=''
if ! IFS= read -r -t "$READY_TIMEOUT_SECONDS" marker <&7; then
  stop_fuse_during_bootstrap_failure
  fail 'FUSE readiness timed out'
fi
if [[ "$marker" != READY ]]; then
  stop_fuse_during_bootstrap_failure
  fail 'unexpected FUSE readiness marker'
fi

mount_is_expected() {
  awk '$5 == "/workspace" { sep=0; for (i=6; i<=NF; i++) { if ($i == "-") { sep=i; break } } if (sep > 0 && $(sep+1) == "fuse.cumora-workspace" && $(sep+2) == "cumora-workspace") count++ } END { exit(count == 1 ? 0 : 1) }' /proc/self/mountinfo
}

proc_snapshot() {
  local line rest
  [[ -r "/proc/$1/stat" ]] || return 1
  line=$(<"/proc/$1/stat") || return 1
  rest=${line##*) }
  [[ "$rest" != "$line" ]] || return 1
  awk '{ print $1, $20 }' <<<"$rest"
}

if ! mount_is_expected; then
  stop_fuse_during_bootstrap_failure
  fail 'FUSE READY arrived without the expected /workspace mount'
fi
fuse_snapshot=$(proc_snapshot "$FUSE_PID") || {
  stop_fuse_during_bootstrap_failure
  fail 'FUSE process disappeared after READY'
}
read -r fuse_state FUSE_STARTTIME <<<"$fuse_snapshot"
case "$fuse_state" in
  R|S|D) ;;
  *) stop_fuse_during_bootstrap_failure; fail 'FUSE process is not live after READY' ;;
esac
if [[ ! "$FUSE_STARTTIME" =~ ^[0-9]+$ ]]; then
  stop_fuse_during_bootstrap_failure
  fail 'FUSE process is not live after READY'
fi

printf '%s\n' "$FUSE_PID" >"$RUN_DIR/fuse.pid"
chmod 0400 "$RUN_DIR/fuse.pid"

# The token file is no longer needed after READY and is removed before any
# model process exists. The runtime token environment remains available to
# the legitimate Node/runtime client; only the FUSE child receives an env -u
# override above. The bearer is never placed in the FUSE argv.
rm -f "$TOKEN_FILE"
exec 7<&-

export CUMORA_FUSE_PID="$FUSE_PID"
export CUMORA_FUSE_STARTTIME="$FUSE_STARTTIME"
export CUMORA_FUSE_LIFETIME_FD=8

# Preserve fd 8 through setpriv and non-root tini. The bootstrap shell itself
# is replaced, so there is no long-lived root process around the model.
exec /usr/bin/setpriv \
  --reuid="$MODEL_UID" \
  --regid="$MODEL_GID" \
  --clear-groups \
  --inh-caps=-all \
  --ambient-caps=-all \
  --bounding-set=-all \
  --no-new-privs \
  /usr/bin/tini -- "$SUPERVISOR"
