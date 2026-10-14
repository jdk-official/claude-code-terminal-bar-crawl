#!/usr/bin/env bash
# Proves each run: step in check.yml passes on the real tree and fails on a
# deliberately broken throwaway repo. Steps are read from the workflow at run
# time, so this cannot drift from it. Override the workflow with CHECK_YML=path.
set -u

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
yml=${CHECK_YML:-$root/.github/workflows/check.yml}
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

python3 -I - "$yml" "$work" <<'PY' || { echo "FAIL cannot extract steps from workflow"; exit 1; }
import re, sys

# Standard library only: the workflow uses "run: |" block scalars and
# single-line "run: value" forms, so a small line scanner is enough.
lines = open(sys.argv[1]).read().split("\n")
runs = []
i = 0
while i < len(lines):
    m = re.match(r"^(\s*)(?:- )?run:\s*(.*)$", lines[i])
    i += 1
    if not m:
        continue
    key_indent, value = len(m.group(1)), m.group(2)
    if value in ("|", "|-", ">", ">-"):
        body = []
        while i < len(lines):
            ln = lines[i]
            if ln.strip() and len(ln) - len(ln.lstrip()) <= key_indent:
                break
            body.append(ln)
            i += 1
        ind = min((len(l) - len(l.lstrip()) for l in body if l.strip()), default=0)
        runs.append("\n".join(l[ind:] for l in body).rstrip("\n") + "\n")
    else:
        runs.append(value.strip("\"'") + "\n")

# Exclude the step that invokes this script so it cannot recurse into itself.
guards = [r for r in runs if "steps-can-fail.sh" not in r]
# Each guard step is identified by what it does, not by its position.
markers = {1: "shellcheck", 2: "json.load", 3: "backlog-delivery/", 4: "git grep"}
if len(guards) < 4:
    sys.exit(f"expected at least 4 guard steps, found {len(guards)}")
for n, marker in markers.items():
    hit = [r for r in guards if marker in r]
    if len(hit) != 1:
        sys.exit(f"expected exactly 1 step containing {marker!r}, found {len(hit)}")
    open(f"{sys.argv[2]}/step{n}.sh", "w").write(hit[0])
print(f"extracted {len(markers)} guard steps from {len(runs)} run steps")
PY

# Throwaway repos must not inherit the user's git configuration or excludes.
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
# Keep git from discovering a repository above the scratch directory.
export GIT_CEILING_DIRECTORIES="$work"

# Without shellcheck locally, shim it as a no-op so only bash -n is exercised.
shim="$work/shim"; mkdir "$shim"
have_shellcheck=1
if ! command -v shellcheck >/dev/null 2>&1; then
  have_shellcheck=0
  printf '#!/bin/sh\nexit 0\n' > "$shim/shellcheck"; chmod +x "$shim/shellcheck"
  echo "NOTE shellcheck not installed: step 1 exercises bash -n only"
fi

fails=0
# expect_in <pass|fail> <label> <step-number> <dir>
expect_in() {
  local want=$1 label=$2 n=$3 dir=$4 rc
  (cd "$dir" && PATH="$shim:$PATH" bash "$work/step$n.sh" >"$work/out" 2>&1); rc=$?
  if { [ "$want" = pass ] && [ $rc -eq 0 ]; } || { [ "$want" = fail ] && [ $rc -ne 0 ]; }; then
    echo "PASS step$n $label (expected $want, rc=$rc)"
  else
    echo "FAIL step$n $label (expected $want, rc=$rc)"; sed 's/^/    /' "$work/out"
    fails=$((fails + 1))
  fi
}

new_repo() { # clean, valid repo in a fresh dir; prints its path
  local d; d=$(mktemp -d "$work/repo.XXXXXX")
  (
    cd "$d" && git init -q
    mkdir -p statusline docs/demo .claude-plugin plugins/p/.claude-plugin plugins/p/hooks
    printf '#!/usr/bin/env bash\necho ok\n' > statusline/statusline.sh
    printf '#!/usr/bin/env bash\necho ok\n' > docs/demo/make-demo-repo.sh
    echo '{}' > .claude-plugin/marketplace.json
    echo '{}' > plugins/p/.claude-plugin/plugin.json
    echo '{}' > plugins/p/hooks/hooks.json
    echo 'hello' > README.md
    git add -A
  )
  echo "$d"
}

for n in 1 2 3 4; do expect_in pass "real tree" "$n" "$root"; done

# Each case: positive control on a clean repo, then the mutation must fail.
d=$(new_repo); expect_in pass "clean repo" 1 "$d"
echo 'if then fi (' > "$d/statusline/statusline.sh"
expect_in fail "syntax error in statusline.sh" 1 "$d"
d=$(new_repo); echo 'if then fi (' > "$d/docs/demo/make-demo-repo.sh"
expect_in fail "syntax error in make-demo-repo.sh" 1 "$d"
if [ $have_shellcheck -eq 1 ]; then
  d=$(new_repo); printf '#!/usr/bin/env bash\ncd /tmp\nrm -rf *\n' > "$d/statusline/statusline.sh"
  expect_in fail "shellcheck warning (SC2164)" 1 "$d"
fi

d=$(mktemp -d "$work/norepo.XXXXXX")
expect_in fail "not a git repository" 1 "$d"
d=$(mktemp -d "$work/shfree.XXXXXX")
(cd "$d" && git init -q && echo hello > README.md && git add -A)
expect_in fail "no tracked .sh files" 1 "$d"

d=$(new_repo); expect_in pass "clean repo" 2 "$d"
echo '{bad' > "$d/.claude-plugin/marketplace.json"
expect_in fail "invalid marketplace.json" 2 "$d"
d=$(new_repo); echo '{bad' > "$d/plugins/p/.claude-plugin/plugin.json"
expect_in fail "invalid plugin.json" 2 "$d"
d=$(new_repo); echo '{bad' > "$d/plugins/p/hooks/hooks.json"
expect_in fail "invalid hooks.json" 2 "$d"

d=$(new_repo); expect_in pass "clean repo" 3 "$d"
mkdir "$d/tools"; echo x > "$d/tools/x"; (cd "$d" && git add -A)
expect_in fail "tracked tools/x" 3 "$d"
d=$(new_repo); mkdir -p "$d/plugins/backlog-delivery"; echo x > "$d/plugins/backlog-delivery/y"
(cd "$d" && git add -A)
expect_in fail "tracked plugins/backlog-delivery/y" 3 "$d"

d=$(mktemp -d "$work/norepo.XXXXXX")
expect_in fail "not a git repository" 3 "$d"
d=$(new_repo); mkdir "$d/Tools"; echo x > "$d/Tools/x"; (cd "$d" && git add -A)
expect_in fail "differently-cased Tools/x" 3 "$d"

d=$(mktemp -d "$work/norepo.XXXXXX")
expect_in fail "not a git repository" 4 "$d"
d=$(new_repo); expect_in pass "clean repo" 4 "$d"
d=$(new_repo); printf 'GIF\0\0 /mnt/data \0\377' > "$d/img.bin"; (cd "$d" && git add -A)
expect_in fail "private string inside a binary file" 4 "$d"
d=$(new_repo); mkdir -p "$d/.github"; echo '/mnt/data' > "$d/.github/ok.txt"; (cd "$d" && git add -A)
expect_in pass "token under .github is exempt" 4 "$d"
for tok in /home/jdk /mnt/data agent-catalog angrayOne kyte.me; do
  d=$(new_repo); echo "path $tok here" > "$d/notes.md"; (cd "$d" && git add -A)
  expect_in fail "tracked file containing $tok" 4 "$d"
done

if [ $fails -ne 0 ]; then echo "RESULT: $fails expectation(s) wrong"; exit 1; fi
echo "RESULT: all expectations held"
