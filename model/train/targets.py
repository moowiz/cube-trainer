"""Dense CenterNet-style targets for the anonymous-quad head (M4, 2026-09-12).

The labels on disk and in the cache do not change: `conf (B,6)`,
`corners (B,6,4,2)` normalized, `valid (B,6)`, faces in URFDLB order. This
module turns a batch of those into the dense maps `FaceKPCenter` predicts,
on whatever device the batch already lives on. The grid is 15x20, so the
whole thing costs nothing next to the backbone - there is no reason to bake
it into the cache and every reason not to (augmentation moves the corners
every epoch).

Face IDENTITY is deliberately dropped here. A positive is "a visible face
lives at this cell", nothing more; the web app names the quad from its
center sticker color. See model/PLAN-anonymous-conv-head.md section 0.

Nothing on the hot path calls `.item()`: `npos` comes back as a 0-dim tensor
so a training step never syncs with the GPU. The counters that do sync
(`dropped`, `collisions`) are only filled in when `stats=True`, which is the
once-per-run `dataset_target_stats` call.
"""
from __future__ import annotations

from dataclasses import dataclass

import torch

from gpu_augment import const

# Offsets are supervised wherever the Gaussian is at least this high. Below
# it the splat is mostly there to shape the heatmap, and regressing corners
# from a cell that far off-center only adds noise.
OFF_SUPERVISE_MIN = 0.5

# DECISION 2026-09-12 (user): the app only has to work as far away as a person
# can hold a cube. Faces smaller than that are further than anyone will ever
# scan from, so they are neither trained nor scored - they become "ignore",
# not background: masked out of the heatmap loss so the model is free to do
# whatever it likes there, rather than being told there is nothing.
#
# The floor is a FRACTION OF THE FRAME HEIGHT (shapes.MIN_FACE_EDGE_FRAC =
# 0.133, ~13% under the measured arm's-reach edge of 0.153), so it is
# orientation-free and the same number on a 480x640 phone frame (85 px), the
# 320-tall frame cache (42.6 px) and the 256 stage-2 crop (34 px - on crops it
# only masks the sliver of a third face at the edge of a loose crop).
# In grid cells that is simply MIN_FACE_EDGE_FRAC * H.
#
# LONGEST EDGE, not sqrt(area), and this distinction matters more than the
# threshold does. Area conflates "far away" with "steeply angled": a face seen
# at a glancing angle on a cube held right up to the lens has a small area but
# a full-length long edge. Measured on the real photos, 79% of the faces that
# a sqrt(area) < 30 px rule would have discarded are close-up foreshortened
# faces - which are the third face of a corner-on view, the single most
# valuable pose we have (see --cornerBias in the generator). An area-based
# floor would have quietly deleted exactly the data we went out of our way to
# generate.
from shapes import MIN_FACE_EDGE_FRAC, min_face_edge_px  # noqa: E402  (re-exported)


def min_edge_cells(grid_hw: tuple[int, int]) -> float:
    """The floor in cells of a stride-16 grid `grid_hw` = (H, W)."""
    return MIN_FACE_EDGE_FRAC * grid_hw[0]


@dataclass
class CenterTargets:
    """All maps are in grid-cell units; H,W are the feature-map dims."""
    heat: torch.Tensor    # (B,H,W) in [0,1], 1.0 exactly at each face's center cell
    off: torch.Tensor     # (B,4,2,H,W) target corner offsets from the cell center
    weight: torch.Tensor  # (B,H,W) Gaussian value where offsets are supervised, else 0
    ignore: torch.Tensor  # (B,H,W) bool: out-of-range faces - not positive, not background
    npos: torch.Tensor    # 0-dim: positive faces in the batch (heat-loss normalizer)
    dropped: int          # positives whose center fell outside the grid (stats=True only)
    collisions: int       # positive center cells claimed by >1 face (stats=True only)
    too_far: int          # positives below the range floor (stats=True only)


def quad_centers(corners: torch.Tensor) -> torch.Tensor:
    """Intersection of the quad's diagonals. corners (...,4,2) -> (...,2).

    Not the mean of the corners: under perspective the mean drifts toward the
    near edge, while the diagonal intersection is the projection of the real
    square's center (a projective map preserves incidence, so the image of
    the diagonals' crossing is the crossing of the images).
    """
    p0, p1, p2, p3 = corners.unbind(dim=-2)
    r = p2 - p0
    s = p3 - p1
    denom = r[..., 0] * s[..., 1] - r[..., 1] * s[..., 0]
    ok = denom.abs() > 1e-9
    q = p1 - p0
    safe = torch.where(ok, denom, torch.ones_like(denom))
    t = (q[..., 0] * s[..., 1] - q[..., 1] * s[..., 0]) / safe
    inter = p0 + t.unsqueeze(-1) * r
    # Degenerate quads (collapsed or self-intersecting after a harsh augment)
    # have near-parallel diagonals; fall back to the centroid there.
    return torch.where(ok.unsqueeze(-1), inter, corners.mean(dim=-2))


def quad_max_edge(corners: torch.Tensor) -> torch.Tensor:
    """Longest of the quad's 4 edges. corners (...,4,2) -> (...).

    The scale measure that tracks DISTANCE rather than viewing angle: a
    foreshortened face loses area and loses its short edges, but its long
    edge is still the full width of the cube.
    """
    return (corners - corners.roll(-1, dims=-2)).norm(dim=-1).amax(dim=-1)


def quad_areas(corners: torch.Tensor) -> torch.Tensor:
    """Shoelace area, always positive. corners (...,4,2) -> (...)."""
    x = corners[..., 0]
    y = corners[..., 1]
    return 0.5 * (x * y.roll(-1, dims=-1) - y * x.roll(-1, dims=-1)).sum(dim=-1).abs()


def gaussian_sigma(area_cells: torch.Tensor) -> torch.Tensor:
    """CenterNet-style radius scaled to the face: 0.25 * side, clamped.

    A 3-cell-wide face gets sigma 0.8 (a tight peak - a neighbouring cell is
    a third of the whole face), a big close-up face gets 3.0.
    """
    return (0.25 * area_cells.clamp(min=0).sqrt()).clamp(0.8, 3.0)


def build_center_targets(conf: torch.Tensor, corners: torch.Tensor, valid: torch.Tensor,
                         grid_hw: tuple[int, int], stats: bool = False,
                         min_edge_cells: float | None = None) -> CenterTargets:
    """conf (B,6), corners (B,6,4,2) normalized to [0,1], valid (B,6).

    A face is a positive iff conf == 1 and valid == 1. Hidden faces
    (conf == 0) contribute nothing at all - the legacy head's `hidden_weight`
    supervision of never-observed geometry is gone. Faces that are visible
    but unlabeled (conf == 1, valid == 0) have no geometry to place, so they
    cannot be masked out of the negatives either; `dataset_target_stats`
    counts them so a labeling regression is loud rather than silent (every
    current root has zero).
    """
    H, W = grid_hw
    if min_edge_cells is None:
        min_edge_cells = MIN_FACE_EDGE_FRAC * H
    B = conf.shape[0]
    dev = corners.device
    scale = const([W, H], dev, corners.dtype)   # cached: torch.tensor(...) would sync
    cells = corners * scale                       # (B,6,4,2) in cell units
    center = quad_centers(cells)                  # (B,6,2)
    area = quad_areas(cells)                      # (B,6)
    sigma = gaussian_sigma(area)                  # (B,6)

    pos = (conf > 0.5) & (valid > 0.5)            # (B,6)
    cx, cy = center[..., 0], center[..., 1]
    in_grid = (cx >= 0) & (cx < W) & (cy >= 0) & (cy < H)
    off_grid = pos & ~in_grid
    pos = pos & in_grid
    # Out of range (further than a person can hold a cube): ignore, don't
    # demote to background. See MIN_FACE_EDGE_FRAC.
    out_of_range = pos & (quad_max_edge(cells) < min_edge_cells)
    pos = pos & ~out_of_range

    gx = torch.arange(W, device=dev, dtype=corners.dtype) + 0.5
    gy = torch.arange(H, device=dev, dtype=corners.dtype) + 0.5
    d2 = ((gx.view(1, 1, 1, W) - cx.view(B, 6, 1, 1)) ** 2
          + (gy.view(1, 1, H, 1) - cy.view(B, 6, 1, 1)) ** 2)   # (B,6,H,W)
    gauss = torch.exp(-d2 / (2 * sigma.view(B, 6, 1, 1) ** 2))
    g = gauss * pos.view(B, 6, 1, 1)
    # The ignore region: where an out-of-range face sits, the heatmap loss is
    # simply not applied. Same OFF_SUPERVISE_MIN footprint as a positive, plus
    # its own center cell, so a small face cannot leak in as a hard negative.
    ignore = ((gauss >= OFF_SUPERVISE_MIN) & out_of_range.view(B, 6, 1, 1)).any(dim=1)

    # The focal loss's positive branch keys on target == 1, so the cell that
    # contains the center is pinned to exactly 1 (the continuous splat peaks
    # below 1 whenever the center sits off a cell center).
    ci = cy.floor().clamp(0, H - 1).long()
    cj = cx.floor().clamp(0, W - 1).long()
    bi = torch.arange(B, device=dev).view(B, 1).expand(B, 6)
    fi = torch.arange(6, device=dev).view(1, 6).expand(B, 6)
    g[bi, fi, ci, cj] = pos.to(g.dtype)
    # Not `ignore[bi[out_of_range], ...] = True`: indexing with a bool mask
    # calls nonzero(), a device sync every step. scatter_add over all 6 faces
    # with the mask as the value is sync-free and deterministic on collisions.
    hits = torch.zeros(B, H * W, dtype=torch.int32, device=dev)
    hits.scatter_add_(1, (ci * W + cj), out_of_range.to(torch.int32))
    ignore |= hits.view(B, H, W) > 0

    heat = g.amax(dim=1)                          # (B,H,W), max-merged

    # Per-cell face assignment for the offset targets: among the faces whose
    # splat covers this cell, the one with the higher Gaussian value wins,
    # ties broken by area. Nearest-center-wins keeps the assignment locally
    # consistent (no discontinuity between a cell and the peak next to it)
    # and, because every face's own center cell is pinned to 1, guarantees a
    # peak cell regresses ITS OWN quad - which is the only thing decode ever
    # reads. The area tie-break is then exactly the plan's collision rule:
    # when two faces genuinely share a center cell, the larger one keeps it.
    # Encoded as one number so the pick is a single argmax; 1e6 >> any area
    # in cell units, so g is the primary key.
    covers = (g >= OFF_SUPERVISE_MIN) & pos.view(B, 6, 1, 1)
    pri = torch.where(covers, g * 1e6 + area.view(B, 6, 1, 1), torch.full_like(g, -1.0))
    owner = pri.argmax(dim=1)                     # (B,H,W)
    supervised = covers.any(dim=1)                # (B,H,W)

    idx = owner.view(B, 1, 1, 1, H, W).expand(B, 1, 4, 2, H, W)
    corner_cells = cells.view(B, 6, 4, 2, 1, 1).expand(B, 6, 4, 2, H, W)
    own_corners = corner_cells.gather(1, idx).squeeze(1)          # (B,4,2,H,W)
    mx, my = torch.meshgrid(gx, gy, indexing="xy")   # both (H,W)
    cell_center = torch.stack([mx, my], dim=0)       # (2,H,W)
    off = (own_corners - cell_center.view(1, 1, 2, H, W)) * supervised.view(B, 1, 1, H, W)

    weight = torch.where(supervised, heat, torch.zeros_like(heat))

    dropped = collisions = far = 0
    if stats:
        dropped = int(off_grid.sum().item())
        far = int(out_of_range.sum().item())
        # Two positive faces whose centers land in the same cell: only one of
        # them can be the peak there. The plan's tripwire for "stride 16 is
        # too coarse" is 2% of positives.
        flat = (ci * W + cj).masked_fill(~pos, -1)  # (B,6)
        same = (flat.unsqueeze(2) == flat.unsqueeze(1)) & (flat.unsqueeze(2) >= 0)
        collisions = int(same.triu(diagonal=1).sum().item())

    return CenterTargets(heat=heat, off=off, weight=weight, ignore=ignore,
                         npos=pos.sum(), dropped=dropped, collisions=collisions,
                         too_far=far)


def dataset_target_stats(datasets, grid_hw: tuple[int, int], name: str = "val") -> dict:
    """Label-health numbers the center head cares about, read straight off the
    cached (unaugmented) label arrays: visible-but-unlabeled faces, and
    positive faces whose center cells collide. Printed once at startup. For
    the crop view the arrays are the LOOSE cached crops, not the re-cropped
    inputs, so the out-of-range share reads high (faces are ~1.3x smaller in
    the cache than after the pad-0.45 re-crop).

    `datasets` is anything with `.conf`/`.corners`/`.valid` numpy arrays (a
    CubeKeypointDataset), or a nest of ConcatDataset/Subset around them.
    """
    import numpy as np

    roots: list = []
    seen: set[int] = set()

    def walk(ds):
        if hasattr(ds, "conf") and hasattr(ds, "corners"):
            if id(ds) not in seen:     # oversampled roots appear N times
                seen.add(id(ds))
                roots.append(ds)
        elif hasattr(ds, "datasets"):
            for d in ds.datasets:
                walk(d)
        elif hasattr(ds, "dataset"):
            walk(ds.dataset)

    walk(datasets)
    if not roots:
        return {}
    conf = torch.from_numpy(np.concatenate([r.conf for r in roots]))
    corners = torch.from_numpy(np.concatenate([r.corners for r in roots]))
    valid = torch.from_numpy(np.concatenate([r.valid for r in roots]))
    unlabeled = int(((conf > 0.5) & (valid < 0.5)).sum().item())
    # Chunked: the dense maps are (N,6,H,W), which is half a gigabyte at 76k.
    npos = collisions = dropped = far = 0
    for s0 in range(0, conf.shape[0], 2048):
        sl = slice(s0, s0 + 2048)
        t = build_center_targets(conf[sl], corners[sl], valid[sl], grid_hw, stats=True)
        npos += int(t.npos.item())
        collisions += t.collisions
        dropped += t.dropped
        far += t.too_far
    pct = 100 * collisions / max(1, npos)
    print(f"targets[{name}]: {conf.shape[0]} images, {npos} positive faces, "
          f"{collisions} colliding center cells ({pct:.2f}%), "
          f"{dropped} centers off-grid, {unlabeled} visible-but-unlabeled faces, "
          f"{far} ignored as out-of-range ({100 * far / max(1, npos + far):.1f}%, "
          f"long edge < {min_face_edge_px(grid_hw[0] * 16):.0f} px of a {grid_hw[0] * 16}-tall input)", flush=True)
    if unlabeled:
        print("  WARNING: faces are visible with no corners - they train as background. "
              "Fix the labels (model/README.md 'M5 labeling workflow').", flush=True)
    if pct > 2.0:
        print("  WARNING: >2% center-cell collisions - raise the grid to stride 8 "
              "before trusting this run (PLAN section 1.2).", flush=True)
    return {"images": conf.shape[0], "positives": npos, "collisions": collisions,
            "collision_pct": pct, "off_grid": dropped, "visible_unlabeled": unlabeled,
            "out_of_range": far}
