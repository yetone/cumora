#!/usr/bin/env bash
# Already-demoted agent-computer supervisor.
#
# This path is deliberately kept separate from the trusted bootstrap. It is
# only valid after setpriv has switched the process to UID 65532 with no
# capabilities and NoNewPrivs=1. Direct root invocation is a fail-closed
# configuration error; there is no compatibility path back to the old root
# entrypoint.
set -Eeuo pipefail

MODEL_UID=65532
MODEL_GID=65532
FUSE_UID=65533
FUSE_LIFETIME_FD="${CUMORA_FUSE_LIFETIME_FD:-8}"
FUSE_PID="${CUMORA_FUSE_PID:-}"
FUSE_STARTTIME="${CUMORA_FUSE_STARTTIME:-}"
WORKSPACE=/workspace
FAILURE_MARKER=/tmp/cumora-fuse-supervisor-failure
SUPERVISOR_PID=$$

if [[ "$(id -u)" -eq 0 ]]; then
  echo "[agent-supervisor] refusing direct root invocation" >&2
  exit 126
fi

if [[ "$(id -u)" != "$MODEL_UID" || "$(id -g)" != "$MODEL_GID" ]]; then
  echo "[agent-supervisor] unexpected model identity" >&2
  exit 126
fi

if [[ ! "$FUSE_PID" =~ ^[1-9][0-9]*$ || ! "$FUSE_STARTTIME" =~ ^[0-9]+$ ]]; then
  echo "[agent-supervisor] missing FUSE lifecycle identity" >&2
  exit 126
fi

if [[ ! "$FUSE_LIFETIME_FD" =~ ^[0-9]+$ ]]; then
  echo "[agent-supervisor] invalid FUSE lifetime FD" >&2
  exit 126
fi

if [[ ! -L "/proc/self/fd/$FUSE_LIFETIME_FD" ]]; then
  echo "[agent-supervisor] FUSE lifetime FD is not inherited" >&2
  exit 126
fi

status_value() {
  local key=$1
  awk -v key="$key" '$1 == key ":" { print $2; exit }' "/proc/$SUPERVISOR_PID/status"
}

status_four_values() {
  local key=$1
  awk -v key="$key" '$1 == key ":" { printf "%s %s %s %s\n", $2, $3, $4, $5; exit }' "/proc/$SUPERVISOR_PID/status"
}

# setpriv is the boundary, but keep a local assertion next to the consumers
# so a future launcher cannot silently reintroduce a privileged model.
if [[ "$(status_four_values Uid)" != "$MODEL_UID $MODEL_UID $MODEL_UID $MODEL_UID" || "$(status_four_values Gid)" != "$MODEL_GID $MODEL_GID $MODEL_GID $MODEL_GID" ]]; then
  echo "[agent-supervisor] /proc identity check failed" >&2
  exit 126
fi
if [[ -n "$(awk '$1 == "Groups:" { $1=""; sub(/^[[:space:]]+/, ""); print; exit }' "/proc/$SUPERVISOR_PID/status")" ]]; then
  echo "[agent-supervisor] supplementary groups are present" >&2
  exit 126
fi
for cap in CapInh CapPrm CapEff CapBnd CapAmb; do
  if [[ "$(status_value "$cap")" != "0000000000000000" ]]; then
    echo "[agent-supervisor] $cap is not empty" >&2
    exit 126
  fi
done
if [[ "$(status_value NoNewPrivs)" != "1" ]]; then
  echo "[agent-supervisor] NoNewPrivs is not set" >&2
  exit 126
fi

proc_snapshot() {
  # /proc/<pid>/stat has a parenthesized comm field. Strip through its final
  # ')' before asking awk for state (field 1) and starttime (field 20).
  local pid=$1 line rest
  [[ -r "/proc/$pid/stat" ]] || return 1
  line=$(<"/proc/$pid/stat") || return 1
  rest=${line##*) }
  [[ "$rest" != "$line" ]] || return 1
  awk '{ print $1, $20 }' <<<"$rest"
}

fuse_alive_with_same_starttime() {
  local state starttime
  read -r state starttime < <(proc_snapshot "$FUSE_PID") || return 1
  case "$state" in
    R|S|D) ;;
    *) return 1 ;;
  esac
  [[ "$starttime" == "$FUSE_STARTTIME" ]]
}

workspace_mount_is_expected() {
  [[ -r /proc/self/mountinfo ]] || return 1
  # Mountpoint is field 5. After the separator, the filesystem type and
  # source must remain the product's FUSE values. Scan once per health check;
  # starting an awk process for every mountinfo line would fork repeatedly
  # while the monitor runs once per second.
  awk '$5 == "/workspace" { sep=0; for (i=6; i<=NF; i++) { if ($i == "-") { sep=i; break } } if (sep > 0 && $(sep+1) == "fuse.cumora-workspace" && $(sep+2) == "cumora-workspace") count++ } END { exit(count == 1 ? 0 : 1) }' /proc/self/mountinfo
}

fuse_failure() {
  local reason=$1
  # Keep the marker non-sensitive and one-line so the fixture/CI can prove the
  # failure path without exposing URLs, JWTs, or process environments.
  printf 'reason=%s\n' "$reason" >"$FAILURE_MARKER"
  chmod 0644 "$FAILURE_MARKER"
  kill -TERM "$SUPERVISOR_PID" 2>/dev/null || true
}

monitor_fuse() {
  local byte rc
  trap - TERM INT
  while :; do
    if ! fuse_alive_with_same_starttime; then
      fuse_failure 'process-dead-or-replaced'
      return 1
    fi
    if ! workspace_mount_is_expected; then
      fuse_failure 'mount-missing-or-unexpected'
      return 1
    fi

    # cumora-fuse never writes the lifetime pipe. A byte is a protocol error;
    # EOF means the daemon exited. Timeout lets us re-check /proc and mountinfo
    # while the writer remains open. Bash returns 142 for read timeout and 1
    # for EOF on this descriptor.
    if IFS= read -r -t 1 -n 1 byte <&"$FUSE_LIFETIME_FD"; then
      fuse_failure 'unexpected-lifetime-data'
      return 1
    else
      rc=$?
      if [[ "$rc" -eq 1 ]]; then
        fuse_failure 'lifetime-eof'
        return 1
      fi
      if [[ "$rc" -ne 142 ]]; then
        fuse_failure 'lifetime-read-error'
        return 1
      fi
    fi
  done
}

CHROME_PROFILE_DIR="${CHROME_PROFILE_DIR:-/opt/chrome-profile}"
OPENCLI_EXTENSION_DIR="${OPENCLI_EXTENSION_DIR:-/opt/opencli-extension}"
CHROMIUM_BIN="${CHROMIUM_BIN:-/usr/bin/chromium}"
DISPLAY="${DISPLAY:-:99}"
export DISPLAY HOME USER LOGNAME XDG_CONFIG_HOME XDG_CACHE_HOME XDG_RUNTIME_DIR

# The profile may be a PVC. It must be prepared by the image or the runtime's
# fsGroup; this process never recursively chowns attacker-writable state.
if [[ ! -d "$CHROME_PROFILE_DIR" || ! -w "$CHROME_PROFILE_DIR" ]]; then
  echo "[agent-supervisor] Chrome profile is not writable by model UID" >&2
  exit 1
fi
rm -f "$CHROME_PROFILE_DIR/SingletonLock" \
      "$CHROME_PROFILE_DIR/SingletonCookie" \
      "$CHROME_PROFILE_DIR/SingletonSocket"

if ! fuse_alive_with_same_starttime || ! workspace_mount_is_expected; then
  echo "[agent-supervisor] FUSE boundary is not ready" >&2
  exit 1
fi

XVFB_PID=''
CHROME_PID=''
OPENCLI_DOCTOR_PID=''
LOOP_PID=''
MONITOR_PID=''
STOPPING=0
EXIT_STATUS=0

children_of() {
  pgrep -P "$1" 2>/dev/null || true
}

kill_tree() {
  local pid=$1 child
  [[ "$pid" =~ ^[1-9][0-9]*$ ]] || return 0
  while read -r child; do
    [[ "$child" =~ ^[1-9][0-9]*$ ]] || continue
    kill_tree "$child"
    kill -TERM "$child" 2>/dev/null || true
  done < <(children_of "$pid")
  kill -TERM "$pid" 2>/dev/null || true
}

model_processes() {
  # The container has one model identity. Restrict discovery to this UID and
  # the known executables so a fixture cannot terminate unrelated host state.
  pgrep -u "$MODEL_UID" -f '(^|/)(Xvfb|chromium|chromium-browser|opencli|node)( |$)' 2>/dev/null || true
}

stop_model_processes() {
  local pid
  for pid in "$LOOP_PID" "$CHROME_PID" "$XVFB_PID" "$OPENCLI_DOCTOR_PID"; do
    [[ "$pid" =~ ^[1-9][0-9]*$ ]] || continue
    kill_tree "$pid"
  done
  while read -r pid; do
    [[ "$pid" =~ ^[1-9][0-9]*$ ]] || continue
    kill -TERM "$pid" 2>/dev/null || true
  done < <(model_processes)
}

shutdown() {
  [[ "$STOPPING" -eq 0 ]] || return 0
  STOPPING=1
  trap - TERM INT

  # Stop the observer first. The FUSE daemon is a separate UID and is never
  # signalled here; its parent-death signal and namespace teardown own it.
  if [[ "$MONITOR_PID" =~ ^[1-9][0-9]*$ ]]; then
    kill -TERM "$MONITOR_PID" 2>/dev/null || true
  fi
  stop_model_processes

  local i alive pid
  for i in {1..40}; do
    alive=0
    while read -r pid; do
      [[ "$pid" =~ ^[1-9][0-9]*$ ]] || continue
      if kill -0 "$pid" 2>/dev/null; then
        alive=1
        break
      fi
    done < <(model_processes)
    [[ "$alive" -eq 0 ]] && break
    sleep 0.25
  done

  while read -r pid; do
    [[ "$pid" =~ ^[1-9][0-9]*$ ]] || continue
    kill -KILL "$pid" 2>/dev/null || true
  done < <(model_processes)

  if [[ "$MONITOR_PID" =~ ^[1-9][0-9]*$ ]]; then
    wait "$MONITOR_PID" 2>/dev/null || true
  fi
}

trap 'shutdown' EXIT

on_signal() {
  EXIT_STATUS=143
  shutdown
  if [[ -s "$FAILURE_MARKER" ]]; then
    EXIT_STATUS=70
  fi
  exit "$EXIT_STATUS"
}

trap on_signal TERM INT

# The observer runs before any browser or model process. Its only way to stop
# the FUSE daemon is to let this non-root PID 1 exit; it never relies on
# cross-UID kill(2) or kill -0(2).
monitor_fuse &
MONITOR_PID=$!

# ─── Xvfb ─────────────────────────────────────────────────────────────
Xvfb "$DISPLAY" -screen 0 1280x800x24 -ac +extension RANDR +extension GLX \
  -nolisten tcp >/tmp/xvfb.log 2>&1 &
XVFB_PID=$!

i=0
while [[ "$i" -lt 50 ]]; do
  [[ -e "/tmp/.X${DISPLAY#:}-lock" ]] && break
  if ! kill -0 "$XVFB_PID" 2>/dev/null; then
    echo "[agent-supervisor] Xvfb exited before display became ready" >&2
    EXIT_STATUS=1
    shutdown
    exit "$EXIT_STATUS"
  fi
  sleep 0.1
  i=$((i + 1))
done
if [[ ! -e "/tmp/.X${DISPLAY#:}-lock" ]]; then
  echo "[agent-supervisor] Xvfb display readiness timed out" >&2
  EXIT_STATUS=1
  shutdown
  exit "$EXIT_STATUS"
fi

# ─── Chromium ─────────────────────────────────────────────────────────
"$CHROMIUM_BIN" \
  --no-sandbox \
  --disable-setuid-sandbox \
  --disable-dev-shm-usage \
  --disable-gpu \
  --no-first-run \
  --no-default-browser-check \
  --disable-default-apps \
  --disable-features=Translate,MediaRouter \
  --remote-debugging-port=9222 \
  --user-data-dir="$CHROME_PROFILE_DIR" \
  --load-extension="$OPENCLI_EXTENSION_DIR" \
  --window-size=1280,800 \
  about:blank >/tmp/chromium.log 2>&1 &
CHROME_PID=$!

# OpenCLI's daemon is deliberately started in the already-demoted context.
# A transient doctor failure is left to the runtime call to report; the image
# smoke explicitly exercises the real doctor/browser path.
if command -v opencli >/dev/null 2>&1; then
  opencli doctor >/tmp/opencli-doctor.log 2>&1 &
  OPENCLI_DOCTOR_PID=$!
fi

# ─── agent loop ───────────────────────────────────────────────────────
node /app/agent-computer.cjs &
LOOP_PID=$!

# Polling keeps this script portable across the Debian bash versions used by
# local ARM64 and Linux CI images while still reacting promptly to observer
# failures and model completion.
while :; do
  if ! kill -0 "$LOOP_PID" 2>/dev/null; then
    wait "$LOOP_PID" 2>/dev/null || EXIT_STATUS=$?
    break
  fi
  if ! kill -0 "$MONITOR_PID" 2>/dev/null && [[ "$STOPPING" -eq 0 ]]; then
    EXIT_STATUS=70
    shutdown
    break
  fi
  sleep 0.2
done

shutdown
if [[ -s "$FAILURE_MARKER" ]]; then
  EXIT_STATUS=70
fi
exit "$EXIT_STATUS"
