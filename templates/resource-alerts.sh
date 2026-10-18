#!/usr/bin/env bash
set -u
THRESH_TEMP=${THRESH_TEMP:-90}
THRESH_MEM=${THRESH_MEM:-30}
THRESH_IO=${THRESH_IO:-40}
COOLDOWN=${COOLDOWN:-600}
STATE_DIR=${ALERT_STATE:?}
mkdir -p "$STATE_DIR"

alert() {
    local last now
    last=$(cat "$STATE_DIR/$1" 2>/dev/null || echo 0)
    now=$(date +%s)
    if (( now - last >= COOLDOWN )); then
        echo "$now" > "$STATE_DIR/$1"
        notify-send -u critical -a "resource-alerts" "$2" "$3" || true
    fi
}

temp=$(sensors -u 2>/dev/null | awk '$1=="Tctl:"{f=1} f && /temp1_input/{print int($2); exit}')
mem=$(awk '/^some avg10/{print int($2)}' /proc/pressure/memory 2>/dev/null)
io=$(awk '/^full avg10/{print int($2)}' /proc/pressure/io 2>/dev/null)

[[ "$temp" =~ ^[0-9]+$ ]] && (( temp > THRESH_TEMP )) && \
    alert temp "CPU overheating: ${temp}°C" "Tctl above ${THRESH_TEMP}°C — check fans/load"
[[ "$mem"  =~ ^[0-9]+$ ]] && (( mem  > THRESH_MEM  )) && \
    alert mem "Memory pressure: ${mem}%" "PSI some avg10 above ${THRESH_MEM}% — OOM/freeze risk"
[[ "$io"   =~ ^[0-9]+$ ]] && (( io   > THRESH_IO   )) && \
    alert io "IO pressure: ${io}%" "PSI full avg10 above ${THRESH_IO}% — disk stall in progress"

exit 0
