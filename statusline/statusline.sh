#!/usr/bin/env bash
# Claude Code status line: model | effort | project | context | usage.
# Reads the session JSON Claude Code sends on stdin. Needs: bash, jq, git.
#
# Optional environment:
#   CLAUDE_STATUSLINE_PALETTE  a TOML file with `name = "#rrggbb"` lines (accent, foreground,
#                              dark_foreground, green, yellow, red, magenta). Defaults to the
#                              Omarchy theme's colors.toml when present, else built-in colours.
#   CLAUDE_STATUSLINE_ICONS    set to "plain" for ASCII instead of Nerd Font glyphs.
#   CLAUDE_STATUSLINE_EXTRAS   comma-separated optional segments, all off by default:
#                                updates  pending pacman updates (checkupdates, cached 30 min)
#                                failed   failed systemd units, system + user (systemctl)
#                                burn     arrow on the 5h meter: usage ahead of / level with elapsed time
#                              Unknown names are ignored. "jobs" is not offered: the status line
#                              input carries no background-job data to count.
command -v jq >/dev/null 2>&1 || { echo "statusline: jq not found"; exit 0; }
in=$(cat)
j() { jq -r "$1 // empty" <<<"$in" 2>/dev/null; }

pal=${CLAUDE_STATUSLINE_PALETTE:-~/.local/state/omarchy/current/theme/colors.toml}
[ -r "$pal" ] || pal=/dev/null
hex() { sed -n "s/^$1 *= *\"#\([0-9a-fA-F]\{6\}\)\".*/\1/p" "$pal" 2>/dev/null | head -1; }
fg() { local h=${1}; printf '\033[38;2;%d;%d;%dm' 0x${h:0:2} 0x${h:2:2} 0x${h:4:2}; }
R=$'\033[0m'
# name, fallback hex: the palette wins, the fallback keeps it readable anywhere
col() { local h; h=$(hex "$1"); fg "${h:-$2}"; }
c_accent=$(col accent 89b4fa);          c_text=$(col foreground cdd6f4)
c_mute=$(col dark_foreground 7f849c);   c_ok=$(col green a6e3a1)
c_warn=$(col yellow f9e2af);            c_bad=$(col red f38ba8); c_mag=$(col magenta cba6f7)
# icons: Nerd Font glyphs by default, ASCII with CLAUDE_STATUSLINE_ICONS=plain
if [ "$CLAUDE_STATUSLINE_ICONS" = plain ]; then
  i_model="" i_eff="" i_fast="fast" i_dir="" i_repo="" i_br="" i_sep="|" i_sub=">"
  i_upd="upd " i_fail="failed " i_up="^" i_lvl="="
else
  i_model="󰧑 " i_eff=" " i_fast="󱐋" i_dir="󰉋 " i_repo=" " i_br=" " i_sep="│" i_sub="›"
  i_upd=$'\U000f06b0 ' i_fail=$'\U000f0026 ' i_up="↑" i_lvl="→"
fi
SEP="  ${c_mute}${i_sep}${R}  "

# pct width -> "▰▰▱▱▱ 42%" coloured green/yellow/red at 60/85
bar() {
  local p=${1%.*} w=$2 col=$c_ok f i b=""
  [ -z "$p" ] && return
  [[ $p =~ ^[0-9]{1,6}$ ]] && p=$((10#$p))
  [ "$p" -gt 100 ] && p=100
  [ "$p" -ge 60 ] && col=$c_warn; [ "$p" -ge 85 ] && col=$c_bad
  f=$(( p * w / 100 ))
  for ((i=1; i<=w; i++)); do [ $i -le $f ] && b+="▰" || b+="▱"; done
  printf '%s%s %s%%%s' "$col" "$b" "$p" "$R"
}

# label pct resets_at -> "5h ▰▱▱▱▱ 31% ↻2h10m"
meter() {
  local lbl=$1 p=${2%.*} rs=$3 left="" ts now d h m
  [ -z "$p" ] && return
  if [ -n "$rs" ]; then
    if [[ $rs =~ ^[0-9]{1,12}$ ]]; then ts=$((10#$rs)); else ts=$(date -d "$rs" +%s 2>/dev/null); fi
    now=$(date +%s)
    if [ -n "$ts" ] && [ "$ts" -gt "$now" ]; then
      d=$(( ts - now )); h=$(( d / 3600 )); m=$(( (d % 3600) / 60 ))
      if [ $h -ge 24 ]; then left=" ${c_mute}↻$(( h / 24 ))d$(( h % 24 ))h${R}"
      else left=" ${c_mute}↻${h}h$(printf '%02d' $m)m${R}"; fi
    fi
  fi
  printf '%s %s%s' "$lbl" "$(bar "$p" 5)" "$left"
}

# Optional extras, each opt-in through CLAUDE_STATUSLINE_EXTRAS (see header).
extras=",${CLAUDE_STATUSLINE_EXTRAS// /},"
want() { [[ $extras == *",$1,"* ]]; }

# Cached count: prints the value from "$dir/<name>" ("epoch count"), and when it is older
# than <ttl> seconds runs <probe> detached to refresh it. The probe prints a count or fails
# (the old value is kept). A mkdir lock makes the claim atomic, so simultaneous renders start
# one refresh; a lock older than 10 minutes is treated as left by a killed refresh. A failed
# probe still stamps the file, so a broken command is retried once per <ttl>, not per render.
cached_count() {
  local name=$1 ttl=$2 probe=$3 dir=${XDG_CACHE_HOME:-$HOME/.cache}/claude-statusline
  local f=$dir/$1 lock=$dir/$1.lock ts=0 n=0 now lts got
  printf -v now '%(%s)T' -1
  [ -r "$f" ] && read -r ts n <"$f" 2>/dev/null
  [[ $ts =~ ^[0-9]{1,12}$ ]] && ts=$((10#$ts)) || ts=0
  [[ $n =~ ^[0-9]{1,6}$ ]] && n=$((10#$n)) || n=0
  [ "$ts" -gt "$now" ] && ts=0
  if [ $(( now - ts )) -ge "$ttl" ] && mkdir -p "$dir" 2>/dev/null; then
    got=0
    if mkdir "$lock" 2>/dev/null; then got=1
    else
      lts=""; [ -r "$lock/ts" ] && read -r lts <"$lock/ts" 2>/dev/null
      # no readable timestamp (killed before writing it): judge by the directory's own age
      if { [[ $lts =~ ^[0-9]{1,12}$ ]] && [ $(( now - 10#$lts )) -ge 600 ]; } ||
         { [[ ! $lts =~ ^[0-9]{1,12}$ ]] && [ -n "$(find "$lock" -maxdepth 0 -mmin +10 2>/dev/null)" ]; }; then
        rm -rf "$lock" 2>/dev/null; mkdir "$lock" 2>/dev/null && got=1
      fi
    fi
    if [ $got -eq 1 ]; then
      printf '%s\n' "$now" >"$lock/ts" 2>/dev/null
      (
        c=$($probe 2>/dev/null) || c=$n
        [[ $c =~ ^[0-9]{1,6}$ ]] || c=$n
        printf '%s %s\n' "$(date +%s)" "$c" >"$f.$$" 2>/dev/null && mv -f "$f.$$" "$f" 2>/dev/null
        rm -rf "$lock" 2>/dev/null
      ) >/dev/null 2>&1 &
      disown 2>/dev/null
    fi
  fi
  [ "$n" -gt 0 ] && printf '%s' "$n"
}

# checkupdates exits 0 with one line per update, 2 when there are none, 1 on error.
updates_probe() {
  local out rc
  out=$(checkupdates 2>/dev/null); rc=$?
  [ $rc -eq 2 ] && { echo 0; return; }
  [ $rc -eq 0 ] || return 1
  printf '%s\n' "$out" | grep -c .
}

# Failed systemd units across the system and user managers.
failed_probe() {
  local a b
  a=$(timeout 2 systemctl --failed --no-legend 2>/dev/null | grep -c .)
  b=$(timeout 2 systemctl --user --failed --no-legend 2>/dev/null | grep -c .)
  echo $(( ${a:-0} + ${b:-0} ))
}

updates_count() {
  command -v checkupdates >/dev/null 2>&1 || return
  cached_count updates 1800 updates_probe
}
failed_count() {
  command -v systemctl >/dev/null 2>&1 && command -v timeout >/dev/null 2>&1 || return
  cached_count failed 30 failed_probe
}

# 1. model
model=$(j '.model.display_name'); [ -z "$model" ] && model=$(j '.model.id')
s_model="${c_accent}${i_model}${model:-claude}${R}"

# 2. effort (+ fast mode)
effort=$(j '.effort.level'); s_effort=""
if [ -n "$effort" ]; then
  ec=$c_text
  case $effort in low) ec=$c_mute;; high) ec=$c_accent;; xhigh|max) ec=$c_mag;; esac
  s_effort="${ec}${i_eff}${effort}${R}"
fi
[ "$(j '.fast_mode')" = "true" ] && s_effort+="${s_effort:+ }${c_warn}${i_fast}${R}"

# 3. workspace (session launch dir) + repo (git toplevel) + branch
dir=$(j '.workspace.current_dir'); [ -z "$dir" ] && dir=$(j '.cwd')
wsdir=$(j '.workspace.project_dir'); [ -z "$wsdir" ] && wsdir=$dir
ws=${wsdir%/}; ws=${ws##*/}; [ -z "$ws" ] && ws="/"
root=""; [ -n "$dir" ] && root=$(git -C "$dir" --no-optional-locks rev-parse --show-toplevel 2>/dev/null)
name=${root##*/}; [ -z "$name" ] && name="-"
# workspace and repo shown separately; collapsed to one label when they are the same
if [ "$ws" = "$name" ]; then
  s_proj="${c_text}${i_repo}${name}${R}"
else
  s_proj="${c_mute}${i_dir}${R}${c_text}${ws}${R} ${c_mute}${i_sub}${R} ${c_text}${i_repo}${name}${R}"
fi
if [ -n "$dir" ] && br=$(git -C "$dir" symbolic-ref --short -q HEAD 2>/dev/null || git -C "$dir" rev-parse --short HEAD 2>/dev/null); then
  dirty=""; [ -n "$(git -C "$dir" status --porcelain 2>/dev/null | head -1)" ] && dirty="${c_warn}*${R}"
  s_proj+=" ${c_mag}${i_br}${br}${R}${dirty}"
fi

# 4. context window
s_ctx=""; pct=$(j '.context_window.used_percentage')
[ -n "$pct" ] && s_ctx="${c_mute}ctx${R} $(bar "$pct" 10)"

# 5. usage windows
m5=$(meter "5h" "$(j '.rate_limits.five_hour.used_percentage')" "$(j '.rate_limits.five_hour.resets_at')")
m7=$(meter "7d" "$(j '.rate_limits.seven_day.used_percentage')" "$(j '.rate_limits.seven_day.resets_at')")
# burn: 5h usage against the share of the 5h window already elapsed (10 points of slack)
if want burn && [ -n "$m5" ]; then
  bp=$(j '.rate_limits.five_hour.used_percentage'); bp=${bp%.*}
  [[ $bp =~ ^[0-9]{1,3}$ ]] && bp=$((10#$bp))
  brs=$(j '.rate_limits.five_hour.resets_at')
  if [[ $brs =~ ^[0-9]{1,12}$ ]]; then bts=$((10#$brs)); else bts=$(date -d "$brs" +%s 2>/dev/null); fi
  printf -v bnow '%(%s)T' -1
  if [[ $bp =~ ^[0-9]{1,3}$ && $bts =~ ^[0-9]{1,12}$ ]] && [ "$bts" -gt "$bnow" ] && [ $(( bts - bnow )) -le 18000 ]; then
    be=$(( (18000 - (bts - bnow)) * 100 / 18000 ))
    if [ $(( bp - be )) -gt 10 ]; then m5+=" ${c_warn}${i_up}${R}"
    elif [ $(( be - bp )) -le 10 ]; then m5+=" ${c_mute}${i_lvl}${R}"; fi
  fi
fi
s_use="$m5${m5:+${m7:+  }}$m7"

s_x=""
if want updates; then n=$(updates_count); [ -n "$n" ] && s_x+="${c_accent}${i_upd}${n}${R}"; fi
if want failed; then n=$(failed_count); [ -n "$n" ] && s_x+="${s_x:+  }${c_bad}${i_fail}${n}${R}"; fi

out=""
for seg in "$s_model" "$s_effort" "$s_proj" "$s_ctx" "$s_use" "$s_x"; do
  [ -n "$seg" ] && out+="${out:+$SEP}$seg"
done
printf '%s\n' "$out"
