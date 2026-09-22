"""Contact sheet of video frames with the replay log's tracked quads drawn on
them: what the tracker did, frame by frame, against what the hands did.
usage: model/.venv/Scripts/python tools/solve/overlay_log.py <replay.json> <clip.webm> <t_start> <t_end> <fps> <out.png> [t0_offset_s]
(needs PIL, so run it with the model venv). Alignment uses the capture's
`recording.startedAt`; logs captured before that stamp existed fall back to
first-quad time minus 0.1 s, which is where t0_offset_s helps."""
import json
import math
import os
import subprocess
import sys

import imageio_ffmpeg
from PIL import Image, ImageDraw, ImageFont

FF = imageio_ffmpeg.get_ffmpeg_exe()
rep, clip, ts, te, fps, out = sys.argv[1:7]
ts, te, fps = float(ts), float(te), float(fps)
off = float(sys.argv[7]) if len(sys.argv) > 7 else 0.0

d = json.load(open(rep, encoding='utf-8'))
log = d['evidenceLog']
rec = d.get('recording')
t0 = (rec['startedAt'] if rec else min(q['t'] for q in log['quads']) - 100) + off * 1000
quads = sorted(log['quads'], key=lambda q: q['t'])
events = log['events']
COL = ['#ff4040', '#40ff40', '#4080ff', '#ffff40', '#ff40ff', '#40ffff', '#ff8000', '#ffffff']

tmp = os.path.join(os.path.dirname(out), 'ov-frames'); os.makedirs(tmp, exist_ok=True)
for f in os.listdir(tmp): os.remove(os.path.join(tmp, f))
subprocess.run([FF, '-hide_banner', '-loglevel', 'error', '-ss', str(ts), '-t', str(te - ts), '-i', clip,
                '-vf', f'fps={fps}', os.path.join(tmp, 'f%04d.png')], check=True)
frames = sorted(os.listdir(tmp))
n = len(frames); cols = 6; rows = math.ceil(n / cols)
W, H = 320, 240
sheet = Image.new('RGB', (cols * W, rows * H), 'black')
font = ImageFont.truetype('arial.ttf', 13)
for i, fn in enumerate(frames):
    t = ts + i / fps  # video time of this frame
    img = Image.open(os.path.join(tmp, fn)).convert('RGB')
    sw = img.width / 640
    img = img.resize((W, H))
    dr = ImageDraw.Draw(img)
    # quads logged within half a frame interval of this video time
    lo, hi = t0 + (t - 0.5 / fps) * 1000, t0 + (t + 0.5 / fps) * 1000
    near = [q for q in quads if lo <= q['t'] < hi]
    for q in near:
        c = COL[q['track'] % len(COL)]
        pts = [(x * W / 640, y * H / 480) for x, y in q['corners']]
        dr.polygon(pts, outline=c, width=2)
        dr.text((pts[0][0] + 2, pts[0][1] + 2), f"#{q['track']} {sum(1 for r in q['readings'] if r['w'] > 0.05)}", fill=c, font=font)
    ev = [e for e in events if lo <= e['t'] < hi]
    txt = f"{t:6.2f}s" + ''.join(f"  {e['kind'][0]}#{e['track']}" for e in ev)
    dr.rectangle((0, 0, 8 + 7 * len(txt), 16), fill='black')
    dr.text((3, 1), txt, fill='yellow', font=font)
    sheet.paste(img, ((i % cols) * W, (i // cols) * H))
sheet.save(out)
print(out, n, 'frames')
