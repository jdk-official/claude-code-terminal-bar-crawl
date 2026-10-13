#!/usr/bin/env bash
# Claude Code status line: model | effort | project | context | usage.
# Reads the session JSON Claude Code sends on stdin. Needs: bash, jq, git.
#
# Optional environment:
#   CLAUDE_STATUSLINE_PALETTE  a TOML file with `name = "#rrggbb"` lines (accent, foreground,
#                              dark_foreground, green, yellow, red, magenta). Defaults to the
#                              Omarchy theme's colors.toml when present, else built-in colours.
#   CLAUDE_STATUSLINE_ICONS    set to "plain" for ASCII instead of Nerd Font glyphs.
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
else
  i_model="󰧑 " i_eff=" " i_fast="󱐋" i_dir="󰉋 " i_repo=" " i_br=" " i_sep="│" i_sub="›"
fi
SEP="  ${c_mute}${i_sep}${R}  "

# pct width -> "▰▰▱▱▱ 42%" coloured green/yellow/red at 60/85
bar() {
  local p=${1%.*} w=$2 col=$c_ok f i b=""
  [ -z "$p" ] && return
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
    if [[ $rs =~ ^[0-9]+$ ]]; then ts=$rs; else ts=$(date -d "$rs" +%s 2>/dev/null); fi
    now=$(date +%s)
    if [ -n "$ts" ] && [ "$ts" -gt "$now" ]; then
      d=$(( ts - now )); h=$(( d / 3600 )); m=$(( (d % 3600) / 60 ))
      if [ $h -ge 24 ]; then left=" ${c_mute}↻$(( h / 24 ))d$(( h % 24 ))h${R}"
      else left=" ${c_mute}↻${h}h$(printf '%02d' $m)m${R}"; fi
    fi
  fi
  printf '%s %s%s' "$lbl" "$(bar "$p" 5)" "$left"
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
s_use="$m5${m5:+${m7:+  }}$m7"

out=""
for seg in "$s_model" "$s_effort" "$s_proj" "$s_ctx" "$s_use"; do
  [ -n "$seg" ] && out+="${out:+$SEP}$seg"
done
printf '%s\n' "$out"
