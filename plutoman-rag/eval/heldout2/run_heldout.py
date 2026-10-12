"""
Run the frozen held-out set through the real API and save every answer.
Usage: python run_heldout.py <out.json> [api=http://localhost:3000]
The server must run with CACHE_ENABLED=false.
"""
import hashlib, json, os, sys, time, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = sys.argv[1]
API = sys.argv[2] if len(sys.argv) > 2 else "http://localhost:3000"

raw = open(os.path.join(HERE, "heldout_set.json"), encoding="utf-8").read()
frozen = open(os.path.join(HERE, "FROZEN.txt")).read().split()[2]
assert hashlib.sha1(raw.encode("utf-8")).hexdigest() == frozen, "held-out set changed after freezing"
CASES = json.loads(raw)


def post(path, body, tok=None, retry=True):
    """One retry for infrastructure failures only (logged)."""
    h = {"Content-Type": "application/json"}
    if tok:
        h["Authorization"] = "Bearer " + tok
    req = urllib.request.Request(API + path, data=json.dumps(body).encode(), headers=h)
    try:
        with urllib.request.urlopen(req, timeout=900) as r:
            return json.load(r)
    except Exception as e:
        if not retry:
            raise
        print(f"   retrying {path} after error: {e}", flush=True)
        time.sleep(15)
        return post(path, body, tok, retry=False)


TOK = post("/dev/token", {"tenantId": "demo-tenant", "userId": "heldout-eval"})["token"]
results = []
for c in CASES:
    t0 = time.time()
    try:
        if c.get("prior"):
            d1 = post("/chat", {"message": c["prior"]}, TOK)
            d = post("/chat", {"conversationId": d1["conversationId"], "message": c["question"]}, TOK)
            extra = {"prior_answer": d1.get("answer"), "rewritten": d.get("rewrittenQuery")}
        else:
            d = post("/search", {"query": c["question"], "generate": True}, TOK)
            extra = {}
        results.append({"id": c["id"], "answer": d.get("answer"), "citations": d.get("citations"),
                        "applied": d.get("appliedFilters"), "aggregation": d.get("aggregation"),
                        "verification": d.get("verification"), "secs": round(time.time() - t0, 1), **extra})
    except Exception as e:
        results.append({"id": c["id"], "error": str(e), "secs": round(time.time() - t0, 1)})
    print(f"{c['id']} done in {results[-1]['secs']}s", flush=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(results, f, ensure_ascii=False, indent=1)
print("ALL DONE", flush=True)
