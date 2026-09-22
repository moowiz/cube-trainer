"""Rigid-cube fit on the raw corners of an evidence log: can the 2-3 quads the
detector reports in one frame be one cube, and how far are the shared
corners apart before the fit snaps them?

usage: model/.venv/Scripts/python tools/solve/cubefit.py <replay.json>... [--f 550] [--inset 0.12] [--dump out.json]

Model: unit cube at the origin, faces U F R around the (+1,+1,+1) vertex
(any other visible triple is this one under a cube rotation, which the
pose absorbs). Correspondence is unknown - which quad is which face, each
quad's cyclic corner start and winding - so every assignment is tried with
a linear scaled-orthographic fit (24 equations, 8 unknowns for three
quads) and the best few are refined with a perspective Gauss-Newton (rotation,
translation; focal length fixed per camera - see --f). Residuals are RMS px over the quads' corners.
"""
import itertools
import json
import math
import sys
from collections import defaultdict

import numpy as np

# corners CCW seen from outside, starting at the UFR vertex where it is on the
# face. Labels (and so detections) sit at the outermost visible plastic of a
# face, never extrapolated past the rounded edge (model/README.md, M5
# conventions): each face quad is INSET from the sharp cube corner by the
# corner radius, so the U and F corners at a shared edge are distinct 3D
# points. INSET is that radius as a fraction of the half-edge (--inset).
V = lambda x, y, z: np.array([x, y, z], float)
def make_faces(inset):
    a = 1 - inset
    return {
        'U': [V(a, 1, a), V(-a, 1, a), V(-a, 1, -a), V(a, 1, -a)],      # y=+1
        'F': [V(a, a, 1), V(a, -a, 1), V(-a, -a, 1), V(-a, a, 1)],      # z=+1
        'R': [V(1, a, a), V(1, a, -a), V(1, -a, -a), V(1, -a, a)],      # x=+1
    }
FACES = make_faces(0.0)
FACE_NORMALS = {'U': V(0, 1, 0), 'F': V(0, 0, 1), 'R': V(1, 0, 0)}
ROLES = {2: [('U', 'F')], 3: [('U', 'F', 'R')]}

def variants(c):
    """8 corner orderings of a detected quad: 4 cyclic starts x 2 windings."""
    c = np.asarray(c, float)
    out = []
    for w in (c, c[::-1]):
        for k in range(4): out.append(np.roll(w, -k, axis=0))
    return out

def affine_fit(P3, p2):
    """Scaled-orthographic: p2 = A P3 + b, A 2x3. Returns RMS px and (A, b)."""
    n = len(P3)
    X = np.hstack([P3, np.ones((n, 1))])            # n x 4
    sol, *_ = np.linalg.lstsq(X, p2, rcond=None)    # 4 x 2
    r = X @ sol - p2
    return math.sqrt((r ** 2).sum() / n), sol

def rodrigues(w):
    th = np.linalg.norm(w)
    if th < 1e-12: return np.eye(3)
    k = w / th; K = np.array([[0, -k[2], k[1]], [k[2], 0, -k[0]], [-k[1], k[0], 0]])
    return np.eye(3) + math.sin(th) * K + (1 - math.cos(th)) * K @ K

def project(params, P3, cx, cy):
    R = rodrigues(params[:3]); t = params[3:6]; f = params[6]
    X = P3 @ R.T + t
    return np.stack([cx + f * X[:, 0] / X[:, 2], cy + f * X[:, 1] / X[:, 2]], 1)

def perspective_refine(P3, p2, A, b, cx, cy, f=550.0, iters=40):
    """Pose only (rotation, translation) at a fixed focal length, from the
    affine solution. f is per camera, not per frame - fitting it per frame
    is degenerate with depth and walks off to the affine limit."""
    r1, r2 = A[0], A[1]
    s = 0.5 * (np.linalg.norm(r1) + np.linalg.norm(r2))
    r1 = r1 / np.linalg.norm(r1); r2 = r2 - r1 * (r1 @ r2); r2 /= np.linalg.norm(r2)
    r3 = np.cross(r1, r2); R = np.stack([r1, r2, r3])
    ang = math.acos(max(-1, min(1, (np.trace(R) - 1) / 2)))
    w = np.zeros(3) if ang < 1e-9 else ang / (2 * math.sin(ang)) * np.array([R[2, 1] - R[1, 2], R[0, 2] - R[2, 0], R[1, 0] - R[0, 1]])
    z = f / s
    best = None
    # the affine rows fix R up to the sign of r3 (a mirror): try both
    for flip in (1, -1):
        Rf = R.copy(); Rf[2] *= flip
        if np.linalg.det(Rf) < 0: continue
        ang = math.acos(max(-1, min(1, (np.trace(Rf) - 1) / 2)))
        w = np.zeros(3) if ang < 1e-9 else ang / (2 * math.sin(ang)) * np.array([Rf[2, 1] - Rf[1, 2], Rf[0, 2] - Rf[2, 0], Rf[1, 0] - Rf[0, 1]])
        params = np.array([*w, (b[0] - cx) / s, (b[1] - cy) / s, z])
        def res(p): return (project(np.append(p, f), P3, cx, cy) - p2).ravel()
        lam = 1e-2; r = res(params); cost = r @ r
        for _ in range(iters):
            J = np.zeros((len(r), 6))
            for j in range(6):
                d = np.zeros(6); d[j] = 1e-5 * max(1, abs(params[j]))
                J[:, j] = (res(params + d) - r) / d[j]
            H = J.T @ J; g = J.T @ r
            try: step = np.linalg.solve(H + lam * np.diag(np.diag(H) + 1e-9), -g)
            except np.linalg.LinAlgError: break
            p_new = params + step
            if p_new[5] <= 1.0: lam *= 10; continue
            r_new = res(p_new); c_new = r_new @ r_new
            if c_new < cost: params, r, cost, lam = p_new, r_new, c_new, max(lam / 3, 1e-6)
            else: lam *= 10
            if lam > 1e8: break
        if best is None or cost < best[0]: best = (cost, params)
    cost, params = best
    return math.sqrt(cost / len(P3)), np.append(params, f)

def fit_frame(quads, cx, cy, f=550.0, topk=6):
    """quads: list of 4x2 corner arrays (2 or 3). Returns the best fit dict or None."""
    n = len(quads)
    if n not in ROLES: return None
    cands = []
    vs = [variants(q) for q in quads]
    faces = ROLES[n][0]
    P3 = np.vstack([FACES[faces[i]] for i in range(n)])
    for perm in itertools.permutations(range(n)):
        for choice in itertools.product(range(8), repeat=n):
            p2 = np.vstack([vs[perm[i]][choice[i]] for i in range(n)])
            rms, sol = affine_fit(P3, p2)
            cands.append((rms, perm, choice, p2, sol))
    cands.sort(key=lambda c: c[0])
    best = None
    normals = np.vstack([[FACE_NORMALS[faces[i]]] * 4 for i in range(n)])
    for rms, perm, choice, p2, sol in cands[:topk]:
        prms, params = perspective_refine(P3, p2, sol[:3].T, sol[3], cx, cy, f)
        # a detected face must face the camera: the mirror-image cube (Necker
        # ambiguity, exact under orthographic projection) fails this
        R = rodrigues(params[:3]); X = P3 @ R.T + params[3:6]
        if np.any(np.einsum('ij,ij->i', normals @ R.T, X) >= 0): prms += 1000
        if best is None or prms < best['persp_rms']:
            best = dict(affine_rms=rms, perm=perm, choice=choice, P3=P3, p2=p2, sol=sol, persp_rms=prms, params=params)
    groups = defaultdict(list)
    for i, v in enumerate(best['P3']): groups[tuple(v)].append(best['p2'][i])
    best['shared_dist'] = [np.linalg.norm(g[0] - g[1]) for g in groups.values() if len(g) >= 2]
    best['snapped'] = project(best['params'], best['P3'], cx, cy)
    best['mirror_only'] = best['persp_rms'] >= 1000
    return best

def run(path, cx=320, cy=240, f=550.0, inset=0.0):
    global FACES
    FACES = make_faces(inset)
    d = json.load(open(path, encoding='utf-8'))
    log = d['evidenceLog']
    by = defaultdict(list)
    for q in log['quads']: by[q['frame']].append(q)
    rows = []
    for fr, qs in sorted(by.items()):
        if len(qs) < 2: continue
        # duplicate tracks on one face (centroids closer than half an edge) are
        # one quad to the fit; keep the more confident
        qs = sorted(qs, key=lambda q: -q['conf']); kept = []
        for q in qs:
            c = np.mean(q['corners'], axis=0)
            if all(np.linalg.norm(c - np.mean(k['corners'], axis=0)) > 0.5 * k['edgePx'] for k in kept): kept.append(q)
        qs = kept[:3]
        if len(qs) < 2: continue
        fit = fit_frame([q['corners'] for q in qs], cx, cy, f)
        if not fit: continue
        move = np.linalg.norm(fit['snapped'] - fit['p2'], axis=1)
        rows.append(dict(frame=fr, t=qs[0]['t'], n=len(qs), tracks=[q['track'] for q in qs],
                         affine=fit['affine_rms'], persp=fit['persp_rms'], shared=fit['shared_dist'],
                         move_med=float(np.median(move)), move_max=float(move.max()),
                         f=float(fit['params'][6]), z=float(fit['params'][5]),
                         edge=float(np.mean([q['edgePx'] for q in qs]))))
    return rows

def pct(xs, p): xs = sorted(xs); return xs[min(len(xs) - 1, int(p * len(xs)))] if xs else float('nan')

if __name__ == '__main__':
    argv = sys.argv[1:]
    dump = argv[argv.index('--dump') + 1] if '--dump' in argv else None
    f = float(argv[argv.index('--f') + 1]) if '--f' in argv else 550.0
    inset = float(argv[argv.index('--inset') + 1]) if '--inset' in argv else 0.0
    skip = set()
    for flag in ('--dump', '--f', '--inset'):
        if flag in argv: skip |= {argv.index(flag), argv.index(flag) + 1}
    args = [a for i, a in enumerate(argv) if i not in skip]
    allrows = {}
    for p in args:
        rows = run(p, f=f, inset=inset); allrows[p] = rows
        two = [r for r in rows if r['n'] == 2]; three = [r for r in rows if r['n'] == 3]
        print(f"# {p}: {len(rows)} multi-quad frames ({len(two)} with 2, {len(three)} with 3)")
        for name, rs in (('2 quads', two), ('3 quads', three)):
            if not rs: continue
            pr = [r['persp'] for r in rs]; ar = [r['affine'] for r in rs]
            sh = [x for r in rs for x in r['shared']]
            mv = [r['move_med'] for r in rs]
            print(f"  {name}: perspective RMS p50 {pct(pr,.5):.1f} p75 {pct(pr,.75):.1f} p90 {pct(pr,.9):.1f} px "
                  f"(affine p50 {pct(ar,.5):.1f}); frames with RMS < 3 px: {100*sum(1 for x in pr if x<3)/len(pr):.0f}%, < 6 px: {100*sum(1 for x in pr if x<6)/len(pr):.0f}%")
            print(f"           shared-corner disagreement in raw detections: p50 {pct(sh,.5):.1f} p90 {pct(sh,.9):.1f} px; "
                  f"fit moves a corner by p50 {pct(mv,.5):.1f} px (median per frame); mean edge {np.mean([r['edge'] for r in rs]):.0f} px")
        bad = [r for r in rows if r['persp'] >= 6]
        if bad:
            print(f"  worst frames (RMS >= 6 px): {len(bad)}; e.g. " + '; '.join(f"frame {r['frame']} tracks {r['tracks']} RMS {r['persp']:.0f}" for r in sorted(bad, key=lambda r: -r['persp'])[:5]))
    if dump:
        json.dump({p: [{k: (v if not isinstance(v, np.floating) else float(v)) for k, v in r.items()} for r in rows] for p, rows in allrows.items()}, open(dump, 'w'), indent=0)
