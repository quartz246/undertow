"""Fetch many Qloo paths through fleet4 (the key stays there). Usage: qfetch.py out.jsonl < name<TAB>path lines"""
import subprocess, sys, pathlib, json
def fetch(pairs, parallel=6):
    inp = "".join(f"{n}\t{p}\n" for n, p in pairs)
    cmd = ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "fleet4",
           f"QP={parallel} bash undertow-q/qfetch_remote.sh"]
    out = subprocess.run(cmd, input=inp, capture_output=True, text=True, timeout=3600).stdout
    res = {}
    for line in out.splitlines():
        n, _, body = line.partition("\t")
        try: res[n] = json.loads(body)
        except Exception: res[n] = {"_raw": body[:300]}
    return res
if __name__ == "__main__":
    pairs = [l.rstrip("\n").split("\t", 1) for l in sys.stdin if "\t" in l]
    with open(sys.argv[1], "w") as f:
        for n, d in fetch(pairs).items(): f.write(json.dumps({"name": n, "data": d}) + "\n")
