"""usage: python tools/solve/survey_log.py <capture.json>...
Survey an evidence log from a solve recording: what did the detector/tracker
see over time, how many faces at once, did tracks survive turns (in-track
colour jumps) or die and come back (birth/death bursts)?"""
import json, sys, math
from collections import defaultdict

def lab_d(a, b): return math.sqrt(sum((x - y) ** 2 for x, y in zip(a, b)))
def median(xs):
    xs = sorted(xs); n = len(xs)
    return xs[n // 2] if n % 2 else 0.5 * (xs[n // 2 - 1] + xs[n // 2])
def med_lab(labs): return [median([l[i] for l in labs]) for i in range(3)]

def analyze(path, t0=None, bin_s=2.0, jump_thr=18.0, win=3):
    d = json.load(open(path, encoding='utf-8'))
    log = d['evidenceLog']; rec = d.get('recording')
    if t0 is None: t0 = rec['startedAt'] if rec else min(q['t'] for q in log['quads'])
    rel = lambda t: (t - t0) / 1000
    quads = log['quads']; events = log['events']
    print(f"# {path}\n  quads {len(quads)} frames {log['frames']} events {len(events)} "
          f"span {rel(quads[0]['t']):.1f}..{rel(quads[-1]['t']):.1f}s locked={d.get('locked')} reason={(d.get('solution') or {}).get('reason')}")

    # ---- per-frame: quads visible
    by_frame = defaultdict(list)
    for q in quads: by_frame[q['frame']].append(q)
    frames = sorted(by_frame)
    first_f, last_f = frames[0], frames[-1]
    # frame -> t (from any quad); frames with no quads have no t, interpolate by neighbours
    ft = {f: by_frame[f][0]['t'] for f in frames}

    # ---- timeline bins
    bins = defaultdict(lambda: dict(ticks=set(), q=0, n1=0, n2=0, n3=0, born=0, died=0, edge=[], w=[], conf=[], tracks=set()))
    for f in frames:
        b = int(rel(ft[f]) // bin_s)
        B = bins[b]; B['ticks'].add(f); n = len(by_frame[f]); B['q'] += n
        B[f'n{min(n,3)}'] += 1
        for q in by_frame[f]:
            B['edge'].append(q['edgePx']); B['conf'].append(q['conf']); B['tracks'].add(q['track'])
            B['w'].append(sum(r['w'] for r in q['readings']) / 9)
    for e in events:
        b = int(rel(e['t']) // bin_s)
        bins[b]['born' if e['kind'] == 'born' else 'died'] += 1
    print(f"\n  timeline ({bin_s:.0f}s bins): t | ticks-with-quads | frames seeing 1/2/3 faces | tracks | born/died | edgePx | mean w | conf")
    for b in sorted(bins):
        B = bins[b]
        if not B['ticks'] and not B['born'] and not B['died']: continue
        e = sum(B['edge']) / len(B['edge']) if B['edge'] else 0
        w = sum(B['w']) / len(B['w']) if B['w'] else 0
        c = sum(B['conf']) / len(B['conf']) if B['conf'] else 0
        print(f"  {b*bin_s:5.0f}s | {len(B['ticks']):3d} | {B['n1']:3d}/{B['n2']:3d}/{B['n3']:3d} | {len(B['tracks']):2d} | {B['born']:2d}/{B['died']:2d} | {e:5.0f} | {w:.2f} | {c:.2f}")

    # ---- tracks
    by_track = defaultdict(list)
    for q in quads: by_track[q['track']].append(q)
    lens = sorted(len(v) for v in by_track.values())
    durs = sorted(rel(v[-1]['t']) - rel(v[0]['t']) for v in by_track.values())
    print(f"\n  tracks {len(by_track)}: frames/track median {median(lens):.0f} (min {lens[0]} max {lens[-1]}), "
          f"duration median {median(durs):.2f}s max {durs[-1]:.1f}s; "
          f"{sum(1 for l in lens if l < 3)} tracks < 3 frames, {sum(1 for x in durs if x > 3)} tracks > 3 s")

    # ---- in-track colour jumps: did a quad survive a turn?
    print(f"\n  in-track jumps (>= 3 cells whose before/after medians differ by > {jump_thr} Lab, windows of {win}):")
    jumps = []
    for tid, obs in by_track.items():
        obs.sort(key=lambda q: q['frame'])
        if len(obs) < 2 * win: continue
        series = [[None] * 9 for _ in obs]
        for i, q in enumerate(obs):
            for r in q['readings']:
                if r['w'] > 0.05: series[i][r['cell']] = [r['lab']['L'], r['lab']['a'], r['lab']['b']]
        last_hit = -99
        for i in range(win, len(obs) - win + 1):
            cells = 0; dists = []
            for c in range(9):
                a = [s[c] for s in series[i - win:i] if s[c]]; b = [s[c] for s in series[i:i + win] if s[c]]
                if len(a) >= 2 and len(b) >= 2:
                    dd = lab_d(med_lab(a), med_lab(b)); dists.append((c, dd))
                    if dd > jump_thr: cells += 1
            if cells >= 3 and i - last_hit > win:
                last_hit = i
                jumps.append((rel(obs[i]['t']), tid, cells, obs[i]['nth'], len(obs), [c for c, dd in dists if dd > jump_thr]))
    for t, tid, cells, nth, n, which in sorted(jumps):
        print(f"    t={t:6.2f}s track #{tid} ({nth}/{n} frames) {cells} cells jumped: {which}")
    print(f"  {len(jumps)} in-track jumps")

    # ---- death/birth bursts: transitions where the tracker dropped faces
    ev = sorted(events, key=lambda e: e['t'])
    print(f"\n  birth/death bursts (>= 2 events within 0.4 s):")
    i = 0; bursts = 0
    while i < len(ev):
        j = i
        while j + 1 < len(ev) and ev[j + 1]['t'] - ev[i]['t'] < 400: j += 1
        if j > i:
            bursts += 1
            kinds = ''.join('b' if e['kind'] == 'born' else 'd' for e in ev[i:j + 1])
            print(f"    t={rel(ev[i]['t']):6.2f}s {kinds}  tracks {[e['track'] for e in ev[i:j+1]]}")
        i = j + 1
    print(f"  {bursts} bursts")
    return d

if __name__ == '__main__':
    for p in sys.argv[1:]: analyze(p)
