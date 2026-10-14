#!/usr/bin/env bash
# Tests for the optional CLAUDE_STATUSLINE_EXTRAS segments of statusline.sh.
# Run:  bash statusline/tests/extras.sh      (needs bash, jq, git; takes a few seconds)
# Exits non-zero if any expectation fails. Uses a temp HOME, cache dir and PATH shims,
# and removes them on exit; nothing outside the temp directory is written.
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo=$(cd "$here/../.." && pwd)
new=$repo/statusline/statusline.sh
tmp=$(mktemp -d) || exit 1
trap 'rm -rf "$tmp"' EXIT
fails=0; checks=0

ok() { checks=$((checks + 1)); if [ "$2" = "$3" ]; then :; else
  fails=$((fails + 1)); printf 'FAIL: %s\n  expected: [%s]\n  actual:   [%s]\n' "$1" "$2" "$3"; fi; }

# Hermetic PATH: only the tools the script needs, so a missing shim means a missing command.
bin=$tmp/bin; mkdir -p "$bin"
for t in jq git sed head date cat timeout grep wc mv mkdir rm dirname mktemp tr sleep; do
  p=$(command -v "$t") && ln -s "$p" "$bin/$t"
done
shims=$tmp/shims; mkdir -p "$shims"
export HOME=$tmp/home XDG_CACHE_HOME=$tmp/cache
mkdir -p "$HOME"
cache=$XDG_CACHE_HOME/claude-statusline
calls=$tmp/calls
unset CLAUDE_STATUSLINE_EXTRAS CLAUDE_STATUSLINE_ICONS
export CLAUDE_STATUSLINE_PALETTE=/dev/null

git -C "$repo" show HEAD:statusline/statusline.sh > "$tmp/old.sh" 2>/dev/null || cp "$new" "$tmp/old.sh"

mkshim() { # name, body
  printf '#!/bin/sh\n%s\n' "$2" > "$shims/$1"; chmod +x "$shims/$1"; }
run() { # script input [extra PATH dirs first] ; env passes through. prints output
  local s=$1 in=$2 p=$bin
  [ -n "$3" ] && p=$3:$bin
  printf '%s' "$in" | PATH=$p "$BASH" "$s" 2>"$tmp/stderr"; echo "rc=$?" >"$tmp/rc"; }
plain() { sed $'s/\033\\[[0-9;]*m//g'; }
# Two runs happen at different instants, so the rendered time-left token (for example
# "↻2h30m" or "↻1d2h") may differ by one unit. Mask only that token; everything else
# must still match byte for byte. Token well-formedness is asserted separately.
norm() { sed -E 's/↻([0-9]+d[0-9]+h|[0-9]+h[0-9]{2}m)/↻T/g'; }
# Poll a shell condition every 0.1 s, up to 10 s, returning as soon as it holds.
wait_for() { local _; for _ in $(seq 1 100); do eval "$1" && return 0; sleep 0.1; done; return 1; }
ncalls() { if [ -e "$calls" ]; then wc -l < "$calls" | tr -d ' '; else echo 0; fi; }
yn() { if "$@"; then echo yes; else echo no; fi; }

now=$(date +%s)
mkin() { # used_pct resets_in_seconds
  jq -n --arg d "$repo" --argjson u "$1" --argjson r "$(( now + $2 ))" \
    '{model:{display_name:"Opus"},effort:{level:"high"},workspace:{current_dir:$d,project_dir:$d},
      context_window:{used_percentage:42},
      rate_limits:{five_hour:{used_percentage:$u,resets_at:$r},seven_day:{used_percentage:10,resets_at:($r+86400)}}}'; }
mkjson() { # used_pct resets_at_json_value
  jq -n --arg d "$repo" --argjson u "$1" --argjson r "$2" \
    '{model:{display_name:"Opus"},workspace:{current_dir:$d,project_dir:$d},
      rate_limits:{five_hour:{used_percentage:$u,resets_at:$r}}}'; }
in_a=$(mkin 80 9000); in_b=$(mkin 50 9000); in_c=$(mkin 10 9000)
in_min='{"model":{"id":"claude-x"}}'
in_empty='{}'
base=$(run "$tmp/old.sh" "$in_min" "" | plain)

# Shims that would produce output if the extras leaked in while disabled.
mkshim checkupdates 'echo a; echo b; echo c'
mkshim systemctl 'echo "x.service failed"'

# 1. Unset (and unknown names): byte-identical to the previous script.
for i in "$in_a" "$in_b" "$in_c" "$in_min" "$in_empty"; do
  o=$(run "$tmp/old.sh" "$i" "$shims" | norm)
  ok "unset identical" "$o" "$(run "$new" "$i" "$shims" | norm)"
  ok "unknown name identical" "$o" "$(CLAUDE_STATUSLINE_EXTRAS=bogus,jobs run "$new" "$i" "$shims" | norm)"
  ok "plain unset identical" "$(CLAUDE_STATUSLINE_ICONS=plain run "$tmp/old.sh" "$i" "$shims" | norm)" \
    "$(CLAUDE_STATUSLINE_ICONS=plain run "$new" "$i" "$shims" | norm)"
  ok "unset exit status" "rc=0" "$(cat "$tmp/rc")"
done
o=$(run "$new" "$in_a" "$shims" | plain)
ok "time-left token well-formed (5h)" "yes" "$(grep -qE '5h .* [0-9]+%.? ?↻[0-9]+h[0-9]{2}m' <<<"$o" && echo yes || echo no)"
ok "time-left token well-formed (7d)" "yes" "$(grep -qE '7d .*↻[0-9]+d[0-9]+h' <<<"$o" && echo yes || echo no)"
ok "no cache dir created when disabled" "no" "$([ -e "$cache" ] && echo yes || echo no)"

# 2. updates
export CLAUDE_STATUSLINE_EXTRAS=updates
mkshim checkupdates 'echo x >> '"$calls"'; echo a; echo b; echo c'
o=$(run "$new" "$in_min" "$shims" | plain)
ok "updates: cold cache hides segment" "$base" "$o"
wait_for "grep -q ' 3\$' '$cache/updates' 2>/dev/null"
o=$(run "$new" "$in_min" "$shims" | plain)
ok "updates: shows count after background refresh" "yes" "$(grep -q '3' <<<"$o" && echo yes || echo no)"
run "$new" "$in_min" "$shims" >/dev/null; run "$new" "$in_min" "$shims" >/dev/null
sleep 0.3
ok "updates: fresh cache does not rerun checkupdates" "1" "$(ncalls)"
# stale cache: stale value served, refresh runs once in the background
printf '%s 7\n' "$(( now - 4000 ))" > "$cache/updates"
o=$(run "$new" "$in_min" "$shims" | plain)
ok "updates: stale value served" "yes" "$(grep -q '7' <<<"$o" && echo yes || echo no)"
wait_for "grep -q ' 3\$' '$cache/updates' 2>/dev/null"
sleep 0.3
ok "updates: stale cache triggers exactly one refresh" "2" "$(ncalls)"
# zero updates hides (checkupdates exits 2 with no output)
mkshim checkupdates 'exit 2'
printf '%s 7\n' "$(( now - 4000 ))" > "$cache/updates"
run "$new" "$in_min" "$shims" >/dev/null
wait_for "grep -q ' 0\$' '$cache/updates' 2>/dev/null"
ok "updates: zero hidden" "$base" "$(run "$new" "$in_min" "$shims" | plain)"
# missing checkupdates
rm -rf "$cache"
o=$(run "$new" "$in_min" "")
ok "updates: missing command output" "$base" "$(plain <<<"$o")"
ok "updates: missing command rc" "rc=0" "$(cat "$tmp/rc")"
ok "updates: missing command stderr" "" "$(cat "$tmp/stderr")"
# unwritable cache dir
mkshim checkupdates 'echo x >> '"$calls"'; echo a'
: > "$tmp/notadir"
rm -f "$calls"
o=$(XDG_CACHE_HOME=$tmp/notadir run "$new" "$in_min" "$shims")
ok "updates: unwritable cache rc" "rc=0" "$(cat "$tmp/rc")"
ok "updates: unwritable cache stderr" "" "$(cat "$tmp/stderr")"
ok "updates: unwritable cache output" "$base" "$(plain <<<"$o")"
sleep 0.3
ok "updates: unwritable cache never runs checkupdates" "no" "$([ -e "$calls" ] && echo yes || echo no)"
# garbage cache contents are tolerated and treated as stale / zero
mkshim checkupdates 'exit 2'
for g in 'garbage' 'abc def' '' '12' '-5 -5' '9999999999 xyz'; do
  mkdir -p "$cache"; printf '%s\n' "$g" > "$cache/updates"
  o=$(run "$new" "$in_min" "$shims")
  ok "updates: garbage cache [$g] output" "$base" "$(plain <<<"$o")"
  ok "updates: garbage cache [$g] rc" "rc=0" "$(cat "$tmp/rc")"
  ok "updates: garbage cache [$g] stderr" "" "$(cat "$tmp/stderr")"
  sleep 0.2
done
# a fresh cache is served without running checkupdates at all
mkshim checkupdates 'echo x >> '"$calls"'; echo a'
rm -f "$calls"; printf '%s 5\n' "$(date +%s)" > "$cache/updates"
o=$(CLAUDE_STATUSLINE_ICONS=plain run "$new" "$in_min" "$shims" | plain)
sleep 0.3
ok "updates: fresh cache count shown" "yes" "$(grep -q 'upd 5$' <<<"$o" && echo yes || echo no)"
ok "updates: fresh cache skips checkupdates" "0" "$(ncalls)"
# a stale cache returns immediately even when checkupdates is slow
mkshim checkupdates 'sleep 3; echo a; echo b'
printf '%s 7\n' "$(( $(date +%s) - 4000 ))" > "$cache/updates"
t0=$(date +%s%N)
o=$(CLAUDE_STATUSLINE_ICONS=plain run "$new" "$in_min" "$shims" | plain)
ms=$(( ($(date +%s%N) - t0) / 1000000 ))
ok "updates: stale value shown while refresh is slow" "yes" "$(grep -q 'upd 7$' <<<"$o" && echo yes || echo no)"
ok "updates: slow checkupdates does not block" "yes" "$([ "$ms" -lt 2000 ] && echo yes || echo no)"
wait_for "grep -q ' 2\$' '$cache/updates' 2>/dev/null"
# plain mode ASCII
mkdir -p "$cache"; printf '%s 4\n' "$now" > "$cache/updates"
o=$(CLAUDE_STATUSLINE_ICONS=plain run "$new" "$in_min" "$shims" | plain)
ok "updates: plain shows count" "yes" "$(grep -q '4' <<<"$o" && echo yes || echo no)"
ok "updates: plain is ASCII" "no" "$(LC_ALL=C grep -q -P '[^\x00-\x7F]' <<<"$o" && echo yes || echo no)"

# 3. failed
export CLAUDE_STATUSLINE_EXTRAS=failed
mkshim systemctl 'case "$*" in *--user*) echo "u.service failed";; *) echo "a.service failed"; echo "b.service failed";; esac'
o=$(run "$new" "$in_min" "$shims" | plain)
ok "failed: counts system + user" "yes" "$(grep -q '3' <<<"$o" && echo yes || echo no)"
o=$(CLAUDE_STATUSLINE_ICONS=plain run "$new" "$in_min" "$shims" | plain)
ok "failed: plain is ASCII" "no" "$(LC_ALL=C grep -q -P '[^\x00-\x7F]' <<<"$o" && echo yes || echo no)"
mkshim systemctl 'case "$*" in *--user*) echo "u.service failed"; echo "v.service failed";; *) :;; esac'
o=$(CLAUDE_STATUSLINE_ICONS=plain run "$new" "$in_min" "$shims" | plain)
ok "failed: user units alone counted" "yes" "$(grep -q 'failed 2$' <<<"$o" && echo yes || echo no)"
mkshim systemctl 'case "$*" in *--user*) :;; *) echo "a.service failed";; esac'
o=$(CLAUDE_STATUSLINE_ICONS=plain run "$new" "$in_min" "$shims" | plain)
ok "failed: system units alone counted" "yes" "$(grep -q 'failed 1$' <<<"$o" && echo yes || echo no)"
mkshim systemctl 'case "$*" in *--user*) echo "u.service failed";; *) echo "a.service failed"; echo "b.service failed";; esac'
o=$(CLAUDE_STATUSLINE_ICONS=plain run "$new" "$in_min" "$shims" | plain)
ok "failed: exact system + user total" "yes" "$(grep -q 'failed 3$' <<<"$o" && echo yes || echo no)"
mkshim systemctl 'exit 0'
ok "failed: zero hidden" "$base" "$(run "$new" "$in_min" "$shims" | plain)"
o=$(run "$new" "$in_min" "")
ok "failed: missing systemctl output" "$base" "$(plain <<<"$o")"
ok "failed: missing systemctl rc" "rc=0" "$(cat "$tmp/rc")"
ok "failed: missing systemctl stderr" "" "$(cat "$tmp/stderr")"
mkshim systemctl 'sleep 10'
s=$(date +%s)
ok "failed: hung systemctl bounded" "$base" "$(run "$new" "$in_min" "$shims" | plain)"
ok "failed: hung systemctl returns quickly" "yes" "$([ $(( $(date +%s) - s )) -le 6 ] && echo yes || echo no)"

# 4. burn (window is 5h; 9000s left = half elapsed)
export CLAUDE_STATUSLINE_EXTRAS=burn
o=$(run "$new" "$in_a" "" | plain)
ok "burn: ahead shows up arrow" "yes" "$(grep -q '80%.*↑' <<<"$o" && echo yes || echo no)"
o=$(run "$new" "$in_b" "" | plain)
ok "burn: level shows right arrow" "yes" "$(grep -q '50%.*→' <<<"$o" && echo yes || echo no)"
o=$(run "$new" "$in_c" "" | plain)
ok "burn: behind hidden" "no" "$(grep -q '[↑→↓]' <<<"$o" && echo yes || echo no)"
ok "burn: no data hidden" "$base" "$(run "$new" "$in_min" "" | plain)"
o=$(CLAUDE_STATUSLINE_ICONS=plain run "$new" "$in_a" "" | plain | sed 's/[▰▱↻]//g')
ok "burn: plain is ASCII" "no" "$(LC_ALL=C grep -q -P '[^\x00-\x7F]' <<<"$o" && echo yes || echo no)"

# burn boundaries: elapsed share is 50 (9000s left, tolerant to a few minutes of drift)
for c in "60:level" "61:up" "40:level" "39:none" "0:none" "100:up"; do
  o=$(run "$new" "$(mkjson "${c%%:*}" "$(( now + 9000 ))")" "" | plain)
  case "${c##*:}" in
    up) w=yes; a='↑' ;; level) w=yes; a='→' ;; none) w=no; a='' ;; esac
  if [ "$w" = yes ]; then g=$(grep -q "${c%%:*}%.* $a" <<<"$o" && echo yes || echo no)
  else g=$(grep -q '[↑→↓]' <<<"$o" && echo yes || echo no); fi
  ok "burn: used ${c%%:*}% -> ${c##*:}" "$w" "$g"
done
ok "burn: 10 points ahead is level not ahead" "no" "$(run "$new" "$(mkjson 60 "$(( now + 9000 ))")" "" | grep -q '↑' && echo yes || echo no)"
# window just opened with nothing used: level
o=$(run "$new" "$(mkjson 0 "$(( now + 17900 ))")" "" | plain)
ok "burn: unused fresh window is level" "yes" "$(grep -q '0%.* →' <<<"$o" && echo yes || echo no)"
# reset already passed, or further away than a 5h window: no arrow
o=$(run "$new" "$(mkjson 80 "$(( now - 100 ))")" "" | plain)
ok "burn: reset in the past hidden" "no" "$(grep -q '[↑→↓]' <<<"$o" && echo yes || echo no)"
ok "burn: past reset rc" "rc=0" "$(cat "$tmp/rc")"
o=$(run "$new" "$(mkjson 80 "$(( now + 20000 ))")" "" | plain)
ok "burn: reset beyond window hidden" "no" "$(grep -q '[↑→↓]' <<<"$o" && echo yes || echo no)"
# resets_at given as an ISO string
iso=$(date -u -d "@$(( now + 9000 ))" +%Y-%m-%dT%H:%M:%SZ)
o=$(run "$new" "$(mkjson 80 "\"$iso\"")" "" | plain)
ok "burn: ISO resets_at ahead" "yes" "$(grep -q '80%.*↑' <<<"$o" && echo yes || echo no)"
o=$(run "$new" "$(mkjson 50 "\"$iso\"")" "" | plain)
ok "burn: ISO resets_at level" "yes" "$(grep -q '50%.*→' <<<"$o" && echo yes || echo no)"
o=$(run "$new" "$(mkjson 80 '"not a date"')" "" | plain)
ok "burn: unparseable resets_at hidden" "no" "$(grep -q '[↑→↓]' <<<"$o" && echo yes || echo no)"
ok "burn: unparseable resets_at stderr" "" "$(cat "$tmp/stderr")"
# fractional used percentage
o=$(run "$new" "$(mkjson 80.7 "$(( now + 9000 ))")" "" | plain)
ok "burn: fractional percentage ahead" "yes" "$(grep -q '↑' <<<"$o" && echo yes || echo no)"

# 5. ordering and unknown names
mkshim checkupdates 'exit 2'
mkshim systemctl 'case "$*" in *--user*) echo "u.service failed";; *) echo "a.service failed"; echo "b.service failed";; esac'
mkdir -p "$cache"; printf '%s 4\n' "$(date +%s)" > "$cache/updates"
export CLAUDE_STATUSLINE_ICONS=plain
old_plain=$(run "$tmp/old.sh" "$in_a" "$shims" | plain | norm)
for list in "updates,failed" "failed,updates" " updates , failed " "bogus,updates,jobs,failed"; do
  o=$(CLAUDE_STATUSLINE_EXTRAS=$list run "$new" "$in_a" "$shims" | plain | norm)
  ok "extras appended last, fixed order [$list]" "$old_plain  |  upd 4  failed 3" "$o"
done
o=$(CLAUDE_STATUSLINE_EXTRAS=bogus,jobs run "$new" "$in_a" "$shims" | plain | norm)
ok "unknown names only: nothing added" "$old_plain" "$o"
o=$(CLAUDE_STATUSLINE_EXTRAS=bogus,failed run "$new" "$in_min" "$shims" | plain)
ok "unknown name does not hide a known one" "yes" "$(grep -q 'failed 3$' <<<"$o" && echo yes || echo no)"
unset CLAUDE_STATUSLINE_ICONS

# 6. robust against empty and invalid input with every extra on
export CLAUDE_STATUSLINE_EXTRAS=updates,failed,burn
for bad in '{}' 'not json' '' '[]' '{"rate_limits":"x"}' '{"rate_limits":{"five_hour":{"used_percentage":50,"resets_at":"zzz"}}}'; do
  o=$(run "$new" "$bad" "$shims")
  ok "robust [$bad] rc" "rc=0" "$(cat "$tmp/rc")"
  ok "robust [$bad] stderr" "" "$(cat "$tmp/stderr")"
  ok "robust [$bad] single line" "1" "$(printf '%s\n' "$o" | wc -l | tr -d ' ')"
done

if [ "$fails" -eq 0 ]; then echo "extras: all $checks checks passed"; exit 0; fi
echo "extras: $fails of $checks checks failed"; exit 1
