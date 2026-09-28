import json, statistics, sys, collections
rows = [json.loads(l) for l in open(sys.argv[1])]
g = collections.defaultdict(list)
for r in rows:
    g[(r['uri'], r['off'])].append(r)
def q(v, p):
    s = sorted(v); return s[min(len(s) - 1, int(p * len(s) + 0.9999) - 1)]
for uri in sorted({k[0] for k in g}):
    print('==', uri)
    for off in (True, False):
        rs = g[(uri, off)]
        w = [r['wall_ms'] for r in rs]; m = [r['mem'] for r in rs]; qs = [r['queries'] for r in rs]
        gq = collections.Counter(x for r in rs for x in r['gq_q'])
        print(f"  {'off' if off else 'on '} n={len(rs)} wall med={statistics.median(w):.2f} p95={q(w,.95):.2f} mem med={statistics.median(m)} queries med={statistics.median(qs)} min={min(qs)} max={max(qs)} http={max(r['http'] for r in rs)} enqueued={sum(r['enqueued'] for r in rs)} gq_queries/req={sum(len(r['gq_q']) for r in rs)/len(rs):.2f}")
        for sql, c in gq.most_common(8):
            print('     ', c, sql[:160])
