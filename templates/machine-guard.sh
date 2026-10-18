#!/usr/bin/env bash
set -u
NPROC=$(nproc)
LOAD_MAX=${LOAD_MAX:-$((NPROC + 4))}
AVAIL_MIN_MB=${AVAIL_MIN_MB:-3072}
DISK_MIN_GB=${DISK_MIN_GB:-15}
TMP_MAX_MB=${TMP_MAX_MB:-4096}
IDLE_MAX_MIN=${IDLE_MAX_MIN:-20}
IDLE_STATE=${HEAVY_IDLE_STATE:?}
LOCK=${HEAVY_LOCK:?}
DISK_PATH=${DISK_PATH:-$HOME}
HEAVY=${HEAVY_RUN:?}

tree_ticks() {
  local pids=("$1") i=0 kids t=0 p
  while [ $i -lt ${#pids[@]} ]; do
    kids=$(ps -o pid= --ppid "${pids[$i]}" 2>/dev/null); for p in $kids; do pids+=("$p"); done; i=$((i + 1))
  done
  for p in "${pids[@]}"; do
    t=$((t + $(awk '{sub(/^.*\) /,""); print $12+$13}' "/proc/$p/stat" 2>/dev/null || echo 0)))
  done
  echo "$t"
}

lock_check() {
  local owner pid now ticks spid sts sticks
  if flock -n "$LOCK" true 2>/dev/null; then rm -f "$IDLE_STATE"; return; fi
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
  load=$(cut -d' ' -f1 /proc/loadavg)
  avail=$(awk '/MemAvailable/{print int($2/1024)}' /proc/meminfo)
  swapfree=$(awk '/SwapFree/{print int($2/1024)}' /proc/meminfo)
  disk=$(df -BG --output=avail "$DISK_PATH" | tail -1 | tr -dc 0-9)
  ALERTS=()
  awk -v l="$load" -v m="$LOAD_MAX" 'BEGIN{exit !(l>m)}' && ALERTS+=("load $load > $LOAD_MAX")
  [ "$avail" -lt "$AVAIL_MIN_MB" ] && ALERTS+=("MemAvailable ${avail}MB < ${AVAIL_MIN_MB}MB")
  [ "$disk" -lt "$DISK_MIN_GB" ] && ALERTS+=("/home free ${disk}G < ${DISK_MIN_GB}G")
  tmpmb=$(df -BM --output=used /tmp | tail -1 | tr -dc 0-9)
  [ "$tmpmb" -gt "$TMP_MAX_MB" ] && ALERTS+=("/tmp (RAM tmpfs) ${tmpmb}MB > ${TMP_MAX_MB}MB: move scratch to ${WORK_ROOT}, see du -xsh /tmp/*")
  lock_check
  echo "$(date +%H:%M:%S) load=$(cut -d' ' -f1-3 /proc/loadavg) cores=$NPROC avail=${avail}MB swapfree=${swapfree}MB home_free=${disk}G"
  echo "heavy-lock: $("$HEAVY" --status 2>&1 | head -1)"
  echo "containers: $(docker ps -q 2>/dev/null | wc -l) running; CI job: $(docker ps --format '{{.Names}}' 2>/dev/null | grep -c '^runner-')"
  echo "top RSS:"
  ps -eo rss,etime,args --sort=-rss | awk 'NR>1 && NR<=6{printf "  %5dMB %11s %s\n",$1/1024,$2,substr($0,index($0,$3),90)}'
  echo "top CPU:"
  ps -eo pcpu,etime,args --sort=-pcpu | awk 'NR>1 && NR<=6{printf "  %5s%% %11s %s\n",$1,$2,substr($0,index($0,$3),90)}'
  if [ ${#ALERTS[@]} -gt 0 ]; then printf 'ALERT: %s\n' "${ALERTS[@]}"; return 1; fi
  echo "OK"
}

oom_count() { journalctl -k --since "$1" 2>/dev/null | grep -ci 'out of memory: killed'; }

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
