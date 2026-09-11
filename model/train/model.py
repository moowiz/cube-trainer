"""Face keypoint model (M4).

MobileNetV3-Small backbone (ImageNet init) -> 1x1 conv squeeze -> flatten ->
small MLP -> per-face [conf_logit, 4 corners as normalized (u,v)].

Output: (B, 6, 9), faces in URFDLB order, channel 0 the visibility logit
(apply sigmoid at inference), channels 1..8 = x0,y0,...,x3,y3 in [~0..1]
image-normalized coordinates (linear output - corners of partially visible
faces legitimately fall outside the frame).

DECISION: direct regression, not heatmaps. The cube is a single rigid object
filling much of the frame, so global regression is well-posed, exports to a
tiny static-shape ONNX graph, and avoids heatmap decoding in the browser.
Revisit if real-frame corner error (M5) stalls above the 3 px bar.
"""
from __future__ import annotations

import torch
from torch import nn
from torchvision.models import MobileNet_V3_Small_Weights, mobilenet_v3_small

N_FACES = 6
OUT_PER_FACE = 9  # conf + 4*(x,y)


class FaceKP(nn.Module):
    def __init__(self, pretrained: bool = True, input_hw=(240, 320)):
        super().__init__()
        weights = MobileNet_V3_Small_Weights.DEFAULT if pretrained else None
        self.backbone = mobilenet_v3_small(weights=weights).features  # (B,576,H/32,W/32)
        fh, fw = input_hw[0] // 32, input_hw[1] // 32  # 240x320 -> 7x10 (floor of last stride)
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
    """
    conf_logit = pred[:, :, 0]
    corners_p = pred[:, :, 1:].view(-1, 6, 4, 2)
    conf_loss = nn.functional.binary_cross_entropy_with_logits(conf_logit, conf_t)
    per = nn.functional.smooth_l1_loss(corners_p, corners_t, beta=0.02, reduction="none").mean(dim=(2, 3))
    w = conf_t + hidden_weight * (1 - conf_t)
    if valid_t is not None:
        w = w * valid_t
    corner_loss = (per * w).sum() / w.sum().clamp(min=1e-6)
    return conf_loss + 5.0 * corner_loss, conf_loss, corner_loss


@torch.no_grad()
def pixel_error(pred: torch.Tensor, conf_t: torch.Tensor, corners_t: torch.Tensor,
                wh=(320, 240), valid_t: torch.Tensor | None = None):
    """Mean corner error in pixels at `wh`, over ground-truth-visible faces."""
    corners_p = pred[:, :, 1:].view(-1, 6, 4, 2)
    scale = torch.tensor(wh, dtype=pred.dtype, device=pred.device)
    d = ((corners_p - corners_t) * scale).norm(dim=-1).mean(dim=-1)  # (B,6)
    mask = conf_t > 0.5
    if valid_t is not None:
        mask = mask & (valid_t > 0.5)
    return d[mask].mean().item() if mask.any() else float("nan")


@torch.no_grad()
def conf_accuracy(pred: torch.Tensor, conf_t: torch.Tensor):
    return ((pred[:, :, 0] > 0) == (conf_t > 0.5)).float().mean().item()
