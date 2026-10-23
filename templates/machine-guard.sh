#!/usr/bin/env bash
set -u
NPROC=${CORES:-$(nproc)}
LOAD_MAX=${LOAD_MAX:-$((NPROC + 4))}
AVAIL_MIN_MB=${AVAIL_MIN_MB:-3072}
DISK_MIN_GB=${DISK_MIN_GB:-15}
TMP_MAX_MB=${TMP_MAX_MB:-4096}
IDLE_MAX_MIN=${IDLE_MAX_MIN:-20}
IDLE_STATE=${HEAVY_IDLE_STATE:?}
LOCK=${HEAVY_LOCK:?}
DISK_PATH=${DISK_PATH:-$HOME}
HEAVY=${HEAVY_RUN:?}
HEAVY_STATUS=${HEAVY_STATUS:?}
HEAVY_MAIN=${HEAVY_MAIN:?}
UNAME=$(uname -s)

# Probes. Only these small functions branch on the OS: Linux keeps /proc, GNU df and procps ps;
# Darwin uses sysctl, vm_stat, df -P, BSD ps and pgrep.
is_darwin() { [ "$UNAME" = Darwin ]; }

load_1() { if is_darwin; then sysctl -n vm.loadavg | tr -d '{}' | awk '{print $1}'; else cut -d' ' -f1 /proc/loadavg; fi; }
load_3() { if is_darwin; then sysctl -n vm.loadavg | tr -d '{}' | awk '{print $1, $2, $3}'; else cut -d' ' -f1-3 /proc/loadavg; fi; }
mem_avail() {
  if is_darwin; then
    vm_stat | awk -v s="$(sysctl -n hw.pagesize)" '/Pages (free|inactive|speculative|purgeable):/{gsub(/\./,"",$NF); p+=$NF} END{print int(p*s/1048576)}'
  else
    awk '/MemAvailable/{print int($2/1024)}' /proc/meminfo
  fi
}
swap_free() {
  if is_darwin; then
    sysctl -n vm.swapusage | awk '{for (i = 1; i < NF; i++) if ($i == "free" && $(i + 1) == "=") { v = $(i + 2); u = substr(v, length(v)); sub(/[MG]$/, "", v); print int(u == "G" ? v * 1024 : v); exit }}'
  else
    awk '/SwapFree/{print int($2/1024)}' /proc/meminfo
  fi
}
home_free() {
  if is_darwin; then df -Pk "$DISK_PATH" | awk 'NR==2{print int($4/1048576)}'
  else df -BG --output=avail "$DISK_PATH" | tail -1 | tr -dc 0-9; fi
}
top_rss() { if is_darwin; then ps -Ao rss,etime,args -m; else ps -eo rss,etime,args --sort=-rss; fi; }
top_cpu() { if is_darwin; then ps -Ao pcpu,etime,args -r; else ps -eo pcpu,etime,args --sort=-pcpu; fi; }
child_pids() { if is_darwin; then pgrep -P "$1" 2>/dev/null; else ps -o pid= --ppid "$1" 2>/dev/null; fi; }
# CPU ticks (1/100 s) of one pid; 0 when the process is gone.
proc_ticks() {
  if is_darwin; then
    ps -o time= -p "$1" 2>/dev/null | awk '{d = 0; t = $1; if (index(t, "-")) { split(t, x, "-"); d = x[1]; t = x[2] } n = split(t, a, ":"); s = 0; for (i = 1; i <= n; i++) s = s * 60 + a[i]; print int((d * 86400 + s) * 100 + 0.5)} END{if (NR == 0) print 0}'
  else
    awk '{sub(/^.*\) /,""); print $12+$13}' "/proc/$1/stat" 2>/dev/null || echo 0
  fi
}

tree_ticks() {
  local pids=("$1") i=0 kids t=0 p
  while [ $i -lt ${#pids[@]} ]; do
    kids=$(child_pids "${pids[$i]}"); for p in $kids; do pids+=("$p"); done; i=$((i + 1))
  done
  for p in "${pids[@]}"; do
    t=$((t + $(proc_ticks "$p")))
  done
  echo "$t"
}

lock_check() {
  local owner pid now ticks spid sts sticks
  if [ "$("$HEAVY_STATUS" "$HEAVY_MAIN" heavy-run --status 2>/dev/null)" = "free" ]; then rm -f "$IDLE_STATE"; return; fi
  owner=$(cat "${HEAVY_OWNER:?}" 2>/dev/null)
  pid=$(sed -nE 's/.*\| pid ([0-9]+).*/\1/p' <<<"$owner")
  [ -n "$pid" ] || { ALERTS+=("heavy-lock busy but owner file empty: find holder with fuser $LOCK"); return; }
  kill -0 "$pid" 2>/dev/null || { ALERTS+=("heavy-lock owner pid $pid is dead: $owner"); return; }
  now=$(date +%s); ticks=$(tree_ticks "$pid")
  spid=""; [ -f "$IDLE_STATE" ] && read -r spid sts sticks < "$IDLE_STATE"
  if [ "$spid" != "$pid" ] || [ $((ticks - sticks)) -ge ${IDLE_MIN_TICKS:-300} ]; then echo "$pid $now $ticks" > "$IDLE_STATE"; return; fi
  [ $(( (now - sts) / 60 )) -ge "$IDLE_MAX_MIN" ] && ALERTS+=("heavy-lock holder HUNG: <3s CPU in $(( (now - sts) / 60 ))min: $owner (pstree -p $pid; kill and rerun)")
}

snapshot() {
  local load avail swapfree disk
  load=$(load_1)
  avail=$(mem_avail)
  swapfree=$(swap_free)
  disk=$(home_free)
  ALERTS=()
  awk -v l="$load" -v m="$LOAD_MAX" 'BEGIN{exit !(l>m)}' && ALERTS+=("load $load > $LOAD_MAX")
  [ "$avail" -lt "$AVAIL_MIN_MB" ] && ALERTS+=("MemAvailable ${avail}MB < ${AVAIL_MIN_MB}MB")
  [ "$disk" -lt "$DISK_MIN_GB" ] && ALERTS+=("/home free ${disk}G < ${DISK_MIN_GB}G")
  # macOS: /tmp is on the disk the check above covers, so there is no separate tmpfs to check.
  if ! is_darwin; then
    tmpmb=$(df -BM --output=used /tmp | tail -1 | tr -dc 0-9)
    [ "$tmpmb" -gt "$TMP_MAX_MB" ] && ALERTS+=("/tmp (RAM tmpfs) ${tmpmb}MB > ${TMP_MAX_MB}MB: move scratch to ${WORK_ROOT}, see du -xsh /tmp/*")
  fi
  lock_check
  echo "$(date +%H:%M:%S) load=$(load_3) cores=$NPROC avail=${avail}MB swapfree=${swapfree}MB home_free=${disk}G"
  echo "heavy-lock: $("$HEAVY" --status 2>&1 | head -1)"
  echo "containers: $(docker ps -q 2>/dev/null | wc -l) running; CI job: $(docker ps --format '{{.Names}}' 2>/dev/null | grep -c '^runner-')"
  echo "top RSS:"
  top_rss | awk 'NR>1 && NR<=6{printf "  %5dMB %11s %s\n",$1/1024,$2,substr($0,index($0,$3),90)}'
  echo "top CPU:"
  top_cpu | awk 'NR>1 && NR<=6{printf "  %5s%% %11s %s\n",$1,$2,substr($0,index($0,$3),90)}'
  if [ ${#ALERTS[@]} -gt 0 ]; then printf 'ALERT: %s\n' "${ALERTS[@]}"; return 1; fi
  echo "OK"
}

oom_count() { command -v journalctl >/dev/null 2>&1 || { echo 0; return; }; journalctl -k --since "$1" 2>/dev/null | grep -ci 'out of memory: killed'; }

if [ "${1:-}" != "--watch" ]; then snapshot; exit $?; fi

start=$(date '+%Y-%m-%d %H:%M:%S')
streak=0
while :; do
  if [ "$(oom_count "$start")" -gt 0 ]; then
    echo "ALERT: OOM kill since $start"; journalctl -k --since "$start" | grep -i 'out of memory' | tail -3
    snapshot; exit 2
  fi
  if out=$(snapshot); then streak=0; else streak=$((streak + 1)); fi
  if [ "$streak" -ge "${WATCH_STREAK:-3}" ]; then echo "$out"; exit 1; fi
  sleep "${WATCH_SEC:-60}"
done
