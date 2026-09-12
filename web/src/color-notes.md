# Color classification: relative, not absolute (design notes)

User idea (2026-09-11), sparked by a dead-on webcam frame where the model
confidently read a face center as orange under warm monitor light in a dark
room — plausibly red, genuinely ambiguous in isolation:

> When scanning the whole cube we see every color. Two patches that both
> look red/orange can be told apart by comparing them *to each other* (and
> to the rest), rather than deciding each one absolutely. Might require a
> rearchitecture.

## Where the current pipeline already agrees

M1's classifier is already relative in one sense: rolling k-means over
observed samples in Lab, centroids seeded from the six center stickers,
with exposure normalization (see M1 exit evidence in MILESTONES.md). It
does not hardcode "red = this RGB"; it separates whatever six clusters this
cube shows under this light. That's why the kitchen-light scan went 54/54.

The monitor-cast fixture (43/54, `…2942492`) shows what's still missing:
under a strong cast the *clusters themselves* smear together, and
independent per-sticker nearest-centroid votes break the tie wrong.

## The sharper version of the idea, in implementable pieces

1. **Same-frame comparisons are the gold standard.** Patches in one frame
   share exposure, white balance, and illuminant; their *differences* are
   pigment. Absolute Lab values across frames are polluted by auto-exposure
   and AWB drift. So prefer classifying a sticker against exemplars from
   the *same frame* whenever possible.

2. **Center stickers are free labeled exemplars.** Face identity comes from
   centers anyway, so every frame containing a center is a supervised
   sample: "this is what THIS cube's red looks like under THIS light."
   Classify non-center stickers by distance to same-frame (or temporally
   nearest) center samples instead of global centroids. This is the direct
   implementation of "compare the two colors": an ambiguous patch is called
   red not because it's near absolute red but because it's nearer the red
   center's current appearance than the orange center's.

   **Partly landed 2026-09-12** (`web/src/detect/identify.ts`, the
   anonymous-quad head): face identity is no longer a model output, it is a
   center-color lookup. `CenterExemplars` starts from the default scheme
   and, once a face has been seam-verified, replaces that face's exemplar
   with the running median of its observed centers — so naming compares a
   center against what THIS cube's centers look like under THIS light, which
   is item 2 for the *center* stickers. What is still missing is item 2 for
   the other 48: `assembleState` still clusters globally rather than
   classifying each sticker against same-frame center exemplars.

3. **The 9-per-color constraint turns classification into assignment.** A
   finished cube has exactly 9 stickers of each color. Instead of 54
   independent argmins, the lock step should solve a constrained
   assignment: maximize total vote likelihood subject to 9 per color
   (greedy by confidence margin is probably enough; Hungarian if not),
   with cubejs validation as the final arbiter. Then "looks red, but red
   already has 9 confident members" resolves to orange automatically —
   exactly the pairwise-comparison intuition, enforced globally. This also
   attacks the known white-vs-blue monitor-light limit.

4. **Pairwise axes for the two hard pairs.** For red/orange and
   white/yellow, the discriminant that survives lighting changes is the
   *direction* between the two cluster centers under the current
   illuminant. Projecting ambiguous samples onto that axis and comparing
   them to each other is a cheap, robust tiebreak.

## How big a rearchitecture?

Smaller than feared. Sampling (color.ts) and per-sticker vote histograms
(state.ts) stay. Changes: (a) tag samples with frame id so same-frame
center exemplars are usable; (b) replace the independent per-sticker lock
with the constrained assignment step in state.ts's lock path. Both are
contained; the pipeline contract in CLAUDE.md is unchanged. The detector
milestones (M4-M6) are unaffected — this lands with the M6 wiring or as a
follow-up, test-first against the monitor-cast fixture (target: 43/54 →
54/54 or graceful low-confidence, never a wrong lock).
