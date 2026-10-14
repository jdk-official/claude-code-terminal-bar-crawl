#!/usr/bin/env bash
# Create the dummy project used for docs/screenshot.png: a small "Acme Shop" repo with a
# backlog-delivery board, ADRs, handovers and PBI files, on the branch of the in-progress PBI.
# Nothing here is real. Usage: docs/demo/make-demo-repo.sh [target-dir]   (default ./acme-shop)
set -euo pipefail
target=${1:-acme-shop}
[ -e "$target" ] && { echo "$target already exists" >&2; exit 1; }
mkdir -p "$target"; cd "$target"; git init -q -b main

python3 - <<'PY'
import os
def w(path, text):
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    open(path, "w").write(text)

# id: (title, status, depends_on, risk, branch)
P = {
  101: ("Project skeleton", "Done", [], "", ""),
  102: ("Product catalogue API", "Done", [], "", ""),
  103: ("Cart service", "Done", [], "", ""),
  104: ("Search filters", "In Progress", [101, 102], "", "pbi-104-search-filters"),
  105: ("Checkout form validation", "In Review", [103], "", ""),
  106: ("Payment provider integration", "Blocked", [103], "", ""),
  107: ("Saved searches", "Ready", [101, 102], "Low", ""),
  108: ("Order history page", "Ready", [102, 103], "Low", ""),
  109: ("Wishlist", "Ready", [103], "Medium", ""),
  113: ("Email receipts", "Ready", [103], "Low", ""),
  116: ("Product reviews", "Ready", [102], "Low", ""),
  110: ("Stock alerts", "Proposed", [107], "", ""),
  111: ("Gift cards", "Proposed", [106], "", ""),
  112: ("Dark mode", "Proposed", [], "", ""),
  114: ("Referral codes", "Proposed", [108], "", ""),
  115: ("Faceted navigation", "Proposed", [104], "", ""),
}
slug = lambda t: t.lower().replace(" ", "-")
ids = lambda l: ", ".join(f"PBI-{n}" for n in l)
head = lambda c: "| " + " | ".join(c) + " |\n|" + "|".join(["---"] * len(c)) + "|\n"
rows = lambda st, f: "".join(f(n) + "\n" for n in sorted(P) if P[n][1] == st)

b = "# BOARD: Acme Shop\n\n"
b += "## Proposed\n\n" + head(["ID", "Title", "Depends on", "Notes"]) + rows("Proposed", lambda n: f"| PBI-{n} | {P[n][0]} | {ids(P[n][2])} | |") + "\n"
b += "## Ready\n\n" + head(["ID", "Title", "Depends on", "Conflict group", "Conflict risk"]) + rows("Ready", lambda n: f"| PBI-{n} | {P[n][0]} | {ids(P[n][2])} | storefront | {P[n][3]} |") + "\n"
b += "## In Progress\n\n" + head(["ID", "Title", "Branch", "Worktree", "Session tag", "Started (UTC)"]) + rows("In Progress", lambda n: f"| PBI-{n} | {P[n][0]} | {P[n][4]} | . | demo | 2026-10-13T09:00Z |") + "\n"
b += "## In Review\n\n" + head(["ID", "Title", "PR", "Review verdict", "Review note path"]) + rows("In Review", lambda n: f"| PBI-{n} | {P[n][0]} | #42 | GO-WITH-CONDITIONS | |") + "\n"
b += "## Blocked\n\n" + head(["ID", "Title", "Blocked reason", "Unblock condition", "Return to"]) + rows("Blocked", lambda n: f"| PBI-{n} | {P[n][0]} | Waiting on provider contract | Contract signed | Ready |") + "\n"
b += "## Done\n\n" + head(["ID", "Title", "PR", "done-log"]) + rows("Done", lambda n: f"| PBI-{n} | {P[n][0]} | merged | |")
w("docs/backlog/BOARD.md", b)

# only PBIs that have been started have a file
for n in (101, 102, 103, 104, 105, 106):
    t, st = P[n][0], P[n][1]
    w(f"docs/backlog/pbi/PBI-{n}-{slug(t)}.md", f"---\nid: PBI-{n}\ntitle: {t}\nstatus: {st}\n---\n\n# {t}\n\nAcme Shop backlog item.\n")
for n in (101, 102, 103):
    w(f"docs/backlog/handovers/PBI-{n}.md", f"# Handover: PBI-{n}\n\nNotes for the next session.\n")
for k, t in enumerate(["Use PostgreSQL for the catalogue", "Server-render the storefront", "Idempotent payment webhooks"], 1):
    w(f"docs/adr/{k:04d}-{slug(t)}.md", f"# ADR {k:04d}: {t}\n\nStatus: accepted\n")
w("README.md", "# Acme Shop\n\nDemo project used for the README screenshot.\n")
PY

git add -A && git -c user.name=demo -c user.email=demo@example.com commit -q -m "Demo project"
git switch -q -c pbi-104-search-filters
echo "created $target on $(git branch --show-current)"
echo "start dev servers from inside it to fill the pane:  (cd $target && python3 -m http.server 5173 &)"
