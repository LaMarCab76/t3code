#!/bin/sh
# All paths arrive as arguments, never as interpolated shell source.
set -eu
app=$1
candidate=$2
backup=$3
job=$4
parent_pid=$5
parent_started=$6
binary=$7
version=$8
token=$9
receipt="$job/receipt"
status="$job/status"
new_pid=
replaced=false
write_status() { printf '%s\n' "$1" > "$status.tmp"; /bin/mv -f "$status.tmp" "$status"; printf '%s\n' "$1"; }
rollback() {
  trap - EXIT HUP INT TERM
  if [ -n "$new_pid" ]; then
    # Only the process spawned by this helper can be stopped here.
    /bin/kill -TERM "$new_pid" 2>/dev/null || true
    i=0
    while /bin/kill -0 "$new_pid" 2>/dev/null && [ "$i" -lt 15 ]; do /bin/sleep 1; i=$((i+1)); done
    if /bin/kill -0 "$new_pid" 2>/dev/null; then
      write_status 'failed: new process did not exit; backup retained'
      exit 1
    fi
  fi
  if [ "$replaced" = true ]; then
    /bin/mv "$app" "$candidate" || true
    /bin/mv "$backup" "$app" || { write_status 'failed: restore backup manually'; exit 1; }
    /usr/bin/open "$app" || true
  fi
  write_status 'rolled-back'
  exit 1
}
trap rollback EXIT HUP INT TERM
write_status 'waiting-for-exit'
i=0
while /bin/kill -0 "$parent_pid" 2>/dev/null; do
  actual=$(/bin/ps -p "$parent_pid" -o lstart= 2>/dev/null || true)
  [ "$actual" = "$parent_started" ] || break
  [ "$i" -lt 90 ] || { write_status 'failed: app did not exit'; trap - EXIT; exit 1; }
  /bin/sleep 1
  i=$((i+1))
done
/usr/bin/codesign --verify --deep --strict "$candidate"
write_status 'replacing'
/bin/mv "$app" "$backup"
# Mark before the second rename so a failed rename restores the backup.
replaced=true
if ! /bin/mv "$candidate" "$app"; then
  /bin/mv "$backup" "$app"
  replaced=false
  /usr/bin/open "$app" || true
  exit 1
fi
write_status 'starting'
"$app/Contents/MacOS/$binary" "--t3-fork-update-receipt=$receipt" "--t3-fork-update-token=$token" >> "$job/launch.log" 2>&1 &
new_pid=$!
i=0
while [ "$i" -lt 90 ]; do
  if [ -f "$receipt" ] && [ "$(/bin/cat "$receipt")" = "$version $token" ]; then
    write_status 'complete'
    trap - EXIT HUP INT TERM
    exit 0
  fi
  /bin/kill -0 "$new_pid" 2>/dev/null || exit 1
  /bin/sleep 1
  i=$((i+1))
done
exit 1
