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

# Offsets are supervised wherever the Gaussian is at least this high. Below
# it the splat is mostly there to shape the heatmap, and regressing corners
# from a cell that far off-center only adds noise.
OFF_SUPERVISE_MIN = 0.5


@dataclass
class CenterTargets:
    """All maps are in grid-cell units; H,W are the feature-map dims."""
    heat: torch.Tensor    # (B,H,W) in [0,1], 1.0 exactly at each face's center cell
    off: torch.Tensor     # (B,4,2,H,W) target corner offsets from the cell center
    weight: torch.Tensor  # (B,H,W) Gaussian value where offsets are supervised, else 0
    npos: torch.Tensor    # 0-dim: positive faces in the batch (heat-loss normalizer)
    dropped: int          # positives whose center fell outside the grid (stats=True only)
    collisions: int       # positive center cells claimed by >1 face (stats=True only)


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
                         grid_hw: tuple[int, int], stats: bool = False) -> CenterTargets:
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
    B = conf.shape[0]
    dev = corners.device
    scale = torch.tensor([W, H], dtype=corners.dtype, device=dev)
    cells = corners * scale                       # (B,6,4,2) in cell units
    center = quad_centers(cells)                  # (B,6,2)
    area = quad_areas(cells)                      # (B,6)
    sigma = gaussian_sigma(area)                  # (B,6)

    pos = (conf > 0.5) & (valid > 0.5)            # (B,6)
    cx, cy = center[..., 0], center[..., 1]
    in_grid = (cx >= 0) & (cx < W) & (cy >= 0) & (cy < H)
    off_grid = pos & ~in_grid
    pos = pos & in_grid

    gx = torch.arange(W, device=dev, dtype=corners.dtype) + 0.5
    gy = torch.arange(H, device=dev, dtype=corners.dtype) + 0.5
    d2 = ((gx.view(1, 1, 1, W) - cx.view(B, 6, 1, 1)) ** 2
          + (gy.view(1, 1, H, 1) - cy.view(B, 6, 1, 1)) ** 2)   # (B,6,H,W)
    g = torch.exp(-d2 / (2 * sigma.view(B, 6, 1, 1) ** 2)) * pos.view(B, 6, 1, 1)

    # The focal loss's positive branch keys on target == 1, so the cell that
    # contains the center is pinned to exactly 1 (the continuous splat peaks
    # below 1 whenever the center sits off a cell center).
    ci = cy.floor().clamp(0, H - 1).long()
    cj = cx.floor().clamp(0, W - 1).long()
    bi = torch.arange(B, device=dev).view(B, 1).expand(B, 6)
    fi = torch.arange(6, device=dev).view(1, 6).expand(B, 6)
    g[bi, fi, ci, cj] = pos.to(g.dtype)

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

    dropped = collisions = 0
    if stats:
        dropped = int(off_grid.sum().item())
        # Two positive faces whose centers land in the same cell: only one of
        # them can be the peak there. The plan's tripwire for "stride 16 is
        # too coarse" is 2% of positives.
        flat = (ci * W + cj).masked_fill(~pos, -1)  # (B,6)
        same = (flat.unsqueeze(2) == flat.unsqueeze(1)) & (flat.unsqueeze(2) >= 0)
        collisions = int(same.triu(diagonal=1).sum().item())

    return CenterTargets(heat=heat, off=off, weight=weight,
                         npos=pos.sum(), dropped=dropped, collisions=collisions)


def dataset_target_stats(datasets, grid_hw: tuple[int, int], name: str = "val") -> dict:
    """Label-health numbers the center head cares about, read straight off the
    cached (unaugmented) label arrays: visible-but-unlabeled faces, and
    positive faces whose center cells collide. Printed once at startup.

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
    npos = collisions = dropped = 0
    for s0 in range(0, conf.shape[0], 2048):
        sl = slice(s0, s0 + 2048)
        t = build_center_targets(conf[sl], corners[sl], valid[sl], grid_hw, stats=True)
        npos += int(t.npos.item())
        collisions += t.collisions
        dropped += t.dropped
    pct = 100 * collisions / max(1, npos)
    print(f"targets[{name}]: {conf.shape[0]} images, {npos} positive faces, "
          f"{collisions} colliding center cells ({pct:.2f}%), "
          f"{dropped} centers off-grid, {unlabeled} visible-but-unlabeled faces", flush=True)
    if unlabeled:
        print("  WARNING: faces are visible with no corners - they train as background. "
              "Fix the labels (model/README.md 'M5 labeling workflow').", flush=True)
    if pct > 2.0:
        print("  WARNING: >2% center-cell collisions - raise the grid to stride 8 "
              "before trusting this run (PLAN section 1.2).", flush=True)
    return {"images": conf.shape[0], "positives": npos, "collisions": collisions,
            "collision_pct": pct, "off_grid": dropped, "visible_unlabeled": unlabeled}
