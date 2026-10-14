#!/usr/bin/env bash
# Tests for statusline.sh: output stability with the extras off, and the optional
# CLAUDE_STATUSLINE_EXTRAS segments (updates, failed, burn).
# Run:  bash statusline/tests/extras.sh      (needs bash, jq, git; takes about 15 s)
# Exits non-zero if any expectation fails. Uses a temp HOME, cache dir, working directory
# and PATH shims, and removes them on exit; nothing outside the temp directory is written.
#
# Golden files (statusline/tests/golden/*.out) are the output of the script as it was before
# the extras existed, i.e. the main tip 4b1ef70, for the inputs in golden/*.json. They were
# produced with:
#   git show 4b1ef70:statusline/statusline.sh > /tmp/previous.sh
#   GOLDEN_FROM=/tmp/previous.sh bash statusline/tests/extras.sh
# That run rewrites the .out files from the given script and exits without testing. The
# suite itself never reads git history. Inputs carry placeholders (@DIR@ work directory,
# @R5@/@R7@ reset times) filled in at run time. Only the time-left token (the arrow-and-
# duration after a meter) is masked as "↻T" in the golden files and in the compared output,
# since it depends on the clock; its shape is asserted separately.
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo=$(cd "$here/../.." && pwd)
new=$repo/statusline/statusline.sh
golden=$here/golden
script=${GOLDEN_FROM:-$new}
tmp=$(mktemp -d) || exit 1
trap 'rm -rf "$tmp"' EXIT
fails=0; checks=0

ok() { checks=$((checks + 1)); if [ "$2" = "$3" ]; then :; else
  fails=$((fails + 1)); printf 'FAIL: %s\n  expected: [%s]\n  actual:   [%s]\n' "$1" "$2" "$3"; fi; }
has() { if grep -qE -- "$1" <<<"$2"; then echo yes; else echo no; fi; }

# Hermetic PATH: only the tools the script needs, so a missing shim means a missing command.
bin=$tmp/bin; mkdir -p "$bin"
for t in jq git sed head date cat timeout grep wc mv mkdir rm dirname mktemp tr sleep find; do
  p=$(command -v "$t") && ln -s "$p" "$bin/$t"
done
shims=$tmp/shims; mkdir -p "$shims"
work=$tmp/work/proj; mkdir -p "$work"      # not a git repository: no branch segment
export HOME=$tmp/home XDG_CACHE_HOME=$tmp/cache
mkdir -p "$HOME"
cache=$XDG_CACHE_HOME/claude-statusline
calls=$tmp/calls
unset CLAUDE_STATUSLINE_EXTRAS CLAUDE_STATUSLINE_ICONS
export CLAUDE_STATUSLINE_PALETTE=$tmp/no-such-palette.toml

mkshim() { # name, body
  printf '#!/bin/sh\n%s\n' "$2" > "$shims/$1"; chmod +x "$shims/$1"; }
# render EXTRAS ICONS INPUT [PATH dirs first]: the variables are set only for this command
# ("" leaves them unset). Prints the output; status goes to $tmp/rc, stderr to $tmp/stderr.
render() {
  local e=() p=$bin
  [ -n "$1" ] && e+=("CLAUDE_STATUSLINE_EXTRAS=$1")
  [ -n "$2" ] && e+=("CLAUDE_STATUSLINE_ICONS=$2")
  [ -n "$4" ] && p=$4:$bin
  printf '%s' "$3" | env -u CLAUDE_STATUSLINE_EXTRAS -u CLAUDE_STATUSLINE_ICONS "${e[@]}" \
    PATH="$p" "$BASH" "$script" 2>"$tmp/stderr"
  echo "rc=$?" >"$tmp/rc"
}
plain() { sed $'s/\033\\[[0-9;]*m//g'; }
norm() { sed -E 's/↻([0-9]+d[0-9]+h|[0-9]+h[0-9]{2}m)/↻T/g'; }
# Poll a shell condition every 0.1 s, up to 10 s, returning as soon as it holds.
wait_for() { local _; for _ in $(seq 1 100); do eval "$1" && return 0; sleep 0.1; done; return 1; }
nolocks() { local f; for f in "$cache"/*.lock; do [ -e "$f" ] && return 1; done; return 0; }
settle() { wait_for nolocks; }                 # background refreshes finished
ncalls() { if [ -e "$calls" ]; then wc -l < "$calls" | tr -d ' '; else echo 0; fi; }
reset_cache() { rm -rf "$cache"; rm -f "$calls"; }
setcache() { mkdir -p "$cache"; printf '%s\n' "$2" > "$cache/$1"; }
ms() { echo $(( $(date +%s%N) / 1000000 )); }

now=$(date +%s)
fill() { sed "s|@DIR@|$work|g; s|@R5@|$(( now + 9000 ))|g; s|@R7@|$(( now + 90000 ))|g" "$1"; }
mkin() { # used_pct resets_in_seconds
  jq -n --arg d "$work" --argjson u "$1" --argjson r "$(( now + $2 ))" \
    '{model:{display_name:"Opus"},effort:{level:"high"},workspace:{current_dir:$d,project_dir:$d},
      context_window:{used_percentage:42},
      rate_limits:{five_hour:{used_percentage:$u,resets_at:$r},seven_day:{used_percentage:10,resets_at:($r+86400)}}}'; }
mkjson() { # used_pct_json resets_at_json_value
  jq -n --arg d "$work" --argjson u "$1" --argjson r "$2" \
    '{model:{display_name:"Opus"},workspace:{current_dir:$d,project_dir:$d},
      rate_limits:{five_hour:{used_percentage:$u,resets_at:$r}}}'; }
in_a=$(mkin 80 9000); in_b=$(mkin 50 9000); in_c=$(mkin 10 9000)
in_min='{"model":{"id":"claude-x"}}'
base=$(render "" "" "$in_min" | plain)

# 0. Regenerate the golden files from the script named by GOLDEN_FROM, then stop.
if [ -n "$GOLDEN_FROM" ]; then
  for f in "$golden"/*.json; do
    n=${f%.json}
    render "" "" "$(fill "$f")" | norm > "$n.default.out"
    render "" plain "$(fill "$f")" | norm > "$n.plain.out"
  done
  echo "golden files rewritten from $GOLDEN_FROM"; exit 0
fi

# Shims that would produce output if the extras leaked in while disabled.
mkshim checkupdates 'echo a; echo b; echo c'
mkshim systemctl 'echo "x.service failed"'

# 1. Extras off (unset, or only unknown names): byte-identical to the previous script.
golden_check() { # label expected_file extras icons input
  local label=$1 want=$2
  checks=$((checks + 1))
  render "$3" "$4" "$5" "$shims" | norm > "$tmp/actual"
  if ! cmp -s "$want" "$tmp/actual"; then
    fails=$((fails + 1)); printf 'FAIL: %s\n' "$label"; diff -u "$want" "$tmp/actual" | cat -v | head -20
  fi
  ok "$label exit status" "rc=0" "$(cat "$tmp/rc")"
  ok "$label stderr" "" "$(cat "$tmp/stderr")"
}
n_golden=0
for f in "$golden"/*.json; do
  n=${f%.json}; b=$(basename "$n"); inp=$(fill "$f"); n_golden=$((n_golden + 1))
  golden_check "golden $b default" "$n.default.out" "" "" "$inp"
  golden_check "golden $b plain" "$n.plain.out" "" plain "$inp"
  golden_check "golden $b default, unknown names" "$n.default.out" "bogus,jobs" "" "$inp"
  golden_check "golden $b plain, unknown names" "$n.plain.out" "bogus,jobs" plain "$inp"
done
ok "golden inputs present" "yes" "$([ "$n_golden" -ge 6 ] && echo yes || echo no)"
o=$(render "" "" "$(fill "$golden/full.json")" | plain)
ok "time-left token well-formed (5h)" "yes" "$(has '5h .* [0-9]+% ↻[0-9]+h[0-9]{2}m' "$o")"
ok "time-left token well-formed (7d)" "yes" "$(has '7d .* [0-9]+% ↻[0-9]+d[0-9]+h' "$o")"
ok "no cache dir created when disabled" "no" "$([ -e "$cache" ] && echo yes || echo no)"

# 2. updates
reset_cache
mkshim checkupdates 'echo x >> '"$calls"'; echo a; echo b; echo c'
o=$(render updates "" "$in_min" "$shims" | plain)
ok "updates: cold cache hides segment" "$base" "$o"
settle
o=$(render updates "" "$in_min" "$shims" | plain)
ok "updates: shows count after background refresh" "yes" "$(has ' 3$' "$o")"
render updates "" "$in_min" "$shims" >/dev/null; render updates "" "$in_min" "$shims" >/dev/null
settle
ok "updates: fresh cache does not rerun checkupdates" "1" "$(ncalls)"
ok "updates: no lock left after refresh" "yes" "$(nolocks && echo yes || echo no)"
# stale cache: stale value served at once, refresh runs once in the background
setcache updates "$(( now - 4000 )) 7"
o=$(render updates "" "$in_min" "$shims" | plain)
ok "updates: stale value served" "yes" "$(has ' 7$' "$o")"
settle
ok "updates: stale cache triggers exactly one refresh" "2" "$(ncalls)"
# zero updates hides (checkupdates exits 2 with no output)
mkshim checkupdates 'exit 2'
setcache updates "$(( now - 4000 )) 7"
render updates "" "$in_min" "$shims" >/dev/null; settle
ok "updates: zero hidden" "$base" "$(render updates "" "$in_min" "$shims" | plain)"
# a failing refresh still stamps the cache, so it is not retried on every render
mkshim checkupdates 'echo x >> '"$calls"'; exit 1'
reset_cache
render updates "" "$in_min" "$shims" >/dev/null; settle
for _ in 1 2 3; do render updates "" "$in_min" "$shims" >/dev/null; done
settle
ok "updates: failing refresh is not retried per render" "1" "$(ncalls)"
read -r ts _ < "$cache/updates"
ok "updates: failing refresh stamps the cache" "yes" "$([[ $ts =~ ^[0-9]+$ ]] && [ "$ts" -ge "$now" ] && echo yes || echo no)"
reset_cache; setcache updates "$(( now - 4000 )) 7"
render updates "" "$in_min" "$shims" >/dev/null; settle
o=$(render updates "" "$in_min" "$shims" | plain)
ok "updates: failing refresh keeps the previous count" "yes" "$(has ' 7$' "$o")"
ok "updates: failing refresh ran once" "1" "$(ncalls)"
# missing checkupdates
reset_cache
o=$(render updates "" "$in_min" "")
ok "updates: missing command output" "$base" "$(plain <<<"$o")"
ok "updates: missing command rc" "rc=0" "$(cat "$tmp/rc")"
ok "updates: missing command stderr" "" "$(cat "$tmp/stderr")"
# unwritable cache dir
mkshim checkupdates 'echo x >> '"$calls"'; echo a'
: > "$tmp/notadir"
reset_cache
o=$(XDG_CACHE_HOME=$tmp/notadir render updates "" "$in_min" "$shims")
ok "updates: unwritable cache rc" "rc=0" "$(cat "$tmp/rc")"
ok "updates: unwritable cache stderr" "" "$(cat "$tmp/stderr")"
ok "updates: unwritable cache output" "$base" "$(plain <<<"$o")"
sleep 0.3
ok "updates: unwritable cache never runs checkupdates" "0" "$(ncalls)"
# garbage and extreme cache contents: tolerated, nothing on stderr
mkshim checkupdates 'exit 2'
for g in 'garbage' 'abc def' '' '12' '-5 -5' '9999999999 xyz' '08 99999999999999999999' \
         "$now 99999999999999999999" "$(( now + 100000 )) 5" '99999999999999999999 5'; do
  reset_cache; setcache updates "$g"
  o=$(render updates "" "$in_min" "$shims")
  ok "updates: odd cache [$g] rc" "rc=0" "$(cat "$tmp/rc")"
  ok "updates: odd cache [$g] stderr" "" "$(cat "$tmp/stderr")"
  ok "updates: odd cache [$g] output is one line" "1" "$(printf '%s\n' "$o" | wc -l | tr -d ' ')"
  settle
done
# a future-dated stamp is not trusted: the cache is refreshed and re-stamped
reset_cache; setcache updates "$(( now + 100000 )) 5"
render updates "" "$in_min" "$shims" >/dev/null; settle
read -r ts n < "$cache/updates"
ok "updates: future stamp replaced" "yes" "$([ "$ts" -le "$(( $(date +%s) + 5 ))" ] && echo yes || echo no)"
ok "updates: future stamp refreshed count" "0" "$n"
# a fresh cache is served without running checkupdates at all
mkshim checkupdates 'echo x >> '"$calls"'; echo a'
reset_cache; setcache updates "$(date +%s) 5"
o=$(render updates plain "$in_min" "$shims" | plain)
sleep 0.3
ok "updates: fresh cache count shown" "yes" "$(has 'upd 5$' "$o")"
ok "updates: fresh cache skips checkupdates" "0" "$(ncalls)"
ok "updates: plain is ASCII" "no" "$(LC_ALL=C grep -q -P '[^\x00-\x7F]' <<<"$o" && echo yes || echo no)"
# a stale cache returns immediately even when checkupdates is slow
mkshim checkupdates 'sleep 3; echo a; echo b'
setcache updates "$(( $(date +%s) - 4000 )) 7"
t0=$(ms)
o=$(render updates plain "$in_min" "$shims" | plain)
el=$(( $(ms) - t0 ))
ok "updates: stale value shown while refresh is slow" "yes" "$(has 'upd 7$' "$o")"
ok "updates: slow checkupdates does not block" "yes" "$([ "$el" -lt 2000 ] && echo yes || echo no)"
settle

# 2b. updates: the claim is atomic and stale locks are recovered
mkshim checkupdates 'echo x >> '"$calls"'; sleep 1; echo a'
reset_cache
for _ in 1 2 3 4 5 6; do render updates "" "$in_min" "$shims" >/dev/null 2>&1 & done
wait
settle
ok "updates: 6 simultaneous renders run checkupdates once" "1" "$(ncalls)"
mkshim checkupdates 'echo x >> '"$calls"'; echo a'
lockcase() { # label lock_setup_cmd expected_calls
  reset_cache; mkdir -p "$cache/updates.lock"
  eval "$2"
  render updates "" "$in_min" "$shims" >/dev/null
  sleep 0.5
  ok "updates lock: $1" "$3" "$(ncalls)"
}
lockcase "old valid timestamp is stolen" "echo $(( now - 1000 )) > '$cache/updates.lock/ts'" 1
ok "updates lock: stolen lock removed after refresh" "yes" "$(settle && echo yes || echo no)"
lockcase "young timestamp is respected" "echo $(( $(date +%s) - 10 )) > '$cache/updates.lock/ts'" 0
ok "updates lock: respected lock left in place" "yes" "$([ -d "$cache/updates.lock" ] && echo yes || echo no)"
lockcase "timestamp-less lock with old mtime is stolen" "touch -d '1 hour ago' '$cache/updates.lock'" 1
lockcase "timestamp-less young lock is respected" ":" 0
lockcase "garbage timestamp with old mtime is stolen" "echo junk > '$cache/updates.lock/ts'; touch -d '1 hour ago' '$cache/updates.lock'" 1
settle

# 3. failed (cached like updates: prime the cache, then render again)
failed_render() { # icons  -> output after a refresh has completed
  reset_cache
  render failed "$1" "$in_min" "$shims" >/dev/null; settle
  render failed "$1" "$in_min" "$shims" | plain
}
mkshim systemctl 'case "$*" in *--user*) echo "u.service failed";; *) echo "a.service failed"; echo "b.service failed";; esac'
ok "failed: cold cache hides segment" "$base" "$(reset_cache; render failed "" "$in_min" "$shims" | plain)"; settle
o=$(failed_render plain)
ok "failed: counts system + user" "yes" "$(has 'failed 3$' "$o")"
ok "failed: plain is ASCII" "no" "$(LC_ALL=C grep -q -P '[^\x00-\x7F]' <<<"$o" && echo yes || echo no)"
o=$(failed_render "")
ok "failed: default icons show count" "yes" "$(has ' 3$' "$o")"
mkshim systemctl 'case "$*" in *--user*) echo "u.service failed"; echo "v.service failed";; *) :;; esac'
ok "failed: user units alone counted" "yes" "$(has 'failed 2$' "$(failed_render plain)")"
mkshim systemctl 'case "$*" in *--user*) :;; *) echo "a.service failed";; esac'
ok "failed: system units alone counted" "yes" "$(has 'failed 1$' "$(failed_render plain)")"
mkshim systemctl 'exit 0'
ok "failed: zero hidden" "$base" "$(failed_render "")"
mkshim systemctl 'echo x >> '"$calls"'; exit 1'
reset_cache
render failed "" "$in_min" "$shims" >/dev/null; settle
for _ in 1 2 3; do render failed "" "$in_min" "$shims" >/dev/null; done
settle
ok "failed: refresh with failing probe still runs systemctl only per ttl" "yes" "$([ "$(ncalls)" -le 2 ] && echo yes || echo no)"
# missing systemctl
reset_cache
o=$(render failed "" "$in_min" "")
ok "failed: missing systemctl output" "$base" "$(plain <<<"$o")"
ok "failed: missing systemctl rc" "rc=0" "$(cat "$tmp/rc")"
ok "failed: missing systemctl stderr" "" "$(cat "$tmp/stderr")"
# a hung systemctl never blocks a render: with a cached value the render is immediate
mkshim systemctl 'exec sleep 10'
reset_cache; setcache failed "$(( $(date +%s) - 100 )) 4"
t0=$(ms)
o=$(render failed plain "$in_min" "$shims" | plain)
el=$(( $(ms) - t0 ))
ok "failed: hung systemctl serves the cached count" "yes" "$(has 'failed 4$' "$o")"
ok "failed: hung systemctl render is quick" "yes" "$([ "$el" -lt 2500 ] && echo yes || echo no)"
ok "failed: hung systemctl rc" "rc=0" "$(cat "$tmp/rc")"
ok "failed: hung systemctl stderr" "" "$(cat "$tmp/stderr")"
settle
# a cold cache with a hung systemctl also returns at once and shows nothing
reset_cache
t0=$(ms)
o=$(render failed "" "$in_min" "$shims" | plain)
el=$(( $(ms) - t0 ))
ok "failed: hung systemctl cold render output" "$base" "$o"
ok "failed: hung systemctl cold render is quick" "yes" "$([ "$el" -lt 2500 ] && echo yes || echo no)"
settle

# 4. burn (window is 5h; 9000s left = half elapsed, stable for a few minutes of drift)
for c in "60:level" "61:up" "40:level" "39:none" "0:none" "100:up"; do
  o=$(render burn "" "$(mkjson "${c%%:*}" "$(( now + 9000 ))")" | plain)
  case "${c##*:}" in
    up) g=$(has "${c%%:*}%.* ↑" "$o"); w=yes ;;
    level) g=$(has "${c%%:*}%.* →" "$o"); w=yes ;;
    none) g=$(has '[↑→↓]' "$o"); w=no ;;
  esac
  ok "burn: used ${c%%:*}% -> ${c##*:}" "$w" "$g"
done
o=$(render burn "" "$in_a" | plain); ok "burn: ahead shows up arrow" "yes" "$(has '80%.*↑' "$o")"
o=$(render burn "" "$in_b" | plain); ok "burn: level shows right arrow" "yes" "$(has '50%.*→' "$o")"
o=$(render burn "" "$in_c" | plain); ok "burn: behind hidden" "no" "$(has '[↑→↓]' "$o")"
ok "burn: no data hidden" "$base" "$(render burn "" "$in_min" | plain)"
o=$(render burn plain "$in_a" | plain | sed 's/[▰▱↻]//g')
ok "burn: plain is ASCII" "no" "$(LC_ALL=C grep -q -P '[^\x00-\x7F]' <<<"$o" && echo yes || echo no)"
o=$(render burn plain "$in_a" | plain)
ok "burn: plain ahead arrow" "yes" "$(has '80%.* \^' "$o")"
o=$(render burn "" "$(mkjson 0 "$(( now + 17900 ))")" | plain)
ok "burn: unused fresh window is level" "yes" "$(has '0%.* →' "$o")"
o=$(render burn "" "$(mkjson 80 "$(( now - 100 ))")" | plain)
ok "burn: reset in the past hidden" "no" "$(has '[↑→↓]' "$o")"
ok "burn: past reset rc" "rc=0" "$(cat "$tmp/rc")"
o=$(render burn "" "$(mkjson 80 "$(( now + 20000 ))")" | plain)
ok "burn: reset beyond window hidden" "no" "$(has '[↑→↓]' "$o")"
iso=$(date -u -d "@$(( now + 9000 ))" +%Y-%m-%dT%H:%M:%SZ)
o=$(render burn "" "$(mkjson 80 "\"$iso\"")" | plain)
ok "burn: ISO resets_at ahead" "yes" "$(has '80%.*↑' "$o")"
o=$(render burn "" "$(mkjson 50 "\"$iso\"")" | plain)
ok "burn: ISO resets_at level" "yes" "$(has '50%.*→' "$o")"
o=$(render burn "" "$(mkjson 80 '"not a date"')" | plain)
ok "burn: unparseable resets_at hidden" "no" "$(has '[↑→↓]' "$o")"
ok "burn: unparseable resets_at stderr" "" "$(cat "$tmp/stderr")"
o=$(render burn "" "$(mkjson 80.7 "$(( now + 9000 ))")" | plain)
ok "burn: fractional percentage ahead" "yes" "$(has '↑' "$o")"
for v in '"08"' '"007"'; do
  o=$(render burn "" "$(mkjson "$v" "$(( now + 9000 ))")" | plain)
  ok "burn: leading-zero percentage $v rc" "rc=0" "$(cat "$tmp/rc")"
  ok "burn: leading-zero percentage $v stderr" "" "$(cat "$tmp/stderr")"
  ok "burn: leading-zero percentage $v read as decimal" "yes" "$(has " ${v//\"/}%" "$o" >/dev/null; has " $((10#${v//\"/}))%" "$o")"
done

# 5. ordering, unknown names, extras scoped to one command
mkshim checkupdates 'exit 2'
mkshim systemctl 'case "$*" in *--user*) echo "u.service failed";; *) echo "a.service failed"; echo "b.service failed";; esac'
reset_cache
setcache updates "$(date +%s) 4"; setcache failed "$(date +%s) 3"
old_plain=$(render "" plain "$in_a" "$shims" | plain | norm)
for list in "updates,failed" "failed,updates" " updates , failed " "bogus,updates,jobs,failed"; do
  o=$(render "$list" plain "$in_a" "$shims" | plain | norm)
  ok "extras appended last, fixed order [$list]" "$old_plain  |  upd 4  failed 3" "$o"
done
ok "unknown names only: nothing added" "$old_plain" "$(render "bogus,jobs" plain "$in_a" "$shims" | plain | norm)"
o=$(render "bogus,failed" plain "$in_min" "$shims" | plain)
ok "unknown name does not hide a known one" "yes" "$(has 'failed 3$' "$o")"
ok "extras do not leak into the next render" "$old_plain" "$(render "" plain "$in_a" "$shims" | plain | norm)"

# 6. robust against empty, invalid and extreme input with every extra on
mkshim checkupdates 'exit 2'
for bad in '{}' 'not json' '' '[]' '{"rate_limits":"x"}' \
           '{"rate_limits":{"five_hour":{"used_percentage":50,"resets_at":"zzz"}}}' \
           '{"rate_limits":{"five_hour":{"used_percentage":"08","resets_at":99999999999999999999}}}' \
           '{"rate_limits":{"five_hour":{"used_percentage":"007","resets_at":"007"}}}' \
           '{"context_window":{"used_percentage":"099"}}'; do
  reset_cache; setcache updates "08 99999999999999999999"; setcache failed "$(( now + 5 )) 99999999999999999999"
  o=$(render updates,failed,burn "" "$bad" "$shims")
  ok "robust [$bad] rc" "rc=0" "$(cat "$tmp/rc")"
  ok "robust [$bad] stderr" "" "$(cat "$tmp/stderr")"
  ok "robust [$bad] single line" "1" "$(printf '%s\n' "$o" | wc -l | tr -d ' ')"
  settle
done

settle
if [ "$fails" -eq 0 ]; then echo "extras: all $checks checks passed"; exit 0; fi
echo "extras: $fails of $checks checks failed"; exit 1
