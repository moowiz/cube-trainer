"""Face keypoint models (M4). Two heads live here; `build_model` picks one.

FaceKPCenter ("center", the default since 2026-09-12) is the current model:
MobileNetV3-Small -> stride-16 neck -> a CenterNet-style map of
(face-center heatmap, 4 corner offsets). Faces are peaks, quads are
ANONYMOUS, and the web app names each one by its center sticker color. See
the long comment above the class and model/PLAN-anonymous-conv-head.md.

FaceKP ("legacy") is the original: MobileNetV3-Small -> 1x1 conv squeeze ->
flatten -> small MLP -> per-face [conf_logit, 4 corners as normalized (u,v)],
output (B, 6, 9) with faces in URFDLB order. It is kept so every checkpoint
up to ft7 still loads, exports and diagnoses; nothing new should train on it.

DECISION (superseded 2026-09-12): the legacy head chose direct regression
over heatmaps because the cube is a single rigid object filling much of the
frame, making global regression well-posed and browser-side decoding
unnecessary. What that argument missed is that a flatten+FC head is
position-specific, is 5.27M of 6.27M params, is the layer that makes int8
quantization fail, and - because its six output slots are NAMED - forces the
loss to pick a face identity on views where identity is genuinely ambiguous,
which it resolves by averaging rotations into a diamond. The heatmap head
fixes all four at once and costs one small decode in TypeScript.
"""
from __future__ import annotations

import torch
from torch import nn
from torchvision.models import MobileNet_V3_Small_Weights, mobilenet_v3_small

from shapes import KP_WH, min_face_edge_px

N_FACES = 6
OUT_PER_FACE = 9  # conf + 4*(x,y)


class FaceKP(nn.Module):
    def __init__(self, pretrained: bool = True, input_hw=(KP_WH[1], KP_WH[0])):
        super().__init__()
        weights = MobileNet_V3_Small_Weights.DEFAULT if pretrained else None
        self.backbone = mobilenet_v3_small(weights=weights).features  # (B,576,H/32,W/32)
        fh, fw = input_hw[0] // 32, input_hw[1] // 32  # (floor of last stride)
        # torchvision's stride chain gives ceil-ish dims; probe once to be exact
        with torch.no_grad():
            probe = self.backbone(torch.zeros(1, 3, *input_hw))
        _, ch, fh, fw = probe.shape
        self.squeeze = nn.Sequential(nn.Conv2d(ch, 128, 1), nn.Hardswish())
        self.head = nn.Sequential(
            nn.Flatten(),
            nn.Linear(128 * fh * fw, 512),
            nn.Hardswish(),
            nn.Dropout(0.1),
            nn.Linear(512, N_FACES * OUT_PER_FACE),
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        y = self.head(self.squeeze(self.backbone(x)))
        return y.view(-1, N_FACES, OUT_PER_FACE)


def keypoint_loss(pred: torch.Tensor, conf_t: torch.Tensor, corners_t: torch.Tensor,
                  valid_t: torch.Tensor | None = None, hidden_weight: float = 0.2):
    """pred (B,6,9); conf_t (B,6); corners_t (B,6,4,2) normalized; valid_t (B,6).

    BCE on visibility + SmoothL1 on corners. Hidden faces' corners on
    synthetic data are still deterministic geometry (shared cube vertices),
    so they get a small weight instead of none. Hand-labeled real frames
    (M5) have valid=0 for unlabeled faces - unknown geometry, weight zero.

    DECISION: the corner loss is rotation-invariant - the minimum over the
    4 cyclic shifts of the target quad. On a dead-on view of a single face
    the starting corner is genuinely unobservable, and demanding it anyway
    made the model hedge by averaging the 4 rotations (shrunken diamonds).
    The model's job is the quad; which corner is "first" is recovered
    downstream from shared edges between faces and temporal tracking.
    Cyclic shifts only, no reflections: a visible face always projects with
    consistent winding, and labels are winding-normalized at import.
    """
    conf_logit = pred[:, :, 0]
    corners_p = pred[:, :, 1:].view(-1, 6, 4, 2)
    conf_loss = nn.functional.binary_cross_entropy_with_logits(conf_logit, conf_t)
    per = torch.stack([
        nn.functional.smooth_l1_loss(corners_p, corners_t.roll(k, dims=2), beta=0.02,
                                     reduction="none").mean(dim=(2, 3))
        for k in range(4)
    ]).min(dim=0).values
    w = conf_t + hidden_weight * (1 - conf_t)
    if valid_t is not None:
        w = w * valid_t
    corner_loss = (per * w).sum() / w.sum().clamp(min=1e-6)
    return conf_loss + 5.0 * corner_loss, conf_loss, corner_loss


@torch.no_grad()
def pixel_error(pred: torch.Tensor, conf_t: torch.Tensor, corners_t: torch.Tensor,
                wh=KP_WH, valid_t: torch.Tensor | None = None):
    """Mean corner error in pixels at `wh`, over ground-truth-visible faces.

    Rotation-invariant like the loss: per face, the best of the 4 cyclic
    shifts of the target. Not directly comparable with runs before the
    invariant loss (it can only be lower for the same predictions).
    """
    corners_p = pred[:, :, 1:].view(-1, 6, 4, 2)
    scale = torch.tensor(wh, dtype=pred.dtype, device=pred.device)
    d = torch.stack([
        ((corners_p - corners_t.roll(k, dims=2)) * scale).norm(dim=-1).mean(dim=-1)
        for k in range(4)
    ]).min(dim=0).values  # (B,6)
    mask = conf_t > 0.5
    if valid_t is not None:
        mask = mask & (valid_t > 0.5)
    return d[mask].mean().item() if mask.any() else float("nan")


@torch.no_grad()
def conf_accuracy(pred: torch.Tensor, conf_t: torch.Tensor):
    return ((pred[:, :, 0] > 0) == (conf_t > 0.5)).float().mean().item()


# ---------------------------------------------------------------------------
# Anonymous-quad head (2026-09-12). See model/PLAN-anonymous-conv-head.md.
# ---------------------------------------------------------------------------
#
# The FC head above is 5.27M of FaceKP's 6.27M params, it is position-specific
# (every feature cell has private weights, so position and scale generalization
# must be learned from data), it is the layer that makes int8 quantization
# useless, and its six NAMED output slots force the loss to commit to a face
# identity - which on a symmetric corner-on view means averaging competing
# hypotheses into a diamond. FaceKPCenter replaces it with a fully
# convolutional CenterNet-style head ("Objects as Points", Zhou et al. 2019,
# arXiv 1904.07850): faces are peaks in a single face-center heatmap and the
# four corners are regressed as offsets from the peak cell. No face names in
# the model at all; the web app names each quad by its center sticker color,
# which - the generator rendering every cube in the fixed standard scheme - is
# what the identity slots were really learning anyway.

HEADS = ("legacy", "center")
CENTER_STRIDE = 16
# Decode deduplication (2026-09-12, replaces the 3x3 max-pool NMS - see
# decode_maps). Suppression radius is a fraction of the KEPT quad's mean edge,
# so it shrinks with the cube instead of being frozen at one cell.
CENTER_DEDUPE_FRAC = 0.5
CENTER_MIN_DEDUPE_PX = 8.0     # floor, for degenerate near-zero-area quads
CENTER_MAX_CANDIDATES = 32     # cells decoded per image before deduplication
CENTER_OUT_CH = 9  # 1 heatmap logit + 4 corners * (dx, dy)   (npts=4; 33 for the 16-point grid)
# 2026-09-13: `npts` picks what the offsets regress - the 4 corners, or the
# 16 seam-grid points derived from them (targets.face_points). Checkpoints
# record it as `npts` (absent => 4); the head name stays "center" so every
# `head == "center"` branch in the tools keeps working. The maps' channel
# count says which: 1 + 2 * npts.
POINT_COUNTS = (4, 16)
# M13 (2026-09-19): the twist head adds 8 channels after the offsets - 6
# class logits (none / self / edge0..3, targets.py's module comment) and the
# angle as (cos 4a, sin 4a). The channel count alone says what a map tensor
# carries: 9 or 33 without the twist head, 17 or 41 with it.
TWIST_CH = 8
TWIST_CLASSES = 6
# CenterNet's prior-probability bias: start the heatmap at p=0.1 so the first
# epochs are not dominated by the ~255 negative cells per positive.
HEAT_PRIOR_BIAS = -2.19


def _conv_bn_act(cin: int, cout: int, k: int) -> nn.Sequential:
    return nn.Sequential(nn.Conv2d(cin, cout, k, padding=k // 2, bias=False),
                         nn.BatchNorm2d(cout), nn.Hardswish())


class FaceKPCenter(nn.Module):
    """MobileNetV3-Small -> stride-16 neck with global context -> 1+2P maps.

    Output (B, 1+2P, H/16, W/16), i.e. (B,9,16,16) at the 256x256 crop input
    for P = npts = 4 corners, (B,33,16,16) for the 16-point seam grid:
      channel 0    face-center heatmap LOGIT (sigmoid at decode)
      channels 1.. point offsets x0,y0,..,x(P-1),y(P-1) in CELL units (1 cell
                   = 16 input px), relative to the center of the cell they sit
                   in. Linear and unbounded: corners of a partially visible
                   face legitimately fall outside the frame. Grid order is
                   targets.quad_grid_points (row-major, corners at
                   GRID_CORNER_IDX).

    The neck exists because a stride-32 map is too coarse to place a corner
    and a raw stride-16 tap has no global context (48 channels of mid-level
    texture cannot tell a cube face from a bathroom tile); upsampling the
    stride-32 trunk into it is the cheapest way to have both.
    """

    def __init__(self, pretrained: bool = True, input_hw=(KP_WH[1], KP_WH[0]), split: int = 9,
                 npts: int = 4, twist: bool = False):
        super().__init__()
        if npts not in POINT_COUNTS:
            raise ValueError(f"npts must be one of {POINT_COUNTS}, got {npts}")
        self.npts = npts
        self.twist = twist
        weights = MobileNet_V3_Small_Weights.DEFAULT if pretrained else None
        feats = mobilenet_v3_small(weights=weights).features
        self.stem = feats[:split]    # stride 16
        self.deep = feats[split:]    # stride 32
        with torch.no_grad():
            probe16 = self.stem(torch.zeros(1, 3, *input_hw))
            probe32 = self.deep(probe16)
        c16, c32 = probe16.shape[1], probe32.shape[1]
        self.grid_hw = (probe16.shape[2], probe16.shape[3])
        self.lateral = _conv_bn_act(c32, 96, 1)
        self.fuse = nn.Sequential(_conv_bn_act(c16 + 96, 96, 3), _conv_bn_act(96, 96, 3))
        self.head = nn.Conv2d(96, 1 + 2 * npts + (TWIST_CH if twist else 0), 1)
        nn.init.normal_(self.head.weight, std=0.01)
        nn.init.zeros_(self.head.bias)
        with torch.no_grad():
            self.head.bias[0] = HEAT_PRIOR_BIAS

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        s16 = self.stem(x)
        s32 = self.deep(s16)
        up = nn.functional.interpolate(self.lateral(s32), size=s16.shape[-2:],
                                       mode="bilinear", align_corners=False)
        return self.head(self.fuse(torch.cat([s16, up], dim=1)))


def build_model(head: str = "center", pretrained: bool = True, input_hw=(KP_WH[1], KP_WH[0]),
                npts: int = 4, twist: bool = False) -> nn.Module:
    """The single place that turns a checkpoint's `head` key into a module.

    Checkpoints written before 2026-09-12 have no `head` key, so every caller
    passes `ckpt.get("head", "legacy")` - which is why "legacy" must keep
    loading, exporting and diagnosing forever. Likewise `npts` is
    `ckpt.get("npts", 4)`: center checkpoints before 2026-09-13 are 4-corner.
    """
    if head == "legacy":
        return FaceKP(pretrained=pretrained, input_hw=input_hw)
    if head == "center":
        return FaceKPCenter(pretrained=pretrained, input_hw=input_hw, npts=npts, twist=twist)
    raise ValueError(f"unknown head {head!r} (expected one of {HEADS})")


def load_center_weights(model: nn.Module, state: dict) -> str:
    """Load a center-head checkpoint into `model`, growing or shrinking the
    head's last 1x1 conv when only the TWIST channels differ (a kpft8-style
    checkpoint initialising a --twist run keeps its heatmap and corner
    channels; the twist channels start fresh). Returns a note for the log."""
    w, b = state["head.weight"], state["head.bias"]
    mine = model.head.weight
    if w.shape == mine.shape:
        model.load_state_dict(state)
        return "all weights"
    P = model.npts
    base = 1 + 2 * P
    if w.shape[0] not in (base, base + TWIST_CH) or w.shape[1:] != mine.shape[1:]:
        raise ValueError(f"head shape {tuple(w.shape)} cannot initialise {tuple(mine.shape)}")
    state = dict(state)
    n = min(w.shape[0], mine.shape[0])
    new_w, new_b = mine.detach().clone(), model.head.bias.detach().clone()
    new_w[:n], new_b[:n] = w[:n], b[:n]
    state["head.weight"], state["head.bias"] = new_w, new_b
    model.load_state_dict(state)
    return (f"heatmap + corner channels ({n}); {mine.shape[0] - n} twist channels fresh"
            if mine.shape[0] > n else f"heatmap + corner channels ({n}); the checkpoint's twist channels dropped")


def center_loss(maps: torch.Tensor, targets, off_weight: float = 1.0,
                twist_weight: tuple[float, float] = (0.5, 0.5)):
    """CenterNet losses over the dense targets from targets.build_center_targets.

    heat: penalty-reduced focal loss (alpha=2, beta=4), summed over cells and
    divided by the number of positive faces - so a frame showing one face and
    a frame showing three weigh per face, not per frame.

    off: SmoothL1 in cell units over the supervised cells, taking the MINIMUM
    over the 4 cyclic shifts of the target quad (for the 16-point grid, the
    matching rotations of the grid: targets.cyclic_perms), weighted by the
    Gaussian.
    The cyclic minimum is the same DECISION as keypoint_loss's: on a dead-on
    lone face the starting corner is unobservable, and demanding it anyway
    made the old head hedge by averaging the four rotations. Cyclic shifts
    only, never reflections - a visible face always projects with consistent
    winding and labels are winding-normalized at import.

    twist (maps with TWIST_CH extra channels and targets built with a twist
    label): cross-entropy over the six classes at the supervised cells,
    against the class under the cyclic shift THE CORNERS CHOSE (the argmin
    of the four shift losses), weighted by targets.tw_cw; SmoothL1 on
    (cos 4a, sin 4a) weighted by targets.tw_aw. `twist_weight` scales the
    two (DECISION: 0.5 each; the heat term runs 0.5-1, off 0.1-0.3 late in
    a run - retune if either twist term is 5x off).

    Returns (loss, heat_loss, off_loss, twist_cls_loss, twist_ang_loss); the
    last two are 0 without a twist head. Retune `off_weight` only if one term
    is more than 5x the other after epoch 3.
    """
    B, _, H, W = maps.shape
    heat_p = maps[:, 0]
    p = torch.sigmoid(heat_p.float()).clamp(1e-4, 1 - 1e-4)
    heat_t = targets.heat.float()
    is_pos = heat_t >= 1.0
    # Cells covered by an out-of-range face are neither positive nor
    # background: the model is told nothing about them (see
    # shapes.MIN_FACE_EDGE_FRAC). Without this they would be trained as hard
    # negatives, which teaches the detector to actively suppress small faces
    # rather than merely not care about them.
    keep_neg = ~is_pos & ~targets.ignore
    pos_loss = -((1 - p) ** 2) * torch.log(p) * is_pos
    neg_loss = -((1 - heat_t) ** 4) * (p ** 2) * torch.log(1 - p) * keep_neg
    npos = targets.npos.clamp(min=1).to(p.dtype)
    heat_loss = (pos_loss.sum() + neg_loss.sum()) / npos

    P = points_in_maps(maps)
    off_p = maps[:, 1:1 + 2 * P].float().view(B, P, 2, H, W)   # the twist channels, if any, follow
    off_t = targets.off.float()
    if off_t.shape[1] != P:
        raise ValueError(f"maps carry {P} points per face but the targets {off_t.shape[1]} "
                         f"- --points and the checkpoint's npts disagree")
    perms = _perms(P, maps.device)
    per_shift = torch.stack([
        nn.functional.smooth_l1_loss(off_p, off_t[:, perms[k]], beta=0.3,
                                     reduction="none").mean(dim=(1, 2))
        for k in range(4)
    ])                                                      # (4,B,H,W)
    per = per_shift.min(dim=0).values                       # (B,H,W)
    w = targets.weight.float()
    off_loss = (per * w).sum() / w.sum().clamp(min=1e-6)
    loss = heat_loss + off_weight * off_loss
    zero = torch.zeros((), device=maps.device, dtype=heat_loss.dtype)
    cls_loss = ang_loss = zero
    if has_twist(maps) and getattr(targets, "tw_cls", None) is not None:
        best = per_shift.argmin(dim=0)                               # (B,H,W) the shift the corners chose
        cls_t = targets.tw_cls.gather(1, best.unsqueeze(1)).squeeze(1)   # (B,H,W)
        c0 = 1 + 2 * P
        logits = maps[:, c0:c0 + TWIST_CLASSES].float()
        ce = nn.functional.cross_entropy(logits, cls_t, reduction="none")   # (B,H,W)
        cw = targets.tw_cw.float()
        cls_loss = (ce * cw).sum() / cw.sum().clamp(min=1e-6)
        ang_p = maps[:, c0 + TWIST_CLASSES:c0 + TWIST_CH].float()
        ang = nn.functional.smooth_l1_loss(ang_p, targets.tw_ang.float(), beta=0.3,
                                           reduction="none").mean(dim=1)   # (B,H,W)
        aw = targets.tw_aw.float()
        ang_loss = (ang * aw).sum() / aw.sum().clamp(min=1e-6)
        loss = loss + twist_weight[0] * cls_loss + twist_weight[1] * ang_loss
    return loss, heat_loss, off_loss, cls_loss, ang_loss


def has_twist(maps: torch.Tensor) -> bool:
    """Whether a map tensor carries the twist head's channels."""
    c = maps.shape[1]
    if c in (1 + 2 * 4, 1 + 2 * 16):
        return False
    if c in (1 + 2 * 4 + TWIST_CH, 1 + 2 * 16 + TWIST_CH):
        return True
    raise ValueError(f"maps carry {c} channels: not a center head layout")


def points_in_maps(maps: torch.Tensor) -> int:
    """How many points per face a (B,1+2P[+8],H,W) map tensor carries."""
    return (maps.shape[1] - 1 - (TWIST_CH if has_twist(maps) else 0)) // 2


def twist_deg_mod90(cos_sin: torch.Tensor) -> torch.Tensor:
    """(...,2) (cos 4a, sin 4a) -> the angle in degrees mod 90, in [0, 90)."""
    deg = torch.rad2deg(torch.atan2(cos_sin[..., 1], cos_sin[..., 0])) / 4
    return deg % 90


_PERM_CACHE: dict = {}


def _perms(npts: int, device) -> torch.Tensor:
    key = (npts, str(device))
    if key not in _PERM_CACHE:
        from targets import cyclic_perms
        _PERM_CACHE[key] = cyclic_perms(npts).to(device)
    return _PERM_CACHE[key]


def quad_corners(points: torch.Tensor) -> torch.Tensor:
    """(...,P,2) decoded points -> (...,4,2) corners: identity for P=4, the
    four grid corners (targets.GRID_CORNER_IDX) for the 16-point grid."""
    if points.shape[-2] == 4:
        return points
    from targets import GRID_CORNER_IDX
    return points[..., list(GRID_CORNER_IDX), :]


@torch.no_grad()
def decode_maps(maps: torch.Tensor, input_wh=KP_WH, k: int = 6, thresh: float = 0.3,
                stride: int = CENTER_STRIDE, points: bool = False, with_twist: bool = False):
    """(B,1+2P,H,W) raw maps -> (scores (B,k), quads (B,k,4,2) normalized).

    With `points=True` the second result is (B,k,P,2): every regressed point
    (the 16-point grid for a grid checkpoint; identical to the quads for P=4).
    Deduplication and the default corners come from the 4 corner points
    either way, so a grid model scores exactly like a corner model.

    With `with_twist=True` (maps from a twist head) a third result: the
    twist read at each kept quad's cell, {"probs": (B,k,6) softmax over
    none / self / edge0..3 IN THE QUAD'S OWN CORNER ORDER, "deg": (B,k) the
    angle mod 90}. Edge j of the quad is corner j -> corner j+1 as decoded.

    THE SINGLE SOURCE OF TRUTH for decoding. web/src/detect/facekp.ts mirrors
    this function line for line and web/test/facekp-decode.test.ts compares the
    two against a dumped fixture - change one, change the other. (The mirror
    is the 9-channel corner version as of 2026-09-13; a grid model needs its
    P read from facekp.json before it ships.)

    Quads are ANONYMOUS: corner order is cyclic with consistent winding, the
    starting corner is arbitrary, and nothing here says which face it is.
    Entries below `thresh` come back with score 0 and are to be ignored.

    DECISION 2026-09-12: deduplicate on the DECODED QUADS, not with a 3x3
    max-pool over the heatmap. The old NMS kept a cell only if it was the
    brightest within one cell of itself, i.e. a suppression radius frozen at
    one stride (16 px) whatever the cube's size on screen. The spacing between
    the three face centres of a cube is NOT fixed: on a cube 43 px per face the
    centres sit ~1.8 cells apart, so the strongest face's blob is still rising
    as it crosses the weaker face's own centre cell, and that face is dropped
    with the model 0.83 confident in it. Measured on data_v4 val, this was 63%
    of ALL misses (126 of 201) and the discarded faces were not even
    foreshortened (median squash 0.72). Deduplicating by distance relative to
    the kept quad's own mean edge scales the radius with the cube:
    misses 201 -> 75, F1 0.979 -> 0.988 on the same checkpoint, no retraining.

    Candidates are every cell at or above `thresh`, strongest first (ties go to
    the lower cell index, as torch.topk on a 1-D view does), capped at
    CENTER_MAX_CANDIDATES; a candidate is dropped when its centre falls within
    CENTER_DEDUPE_FRAC of an already-kept quad's mean edge length.
    """
    B, _, H, W = maps.shape
    heat = torch.sigmoid(maps[:, 0])
    cand = min(CENTER_MAX_CANDIDATES, H * W)
    # Strongest first, ties to the LOWER cell index. A stable descending sort
    # says that outright; torch.topk does not promise it (measured: it returned
    # the higher cell first for an exact tie) and the TypeScript mirror sorts
    # by (score desc, cell asc), so the two must be pinned here.
    flat = heat.view(B, -1)
    top_i = torch.argsort(flat, dim=1, descending=True, stable=True)[:, :cand]
    top_v = flat.gather(1, top_i)
    ci = torch.div(top_i, W, rounding_mode="floor")
    cj = top_i % W
    P = points_in_maps(maps)
    off = maps[:, 1:1 + 2 * P].reshape(B, P, 2, H * W)
    gathered = off.gather(3, top_i.view(B, 1, 1, -1).expand(B, P, 2, cand))
    px = (cj.unsqueeze(1).to(maps.dtype) + 0.5 + gathered[:, :, 0]) * stride
    py = (ci.unsqueeze(1).to(maps.dtype) + 0.5 + gathered[:, :, 1]) * stride
    pts_px = torch.stack([px, py], dim=-1).permute(0, 2, 1, 3)        # (B,cand,P,2)
    quads_px = quad_corners(pts_px)                                   # (B,cand,4,2)
    centres = quads_px.mean(dim=2)                                    # (B,cand,2)
    edge = (quads_px - quads_px.roll(-1, dims=2)).norm(dim=-1).mean(dim=2)  # (B,cand)
    radius = torch.clamp(CENTER_DEDUPE_FRAC * edge, min=CENTER_MIN_DEDUPE_PX)  # (B,cand)

    # Greedy, strongest first. Only a candidate that is still alive suppresses,
    # so a quad killed by a stronger one cannot go on to kill a third.
    alive = top_v >= thresh
    for i in range(cand - 1):
        d = (centres[:, i + 1:] - centres[:, i:i + 1]).norm(dim=-1)   # (B,cand-i-1)
        hit = (d < radius[:, i:i + 1]) & alive[:, i:i + 1]
        alive[:, i + 1:] &= ~hit

    # Take the first k survivors in CANDIDATE order, not by a second topk: the
    # candidates are already strongest-first with ties resolved by cell index,
    # and topk does not promise to preserve that order for equal scores (two
    # tied quads came back swapped against the TypeScript mirror). Sorting a
    # boolean stably keeps the survivors in their original order.
    kk = min(k, cand)
    order = torch.argsort(~alive, dim=1, stable=True)[:, :kk]
    sel_v = top_v.gather(1, order) * alive.gather(1, order).to(top_v.dtype)
    src = pts_px if points else quads_px
    n = src.shape[2]
    out = src.gather(1, order.view(B, kk, 1, 1).expand(B, kk, n, 2))
    out = out / torch.tensor(input_wh, dtype=out.dtype, device=out.device)
    if not with_twist:
        return sel_v, out
    if not has_twist(maps):
        raise ValueError("with_twist=True on maps without the twist channels")
    c0 = 1 + 2 * P
    tw = maps[:, c0:c0 + TWIST_CH].reshape(B, TWIST_CH, H * W).float()
    cells = top_i.gather(1, order)                                    # (B,kk)
    at = tw.gather(2, cells.view(B, 1, kk).expand(B, TWIST_CH, kk)).permute(0, 2, 1)   # (B,kk,8)
    probs = torch.softmax(at[..., :TWIST_CLASSES], dim=-1)
    deg = twist_deg_mod90(at[..., TWIST_CLASSES:TWIST_CH])
    return sel_v, out, {"probs": probs, "deg": deg}


def decode_to_list(maps: torch.Tensor, **kw) -> list[list[dict]]:
    """decode_maps as the per-image list of {score, quad} the plan describes."""
    scores, quads = decode_maps(maps, **kw)
    return [[{"score": float(scores[b, i]), "quad": quads[b, i].cpu().numpy()}
             for i in range(scores.shape[1]) if scores[b, i] > 0]
            for b in range(maps.shape[0])]


# --- anonymous-aware metrics -------------------------------------------------
#
# train.py's log line keys (val_px, val_conf_acc) are kept because watch.py
# parses them, but both are REDEFINED for this head:
#   val_px / real_px  mean corner error over detections MATCHED to a ground
#                     truth face; unmatched GT faces are misses and stay out
#                     of the mean (they show up in the F1 instead).
#   val_conf_acc      detection F1 at score 0.5, NOT the old per-slot
#                     visibility accuracy. Do not compare it across heads.

MATCH_CENTROID_FRAC = 0.5   # accept a match within 50% of the GT mean edge length
METRIC_SCORE_THRESH = 0.5


def _mean_edge(quad) -> float:
    import numpy as np
    return float(np.linalg.norm(quad - np.roll(quad, -1, axis=0), axis=1).mean())


def _max_edge(quad) -> float:
    import numpy as np
    return float(np.linalg.norm(quad - np.roll(quad, -1, axis=0), axis=1).max())


@torch.no_grad()
def twist_counts_zero() -> dict:
    """The accumulator `center_metrics` fills for the twist head: matched
    in-range faces with a known twist state, split by whether the label says
    the face is twisted (self or an edge)."""
    return {"n": 0, "twisted": 0, "tp": 0, "fp": 0, "fn": 0, "cls_ok": 0, "n_ang": 0, "ang_err": 0.0}


def twist_summary(c: dict) -> dict:
    """-> {'tw_f1': twisted-vs-none F1, 'tw_cls': class accuracy on twisted
    faces (self / which edge), 'tw_deg': mean angle error mod 90 on them}."""
    return {"tw_f1": f1_from_counts(c["tp"], c["fp"], c["fn"]),
            "tw_cls": c["cls_ok"] / c["twisted"] if c["twisted"] else 1.0,
            "tw_deg": c["ang_err"] / c["n_ang"] if c["n_ang"] else 0.0}


def center_metrics(maps: torch.Tensor, conf_t: torch.Tensor, corners_t: torch.Tensor,
                   valid_t: torch.Tensor, wh=KP_WH, thresh: float = METRIC_SCORE_THRESH,
                   twist_t: torch.Tensor | None = None, twist_counts: dict | None = None):
    """Greedy centroid matching of decoded quads to visible+valid GT faces.

    Returns (sum_corner_err_px, n_matched, tp, fp, fn) so the caller can
    accumulate over batches. There are at most 3 of each per image, so greedy
    by ascending centroid distance is optimal enough and easy to read.

    With `twist_t` (B,2) labels and maps from a twist head, the twist read
    at every matched in-range face is scored into `twist_counts`
    (twist_counts_zero / twist_summary): the label's class is taken under
    the cyclic shift that matched the corners, so a quad decoded starting
    from a different corner is not penalised for naming the same edge.
    """
    import numpy as np

    from targets import TWIST_NONE, quad_centers, shift_twist_class, twist_face_classes, twist_known

    min_edge = min_face_edge_px(wh[1])

    do_twist = twist_t is not None and twist_counts is not None and has_twist(maps)
    if do_twist:
        scores, quads, tw = decode_maps(maps, input_wh=wh, thresh=thresh, with_twist=True)
        tw_probs = tw["probs"].cpu().numpy()
        tw_deg = tw["deg"].cpu().numpy()
        cls0 = twist_face_classes(twist_t).cpu()                    # (B,6)
        known = twist_known(twist_t).cpu().numpy()
        gt_deg = twist_t[:, 1].cpu().numpy()
    else:
        scores, quads = decode_maps(maps, input_wh=wh, thresh=thresh)
    scale_t = torch.tensor(wh, dtype=torch.float32)
    dets_s = scores.detach().float().cpu().numpy()
    quads_px = quads.detach().float().cpu() * scale_t
    gt_px = corners_t.detach().float().cpu() * scale_t
    dets_q = quads_px.numpy()
    gt_q = gt_px.numpy()
    gt_ok = ((conf_t > 0.5) & (valid_t > 0.5)).cpu().numpy()
    gt_c = quad_centers(gt_px).numpy()
    det_c = quad_centers(quads_px).numpy()

    err_sum = 0.0
    matched = tp = fp = fn = 0
    for b in range(dets_s.shape[0]):
        dets = [i for i in range(dets_s.shape[1]) if dets_s[b, i] > 0]
        # Faces further away than a person can hold a cube are IGNORED, not
        # scored: they are matched (so a detection on one is not a false
        # positive) but contribute to neither the pixel mean nor the F1.
        all_gt = [f for f in range(6) if gt_ok[b, f]]
        in_range = {f: _max_edge(gt_q[b, f]) >= min_edge for f in all_gt}
        gts = [f for f in all_gt if in_range[f]]
        pairs = sorted(((float(np.linalg.norm(det_c[b, i] - gt_c[b, f])), i, f)
                        for i in dets for f in all_gt), key=lambda t: t[0])
        used_d: set[int] = set()
        used_g: set[int] = set()
        for dist, i, f in pairs:
            if i in used_d or f in used_g:
                continue
            if dist > MATCH_CENTROID_FRAC * _mean_edge(gt_q[b, f]):
                continue
            used_d.add(i)
            used_g.add(f)
            if not in_range[f]:
                continue        # matched only to absorb the detection
            roll_err, best_r = min(
                (float(np.linalg.norm(dets_q[b, i] - np.roll(gt_q[b, f], r, axis=0), axis=1).mean()), r)
                for r in range(4))
            err_sum += roll_err
            matched += 1
            if do_twist and known[b]:
                # np.roll(gt, r)[j] = gt[(j - r) % 4]: the quad's corner j is
                # the label's corner j - r, so the label's edge e is the
                # quad's edge e + r, i.e. shift_twist_class with s = -r.
                gt_cls = int(shift_twist_class(cls0[b, f:f + 1], -best_r % 4)[0])
                pred_cls = int(tw_probs[b, i].argmax())
                c = twist_counts
                c["n"] += 1
                if gt_cls != TWIST_NONE:
                    c["twisted"] += 1
                    c["cls_ok"] += pred_cls == gt_cls
                    if pred_cls != TWIST_NONE:
                        c["tp"] += 1
                    else:
                        c["fn"] += 1
                    if np.isfinite(gt_deg[b]):
                        d = abs(float(tw_deg[b, i]) - float(gt_deg[b]) % 90) % 90
                        c["ang_err"] += min(d, 90 - d)
                        c["n_ang"] += 1
                elif pred_cls != TWIST_NONE:
                    c["fp"] += 1
        tp += len([f for f in used_g if in_range[f]])
        fp += len(dets) - len(used_d)
        fn += len(gts) - len([f for f in used_g if in_range[f]])
    return err_sum, matched, tp, fp, fn


def f1_from_counts(tp: int, fp: int, fn: int) -> float:
    denom = 2 * tp + fp + fn
    return (2 * tp / denom) if denom else 1.0


def count_params(model: nn.Module) -> int:
    return sum(p.numel() for p in model.parameters())
