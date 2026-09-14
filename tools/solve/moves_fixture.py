"""Turn a recorded solve into a move-reader fixture (web/test/fixtures/solves/).

A fixture is the evidence log from the moment the recording started, the
lock that preceded it (start state, palette, colour->letter map: the
reader's commitments) and, when known, the moves that were turned and the
state the solve ended in. The log may come from the live capture or from
a replay of the clip through a newer detector (replay_clips.py); the lock
always comes from the live capture, which is the one that saw the scan.

    python tools/solve/moves_fixture.py LIVE.json [--log REPLAY.json]
        [--truth "R U R' ..."] [--end solved|<54 facelets>|none]
        [--from-t MS] [--note "..."] --out NAME

`--truth cubejs` writes the cubejs solution of the locked state (what the
app displayed) as the truth: right when the user followed it exactly.
"""
import argparse
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.normpath(os.path.join(HERE, '..', '..', 'web'))
SOLVED = 'UUUUUUUUURRRRRRRRRFFFFFFFFFDDDDDDDDDLLLLLLLLLBBBBBBBBB'


def cubejs_solution(facelets):
    js = ("const C=require('cubejs');C.initSolver();"
          f"process.stdout.write(C.fromString('{facelets}').solve())")
    return subprocess.check_output(['node', '-e', js], cwd=WEB, text=True).strip()


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('live')
    ap.add_argument('--log', help='capture whose evidence log to use instead of the live one (a replay)')
    ap.add_argument('--truth', help='moves turned, or "cubejs" for the solution the app showed')
    ap.add_argument('--end', default='solved', help='solved (default), 54 facelets, or none')
    ap.add_argument('--from-t', type=float, help='wall-clock ms the solve starts at (default: recording.startedAt)')
    ap.add_argument('--note', default='')
    ap.add_argument('--hard', help='why the reader is not expected to get this one yet: the test prints instead of asserting')
    ap.add_argument('--out', required=True, help='fixture name (no extension)')
    a = ap.parse_args()

    live = json.load(open(a.live, encoding='utf-8'))
    sol = live.get('solution') or {}
    if not live.get('locked') or not sol.get('facelets'):
        sys.exit('the live capture has no lock')
    logsrc = json.load(open(a.log, encoding='utf-8')) if a.log else live
    rec = live.get('recording') or logsrc.get('recording') or {}
    from_t = a.from_t if a.from_t is not None else rec.get('startedAt')
    if from_t is None:
        sys.exit('no recording.startedAt; pass --from-t')
    log = logsrc['evidenceLog']
    quads = [q for q in log['quads'] if q['t'] >= from_t]
    frames = {q['frame'] for q in quads}
    start = sol['facelets']
    truth = a.truth
    if truth == 'cubejs':
        truth = cubejs_solution(start)
    end = None if a.end == 'none' else SOLVED if a.end == 'solved' else a.end
    out = {
        'version': live.get('version', 2),
        'source': {'live': os.path.basename(a.live), 'log': os.path.basename(a.log) if a.log else None,
                   'model': logsrc.get('model'), 'recording': rec.get('file')},
        'note': a.note,
        'hard': a.hard,
        'start': start,
        'end': end,
        'truth': truth,
        'truthNote': 'cubejs solution the app displayed; assumed followed exactly' if a.truth == 'cubejs' else None,
        'fromT': from_t,
        'commitments': {
            'start': start,
            'embedding': sol['embedding'],
            'palette': {'centres': sol['palette']['centres'], 'sigma': sol['palette']['sigma']},
            'colourLetter': sol['colourLetter'],
        },
        'evidenceLog': {
            'quads': quads,
            'pairings': [p for p in log['pairings'] if p['frame'] in frames],
            'events': [e for e in log['events'] if e['t'] >= from_t],
            'frames': log['frames'],
        },
    }
    dest = os.path.join(WEB, 'test', 'fixtures', 'solves', a.out + '.json')
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    with open(dest, 'w', encoding='utf-8') as f:
        json.dump(out, f, separators=(',', ':'))
    span = (quads[-1]['t'] - quads[0]['t']) / 1000 if quads else 0
    print(f'{dest}: {len(quads)} quads over {span:.1f} s from {len(frames)} frames; start {start}; truth {truth}')


if __name__ == '__main__':
    main()
