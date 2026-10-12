"""
Grade held-out runs with the criteria frozen in heldout_set.json.

content = every must_include group matched (OR within a group) and no
          must_not_include string present (case-insensitive, whitespace
          collapsed, all dashes "-").
strict  = content AND no cited report outside gold_sources + allowed_extra_sources
          (the golden set scores a wrong-document citation as a fail). Cases
          with no gold and no allowed extras skip the citation check.

Usage: python grade_heldout.py run1.json [run2.json ...] [--show]
"""
import json, os, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
CASES = {c["id"]: c for c in json.load(open(os.path.join(HERE, "heldout_set.json"), encoding="utf-8"))}


def norm(s):
    s = (s or "").lower()
    s = re.sub(r"[‐-―−]", "-", s)
    return re.sub(r"\s+", " ", s)


def grade(r):
    c = CASES[r["id"]]
    a = norm(r.get("answer"))
    content = all(any(norm(alt) in a for alt in g) for g in c["must_include"]) and not any(
        norm(n) in a for n in c["must_not_include"])
    allowed = {g["poid"] for g in c["gold_sources"]} | {
        p if p.startswith("POID-") else f"POID-{p}" for p in c.get("allowed_extra_sources", [])}
    cited = []
    for ct in r.get("citations") or []:
        d = ct.get("poid") or ct.get("sopId")
        if d and d not in cited:
            cited.append(d)
    wrong = [d for d in cited if allowed and d not in allowed]
    return content, content and not wrong, wrong, cited


def summary(path, show=False):
    run = {r["id"]: r for r in json.load(open(path, encoding="utf-8"))}
    beh = {}
    tot_c = tot_s = 0
    for cid in sorted(CASES):
        r = run.get(cid)
        b = CASES[cid]["behaviour"] + (" (multi-turn)" if CASES[cid].get("prior") else "")
        beh.setdefault(b, [0, 0, 0])
        beh[b][2] += 1
        if not r or "error" in r:
            continue
        c, s, wrong, cited = grade(r)
        tot_c += c
        tot_s += s
        beh[b][0] += c
        beh[b][1] += s
        if show:
            print(f"{cid} {b:26s} content:{'PASS' if c else 'fail'} strict:{'PASS' if s else 'fail'}"
                  f"{'  wrong-doc ' + ','.join(wrong) if wrong else ''}  {r.get('secs')}s")
    n = len(CASES)
    errors = sum(1 for cid in CASES if cid not in run or "error" in run[cid])
    secs = [run[c]["secs"] for c in run if "secs" in run[c]]
    print(f"{os.path.basename(path)}: content {tot_c}/{n}, strict {tot_s}/{n}, errors {errors}, "
          f"mean {sum(secs) / max(1, len(secs)):.1f}s")
    for b, (c, s, t) in sorted(beh.items()):
        print(f"   {b:26s} content {c}/{t}  strict {s}/{t}")
    return run


if __name__ == "__main__":
    show = "--show" in sys.argv
    for p in [a for a in sys.argv[1:] if not a.startswith("--")]:
        summary(p, show)
