# Runs on fleet4: reads "name<TAB>path" lines on stdin, prints "name<TAB>json" lines. Key never leaves the host.
# Each response goes to its own file first so parallel jobs cannot interleave on stdout.
set -u
K=${QLOO_API_KEY:-}; [ -n "$K" ] || K=$(podman inspect "${QLOO_KEY_CONTAINER:-adflank-wiz}" --format '{{range .Config.Env}}{{println .}}{{end}}' | awk '/^QLOO_API_KEY=/{print substr($0,index($0,"=")+1)}')
H=$(mktemp); chmod 600 "$H"; printf 'X-Api-Key: %s\n' "$K" > "$H"
D=$(mktemp -d); trap 'rm -rf "$H" "$D"' EXIT
export H D
one() {
  local i=${1%%$'\t'*} rest=${1#*$'\t'}
  local n=${rest%%$'\t'*} p=${rest#*$'\t'}
  local r; r=$(curl -s -m 90 --retry 2 -H @"$H" "https://hackathon.api.qloo.com$p" | tr -d '\n\t')
  printf '%s\t%s\n' "$n" "$r" > "$D/$i"
}
export -f one
tr -d '\r' | awk '{print NR "\t" $0}' | xargs -d '\n' -P "${QP:-6}" -I{} bash -c 'one "$1"' _ {}
cat "$D"/* 2>/dev/null
