// The algs sheet's content: what is worth memorising on the other puzzles.
// Researched 2026-09-20 from cubingcheatsheet.com (2x2-6x6), jperm.net,
// speedcubedb.com, the speedsolving wiki, sarah.cubing.net (skewb, 5x5 L2E)
// and Ben Streeter's FTO document. Every cube alg is run on the n×n model
// by test/algs.test.ts and must do what its `check` claims; the Pyraminx,
// Skewb and FTO algs were run once through cubing.js (2026-09-20) and the
// notes describe what that run showed, not what a source claimed. Notation
// is WCA throughout (Rw wide, 2R one inner layer, 3Rw three layers) even
// where a source wrote lowercase, because lowercase means two different
// things on two different sites. Colours follow the trainer: white down,
// yellow on top.

import type { Puzzle } from './types';

const SS = 'https://www.speedsolving.com/wiki/index.php/';
const CCS = 'https://cubingcheatsheet.com/';
const SCDB = 'https://www.speedcubedb.com/a/';

const p222: Puzzle = {
  id: '222', name: '2x2', n: 2, viewer: '2x2x2',
  notation: 'Face turns only: <code>R U F L B D</code>, a prime anticlockwise, <code>2</code> a half turn. There are no slices, and a wide turn is just a rotation. Held like the trainer: the first face (white) down, so the last layer is yellow.',
  intro: '<b>Ortega</b>: a white <i>face</i> by hand (a face, not a layer: the side colours need not match), one of seven OLLs to get yellow on top, then one of five PBLs that fixes both layers at once. Twelve algs, and the OLLs are the 3x3\'s OCLLs by name. Later, if wanted: <b>CLL</b> (42 algs, one for the whole last layer after a proper first layer; nine of them are these) and <b>EG</b> (128, the bottom layer\'s permutation folded in).',
  sections: [
    {
      title: 'OLL: yellow on top',
      blurb: 'Same seven cases and names as the OCLL drill; these are the short 2x2 versions, which need not keep any edges.',
      cases: [
        { name: 'Sune', alg: "R U R' U R U2 R'", note: 'One corner has yellow on top. Turn the top so it sits front-left: the front face then shows yellow at its top-right.', pic: 'top', check: { top: true }, source: `${SS}OLL_(2x2x2)` },
        { name: 'Anti-Sune', alg: "R U2 R' U' R U' R'", note: 'One corner has yellow on top. Turn the top so it sits front-left: the front face shows no yellow; the yellow sits at the front end of the right face.', pic: 'top', check: { top: true }, source: `${SS}OLL_(2x2x2)` },
        { name: 'H', alg: 'R2 U2 R U2 R2', note: 'No corner oriented, yellow headlights on two opposite sides.', pic: 'top', check: { top: true }, source: `${CCS}algs2x.html` },
        { name: 'Pi', alg: "F R U R' U' R U R' U' F'", alt: ["R U2 R2 U' R2 U' R2 U2 R"], note: 'No corner oriented, yellow headlights on one side only. Hold them on the left.', pic: 'top', check: { top: true }, source: `${CCS}algs2x.html` },
        { name: 'U (headlights)', alg: "F R U R' U' F'", note: 'Two corners oriented, the other two show yellow headlights on the side they share. Hold the headlights at the back.', pic: 'top', check: { top: true }, source: `${CCS}algs2x.html` },
        { name: 'T', alg: "R U R' U' R' F R F'", note: 'Two adjacent corners oriented; face the other two: their yellows point left and right.', pic: 'top', check: { top: true }, source: `${CCS}algs2x.html` },
        { name: 'L (bowtie)', alg: "F R U' R' U' R U R' F'", note: 'Two diagonal corners oriented.', pic: 'top', check: { top: true }, source: `${CCS}algs2x.html` },
      ],
    },
    {
      title: 'PBL: both layers at once',
      blurb: 'Count the bars (two neighbouring corners whose shared side matches) on each layer: four bars is solved, one bar is an adjacent swap, none is a diagonal swap. The pictures show the whole cube but its bottom face.',
      cases: [
        { name: 'Adjacent swap on top (T perm)', alg: "R U R' U' R' F R2 U' R' U' R U R' F'", note: 'Bottom solved, one bar on top. Hold the bar on the left; the two right corners swap.', pic: 'top2', check: { top: true }, source: `${SS}PBL` },
        { name: 'Diagonal swap on top (Y perm)', alg: "F R U' R' U' R U R' F' R U R' U' R' F R F'", note: 'Bottom solved, no bar on top: the front-right and back-left corners swap.', pic: 'top2', check: { top: true }, source: `${SS}PBL` },
        { name: 'Adjacent swaps on both layers', alg: "R2 U' B2 U2 R2 U' R2", note: 'One bar on each layer. Hold both bars at the front: the two back corners swap on each layer.', pic: 'top2', check: {}, source: `${SS}PBL` },
        { name: 'Diagonal swaps on both layers', alg: 'R2 F2 R2', note: 'No bar on either layer. Three moves; any hold works.', pic: 'top2', check: {}, source: `${SS}PBL` },
        { name: 'Adjacent on top, diagonal below', alg: "R U' R F2 R' U R'", note: 'One bar on top, none below. Hold the top bar at the front: the back corners swap on top, a diagonal below.', pic: 'top2', check: {}, source: `${CCS}algs2x.html` },
        { name: 'Diagonal on top, adjacent below', alg: "L D' L F2 L' D L'", note: 'No bar on top, one below. Hold the bottom bar at the front; or turn the cube over and use the case above.', pic: 'top2', check: {}, source: `${CCS}algs2x.html` },
      ],
    },
  ],
};

const p444: Puzzle = {
  id: '444', name: '4x4', n: 4, viewer: '4x4x4',
  notation: 'WCA big-cube notation: <code>Rw</code> turns the two right layers together, <code>2R</code> the second layer from the right alone, <code>Uw2</code> and <code>2R2</code> likewise, <code>x</code> rotates the cube. Beware other sites: lowercase <code>r</code> means <code>Rw</code> on some and <code>2R</code> on others, and a few write the inner slice as <code>Rw</code>. Every alg here is spelled out and was run on a model. Held like the trainer: white down, yellow on top.',
  intro: '<b>Reduction</b>: centres, then every edge paired, then a 3x3 solve. The memorised part is small: one commutator for the last two centres, one flip for pairing edges, and the two parities the 3x3 never has: an edge that is flipped after OLL, and two edges swapped after PLL. When both happen, fix OLL parity first.',
  sections: [
    {
      title: 'Last two centres',
      blurb: 'With four centres done, the last two are on top and in front. The commutator moves one piece between them and nothing else.',
      cases: [
        { name: 'Centre commutator', alg: "2L' U 2R U' 2L U 2R' U'", alt: ["[2R, U 2L' U']"], note: 'Swaps one centre piece between the top and the front: the front\'s top-right piece goes up, the top\'s back-left piece comes down. The usual spelling drops the last U\' and leaves the top layer a quarter turn round, which does not matter yet.', pic: 'iso', check: { only: ['centre'] }, source: `${CCS}algs4x.html` },
      ],
    },
    {
      title: 'Pairing edges',
      blurb: 'Slice a wing next to its partner, flip the pair out of the slice, slice back. The flip disturbs the top layer and one bottom corner, which does not matter until the 3x3 stage.',
      cases: [
        { name: 'Flip the front-right edge', alg: "R U R' F R' F' R", note: 'Flips the front-right edge in place (both wings), shuffling the top layer and the front-right-bottom corner. This alone never fixes OLL parity.', pic: 'iso', check: { only: ['edge', 'corner'] }, source: 'https://jperm.net/4x4' },
        { name: 'Slice, flip, slice back', alg: "Uw' R U R' F R' F' R Uw", note: 'For the last two edges: the wing at the top of the front-left edge and the one at the bottom of the front-right edge change places. The slice brings them together, the flip fixes the pair, the slice back restores the centres.', pic: 'iso', check: { only: ['edge', 'corner'] }, source: 'https://ruwix.com/twisty-puzzles/4x4x4-rubiks-cube-rubiks-revenge/parity/' },
      ],
    },
    {
      title: 'OLL parity',
      blurb: 'After the cross, one edge is flipped and no 3x3 alg can fix it. Hold it at the front of the top layer.',
      cases: [
        { name: 'Flip the front edge', alg: "Rw U2 x Rw U2 Rw U2 Rw' U2 Lw U2 Rw' U2 Rw U2 Rw' U2 Rw'", alt: ["Rw2 B2 U2 Lw U2 Rw' U2 Rw U2 F2 Rw F2 Lw' B2 Rw2"], note: 'The one everybody knows. It turns the whole front bar of the top layer over (both wings and the two corners) and swaps the left and right edges: fine at OLL, wrong any later. The second alg does exactly the same.', pic: 'top', check: { only: ['edge', 'corner'], top: true }, source: 'https://jperm.net/4x4' },
        { name: 'Flip the front edge, nothing else', alg: "2R' U2 2L F2 2L' F2 2R2 U2 2R U2 2R' U2 F2 2R2 F2", alt: ["2R2 B2 U2 2L U2 2R' U2 2R U2 F2 2R F2 2L' B2 2R2"], note: 'Both wings of the front edge flip and nothing else moves, so it can be done at any point after the edges are paired, and the same alg works on the 5x5. Fifteen moves, inner slices only.', pic: 'top', check: { only: ['edge'], top: true }, source: `${SCDB}4x4/OLLParity` },
      ],
    },
    {
      title: 'PLL parity',
      blurb: 'Corners done, two edges swapped: a PLL the 3x3 cannot have (a solved bar where headlights should be, or two edges across from each other). Swap them, then do the PLL you are left with.',
      cases: [
        { name: 'Opposite edges swapped', alg: '2R2 U2 2R2 Uw2 2R2 2U2', note: 'Swaps the front and back edges of the top layer; nothing else moves. Looks like half an H perm. The common spelling ends in Uw2 instead of 2U2 and leaves the top layer a half turn round, so it needs a U2 after.', pic: 'top', check: { only: ['edge'], top: true }, source: 'https://jperm.net/4x4' },
        { name: 'Adjacent edges swapped', alg: "R' U R U' 2R2 U2 2R2 Uw2 2R2 Uw2 U' R' U' R", note: 'Swaps the front and right edges of the top layer: the same alg with a setup that brings the pair opposite. Looks like half a Z perm.', pic: 'top', check: { only: ['edge'], top: true }, source: `${SCDB}4x4/PLLParity` },
      ],
    },
  ],
};

const p555: Puzzle = {
  id: '555', name: '5x5', n: 5, viewer: '5x5x5',
  notation: 'As the 4x4, plus <code>3Rw</code> for three layers and <code>3R</code> for the middle slice alone. Each edge is a middle piece with a wing on each side; the wings live in the second slices (<code>2R</code>, <code>2L</code>), which is why the edge algs are written with those. Held with white down, yellow on top, the two edges to fix at the front and back of the top layer.',
  intro: 'Reduction again. The fixed centres mean there is no OLL or PLL parity, but the last two edges can be left with two wings crossed, which needs the 4x4\'s pure flip, and the other last-two-edges cases are short inner-slice algs. Centres use the 4x4 commutator unchanged; the plus-shaped pieces go in with wide moves by hand.',
  sections: [
    {
      title: 'Last two centres',
      cases: [
        { name: 'Centre commutator', alg: "2L' U 2R U' 2L U 2R' U'", alt: ["[2R, U 2L' U']"], note: 'The 4x4 alg unchanged: swaps one corner-of-centre piece between the top and the front and moves nothing else.', pic: 'iso', check: { only: ['centre'] }, source: `${CCS}algs5x.html` },
      ],
    },
    {
      title: 'Last two edges',
      blurb: 'Hold the two unfinished edges at the front and back of the top layer. Every alg here moves only wings of those two edges; the pictures show which.',
      cases: [
        { name: 'One edge with its wings crossed (the 5x5 parity)', alg: "2R' U2 2L F2 2L' F2 2R2 U2 2R U2 2R' U2 F2 2R2 F2", alt: ["2R U2 2R U2 2R' U2 2R U2 2L' U2 2L F2 2R' F2 2R' U2 2R'"], note: 'The front edge\'s two wings show their colours the wrong way round and nothing else is wrong. This is the 4x4 pure flip; the second alg is the same case from the 5x5 tables.', pic: 'top', check: { only: ['edge'], top: true }, source: `${SCDB}4x4/OLLParity` },
        { name: 'The same, the way most people do it', alg: "Rw U2 x Rw U2 Rw U2 3Rw' U2 Lw U2 Rw' U2 Rw U2 Rw' U2 Rw'", note: 'The 4x4 OLL parity with its middle move deepened to 3Rw\' so the centre slice is spared. Like on the 4x4 it turns the whole front bar over (corners included) and swaps the left and right edges, so do it before the 3x3 stage.', pic: 'top', check: { only: ['edge', 'corner'], top: true }, source: 'https://jperm.net/5x5' },
        { name: 'Two wings swapped, same side', alg: "2L' U2 2L' U2 F2 2L' F2 2R U2 2R' U2 2L2", note: 'The right-hand wing of the front edge and the right-hand wing of the back edge change places, each turned over. Twelve moves.', pic: 'top', check: { only: ['edge'], top: true }, source: `${CCS}algs5x.html` },
        { name: 'All four wings', alg: "2R' U2 2R2 U2 2R U2 2R' U2 2R U2 2R2 U2 2R'", alt: ["2R U2 2R2 U2 2R' U2 2R U2 2R' U2 2R2 U2 2R"], note: 'Every wing of both edges is wrong: each edge has one of its own wings in its other slot and one wing from the opposite edge, all four showing their colours the wrong way round. The second alg is the mirror case.', pic: 'top', check: { only: ['edge'], top: true }, source: `${CCS}algs5x.html` },
      ],
    },
  ],
};

const pyra: Puzzle = {
  id: 'pyra', name: 'Pyraminx', viewer: 'pyraminx',
  notation: 'WCA: the bottom face flat, one face toward you. <code>U L R B</code> turn the two layers at that vertex (<code>U</code> the top, <code>L</code> and <code>R</code> the two front-bottom vertices, <code>B</code> the back one), 120° clockwise looking at the vertex; a prime is anticlockwise. Lowercase <code>u l r b</code> turn just the tip, which never moves anything else. Edges are named by their two vertices: UL, UR and UB sit around the top, LR is the front-bottom edge, LB and RB the two at the back.',
  intro: 'No parity, and only six edges to think about. Tips and the four centres are intuitive: turn each vertex until its three centre stickers match, tips last. The layer-by-layer way: three bottom edges by hand, then one of five algs for the three around the top. The faster way is a V (two bottom edges) and the last four edges in one look. These algs were checked by simulation on 2026-09-20; the notes say what moved.',
  sections: [
    {
      title: 'Last layer: the three edges around the top',
      blurb: 'The three top edges are always in place or 3-cycled, with zero or two of them flipped. A flipped edge has the right two colours for its slot, the wrong way round.',
      cases: [
        { name: 'Cycle clockwise', alg: "R' U' R U' R' U' R", note: 'The three top edges each move one place clockwise seen from the top; no flips.', source: `${SS}Pyraminx_algorithms` },
        { name: 'Cycle anticlockwise', alg: "R' U R U R' U R", note: 'The three top edges each move one place anticlockwise; no flips.', source: `${SS}Pyraminx_algorithms` },
        { name: 'Flip two', alg: "R' L R L' U L' U' L", note: 'Flips the two front top edges (UL and UR) in place; the back one is untouched.', source: `${SS}Pyraminx_algorithms` },
        { name: 'Cycle clockwise with flips', alg: "L U R U' R' L'", note: 'The clockwise cycle, and the pieces landing at the front-left and the back come in flipped.', source: `${SS}Pyraminx_algorithms` },
        { name: 'Cycle anticlockwise with flips', alg: "R' U' L' U L R", note: 'The anticlockwise cycle, and the pieces landing at the front-right and the back come in flipped.', source: `${SS}Pyraminx_algorithms` },
      ],
    },
    {
      title: 'Last four edges: sledge and hedge',
      blurb: 'With the two back-bottom edges solved, the front-bottom edge and the three top ones are left. The 4-movers cycle the front-bottom edge with the two front top ones.',
      cases: [
        { name: 'Sledgehammer', alg: "R' L R L'", note: 'The front-bottom edge goes up to the front-left slot and flips, the front-left one goes across to the front-right and flips, the front-right one goes down to the bottom as it is.', source: `${SS}Pyraminx_algorithms` },
        { name: 'Hedgeslammer', alg: "L R' L' R", note: 'The mirror: the front-bottom edge goes up to the front-right slot as it is, the front-right one goes across to the front-left and flips, the front-left one goes down and flips.', source: `${SS}Pyraminx_algorithms` },
        { name: 'Cycle with the bottom, clockwise', alg: "R' L R L U L U'", note: 'The front-bottom edge goes up to the front-right slot and flips, the front-right one across to the front-left and flips, the front-left one down as it is.', source: `${SS}Pyraminx_algorithms` },
        { name: 'Cycle with the bottom, anticlockwise', alg: "L R' L' R' U' R' U", note: 'The front-bottom edge goes up to the front-left slot as it is, the front-left one across to the front-right and flips, the front-right one down and flips.', source: `${SS}Pyraminx_algorithms` },
      ],
    },
  ],
};

const skewb: Puzzle = {
  id: 'skewb', name: 'Skewb', viewer: 'skewb',
  notation: 'WCA: three faces in view, the top face on top, so the front-top-right corner points at you and never moves. Each letter turns the half of the puzzle around one corner, 120° clockwise looking at that corner: <code>R</code> the back-bottom-right corner, <code>L</code> the front-bottom-left, <code>U</code> the back-top-left, <code>B</code> the back-bottom-left (the one you cannot see). A prime is anticlockwise. Sarah Strong writes her algs in her own three-letter notation; these are the WCA letters scrambles use, with the effects checked by simulation on 2026-09-20.',
  intro: '<b>Sarah\'s method</b>: one face by hand, then the last four corners, then the centres. Everything is built from the sledgehammer and the hedgeslammer: a single one swaps two pairs of centres and twists four corners, two in a row twist corners and leave the centres, and eight moves is the length of every pure alg. Centres only ever move in 3-cycles or in two swaps at once.',
  sections: [
    {
      title: 'The two moves everything is built from',
      cases: [
        { name: 'Sledgehammer', alg: "R' B R B'", note: 'Swaps the right and left centres and the bottom and back centres, and twists the four bottom corners: the front pair one way, the back pair the other.', source: 'https://sarah.cubing.net/skewb/my-method' },
        { name: 'Hedgeslammer', alg: "B' R B R'", note: 'The same two centre swaps, twisting the four back corners instead: the top pair one way, the bottom pair the other.', source: 'https://sarah.cubing.net/skewb/my-method' },
      ],
    },
    {
      title: 'Corners without touching the centres',
      blurb: 'Once the first face is done, hold it on top: the last four corners are the bottom ones.',
      cases: [
        { name: 'Double sledge', alg: "R' B R B' R' B R B'", note: 'Twists all four bottom corners and leaves every centre where it was: the two front-bottom corners one way, the two back-bottom corners the other. Done twice it undoes itself.', source: 'https://sarah.cubing.net/skewb/my-method' },
      ],
    },
    {
      title: 'Centres without touching the corners',
      blurb: 'Every centre case is one 3-cycle or two swaps, so at most two of these finish the puzzle.',
      cases: [
        { name: 'Centre 3-cycle', alg: "L' R' U B L' B' L R", note: 'The left centre goes to the top, the top centre to the right, the right centre to the left. Corners stay.' },
        { name: 'Two swaps, adjacent pairs', alg: "R L U' B' L' U' B U", note: 'Swaps the front and top centres, and the right and bottom centres. Corners stay.' },
        { name: 'Two swaps, one pair opposite', alg: "R U L U L' U' R' U'", note: 'Swaps the right and left centres, and the top and back centres. Corners stay.' },
      ],
    },
  ],
};

const fto: Puzzle = {
  id: 'fto', name: 'FTO', viewer: 'fto',
  notation: 'Ben Streeter\'s notation, which twizzle uses: hold the octahedron with a corner pointing at you. The four faces around that corner are <code>U</code> (upper), <code>F</code> (lower), <code>L</code> and <code>R</code>; the four at the back are <code>B</code> (behind F), <code>D</code> (behind U), <code>BL</code> and <code>BR</code>. A letter turns that face 120° clockwise looking at it, a prime anticlockwise. Standard colours: white on U, green on F. A triple is a corner with the two triangles on either side of it.',
  intro: '<b>Bencisco</b> (Ben Streeter\'s method) is the standard: a block, the first centre, two triples, the second centre, the last two centres, then the last bottom triple and the last three triples. Everything but the end is intuitive; the memorised part is four algs. Edges have no orientation and ride along with the triangles. Checked by simulation on 2026-09-20.',
  sections: [
    {
      title: 'Triples: sledge and hedge',
      blurb: 'Both cycle the three triples around the U face, one each way, and flip the two triangles that the R layer shares with them.',
      cases: [
        { name: 'Sledge (clockwise)', alg: "R' L R L'", alt: ["F' U F U'"], note: 'The three corners of the U face cycle clockwise with their triangles: the front corner\'s triple goes to the right-top vertex, that one to the left-top, the left-top one to the front. The alternative does the same from the F face.', source: 'https://docs.google.com/document/d/e/2PACX-1vTDL7-XvpNrhIc2Q_1nHfeJyG7tIazgBCq88PE8ahqIbvPb3LPQsM3_vsdqX6y8sxte1n5jGk2J3c5V/pub' },
        { name: 'Hedge (anticlockwise)', alg: "R B' R' B", note: 'The same three triples the other way round.', source: 'https://docs.google.com/document/d/e/2PACX-1vTDL7-XvpNrhIc2Q_1nHfeJyG7tIazgBCq88PE8ahqIbvPb3LPQsM3_vsdqX6y8sxte1n5jGk2J3c5V/pub' },
      ],
    },
    {
      title: 'Last three triples: the corner cycle',
      blurb: 'After the triangles are placed with sledges and hedges, the three corners of the R face may still need cycling. Both algs carry three triangles round with the corners.',
      cases: [
        { name: 'Corners clockwise', alg: "F' U F' D' F U' F' D F'", note: 'Cycles the three corners of the R face (front, right-top, right-bottom) clockwise, each with one triangle.', source: 'https://docs.google.com/document/d/e/2PACX-1vTDL7-XvpNrhIc2Q_1nHfeJyG7tIazgBCq88PE8ahqIbvPb3LPQsM3_vsdqX6y8sxte1n5jGk2J3c5V/pub' },
        { name: 'Corners anticlockwise', alg: "F D' F U F' D F U' F", note: 'The inverse: the same three corners the other way.', source: 'https://docs.google.com/document/d/e/2PACX-1vTDL7-XvpNrhIc2Q_1nHfeJyG7tIazgBCq88PE8ahqIbvPb3LPQsM3_vsdqX6y8sxte1n5jGk2J3c5V/pub' },
      ],
    },
    {
      title: 'Last bottom triple',
      blurb: 'Ninety-odd cases, most of them a setup move, a sledge and the setup undone. One to show the shape; the full table is at zwegner.github.io/cubing/fto/lbt-algs.html.',
      cases: [
        { name: 'Keyhole insert', alg: "BL R' L' R L BL'", note: 'A BL setup, a sledge from the left, and the setup undone: cycles the U face\'s three triples with a different pair of triangles than the plain sledge.', source: 'https://zwegner.github.io/cubing/fto/lbt-algs.html' },
      ],
    },
  ],
};

export const PUZZLES: Puzzle[] = [p222, p444, p555, pyra, skewb, fto];
