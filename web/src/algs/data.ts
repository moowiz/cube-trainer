// The algs sheet's content: Roux on the 3x3 (CMLL from speedcubedb, the LSE
// algs found by search on the model) and what is worth memorising on the
// other puzzles. Researched 2026-09-20 from cubingcheatsheet.com (2x2-6x6), jperm.net,
// speedcubedb.com, the speedsolving wiki, sarah.cubing.net (skewb, 5x5 L2E)
// and Ben Streeter's FTO document. Every cube alg is run on the n×n model
// by test/algs.test.ts and must do what its `check` claims, and so is every
// FTO alg (cube/fto.ts, itself checked against cubing.js and lowcubes);
// the Pyraminx and Skewb algs were run once through cubing.js (2026-09-20)
// and the notes describe what that run showed, not what a source claimed. Notation
// is WCA throughout (Rw wide, 2R one inner layer, 3Rw three layers) even
// where a source wrote lowercase, because lowercase means two different
// things on two different sites. Colours follow the trainer: white down,
// yellow on top.

import type { FtoFace } from '../cube/fto';
import type { Puzzle } from './types';

const SS = 'https://www.speedsolving.com/wiki/index.php/';
const CCS = 'https://cubingcheatsheet.com/';
const SCDB = 'https://www.speedcubedb.com/a/';

const CMLL = `${SCDB}3x3/CMLL`;
// Found by search on the n×n model (2026-09-28): the shortest M and U sequence with the blocks kept, the corners back
// where they were and the middle-slice centres home, so each is the whole alg with its AUF and no centre fix owed.
const SEARCH = 'https://github.com/moowiz/cube-trainer/blob/main/web/src/algs/data.ts';
const roux: Puzzle = {
  id: '333', name: 'Roux', n: 3, viewer: '3x3x3',
  notation: 'Face turns as usual. <code>M</code> is the middle slice between the two blocks, turned the way <code>L</code> turns (so <code>M\'</code> brings the front edge up); <code>r</code> is the right face and that slice together (<code>Rw</code>), so <code>r U r\'</code> is <code>R U R\'</code> with the slice along. Held with the blocks on the left and right: the first block\'s centre is on the left, the top colour is whatever the corners show, since the middle slice is free until the end. Every alg here was run on the cube model and keeps both blocks.',
  intro: '<b>Roux</b>: a 1x2x3 block on the left (a centre, the edge below it and the two corner-edge pairs either side), the same on the right, then <b>CMLL</b> (the four top corners in one alg, the edges ignored: 42 cases, the same seven orientations as the OCLL drill), then <b>LSE</b>, the last six edges with only <code>M</code> and <code>U</code>: orient them, put the left and right top edges in, and finish the middle slice. Nothing but CMLL is memorised; LSE\'s algs below are for reference and for the cases you get stuck on.',
  sections: [
    {
      title: 'The method, step by step',
      steps: [
        '<b>First block.</b> Pick a centre for the left. Pair its bottom edge with the centre, then build the two corner-edge pairs on either side (a corner in the bottom layer with the edge above it) and slot them in. Anything goes: the cube is free, so turn whatever is quickest.',
        '<b>Second block.</b> The same 1x2x3 on the right, with <code>R</code>, <code>r</code>, <code>M</code> and <code>U</code> so the first block never moves. Build each pair in the top layer or with the middle slice, then <code>R U R\'</code> it home.',
        '<b>CMLL.</b> Look at the four top corners only. Their orientation is one of the seven OCLL shapes (the top-colour stickers), and within a shape the six permutations are told apart by which side stickers match: a <i>bar</i> is two matching side stickers next to each other, a pair of <i>opposites</i> is two stickers of opposite colours. One alg, from the tables below.',
        '<b>LSE 4a: orient the six edges.</b> An edge is right when its top-or-bottom colour faces up or down. Count the wrong ones on top and below, hold them as the picture shows (a <code>U</code> turn is free, so is turning the cube over), and do the alg. Every alg is <code>M</code> and <code>U</code> turns alternating; the arrow, the commonest, is three of them and an AUF.',
        '<b>LSE 4b: the left and right top edges.</b> Bring the two edges that belong beside the left and right centres into the top layer and put them there with <code>U</code> and <code>M</code> turns (<code>M2</code> swaps the front top edge with the back bottom one). When they sit across from each other on top, turn them to the left and right places; when they are together, <code>M2</code> after a <code>U</code> or two separates them.',
        '<b>LSE 4c: the last four.</b> Turn the middle slice until its centres match the left and right blocks (top colour up), then it is one of the eleven cases below, all of them <code>M2</code> and <code>U2</code>.',
      ],
      cases: [],
    },
    {
      title: 'CMLL: all four up',
      blurb: 'All four corners have the top colour up: only their order is wrong. Two cases, and both are 3x3 PLLs in disguise (a T perm and a Y perm), because a corner swap that keeps the blocks must move top edges too.',
      cases: [
        { name: 'O Adjacent', alg: "R U R' F' R U R' U' R' F R2 U' R'", alt: ["R U R' U' R' F R2 U' R' U' R U R' F' U"], note: 'Same colour: front-left and right-back; front-right and back-right; right-front and back-left; left-back and left-front.', pic: 'top', dim: ['edge', 'centre'], check: { blocks: true }, source: CMLL },
        { name: 'O Diagonal', alg: "F R U' R' U' R U R' F' R U R' U' R' F R F'", alt: ["R U' R2 F R F' R U' B U2 B' R' U'"], note: 'Same colour: front-left and back-left; front-right and back-right; right-front and left-front; right-back and left-back.', pic: 'top', dim: ['edge', 'centre'], check: { blocks: true }, source: CMLL },
      ],
    },
    {
      title: 'CMLL: H',
      blurb: 'No corner has the top colour up, and the four top-colour stickers make two pairs, one on the front and one on the back.',
      cases: [
        { name: 'H Columns', alg: "U R U R' U R U' R' U R U2 R'", alt: ["R U2 R' U' R U R' U' R U' R' U"], note: 'Top colour at front-left, front-right, back-right and back-left. Same colour: right-front and left-front; right-back and left-back.', pic: 'top', dim: ['edge', 'centre'], check: { blocks: true }, source: CMLL },
        { name: 'H Rows', alg: "F R U R' U' R U R' U' R U R' U' F'", alt: ["F U R U' R' U R U' R' U R U' R' F'"], note: 'Top colour at front-left, front-right, back-right and back-left. Same colour: right-front and right-back; left-back and left-front.', pic: 'top', dim: ['edge', 'centre'], check: { blocks: true }, source: CMLL },
        { name: 'H Column', alg: "R' F2 D R2 U R2 D' F2 R", alt: ["U R U2 R2 F R F' U2 R' F R F' U2"], note: 'Top colour at front-left, front-right, back-right and back-left. Same colour: left-back and left-front. Opposite colours: right-front and right-back.', pic: 'top', dim: ['edge', 'centre'], check: { blocks: true }, source: CMLL },
        { name: 'H Row', alg: "U2 r U' r2 D' r U' r' D r2 U r'", alt: ["U' R U R' U R U r' F R' F' r U"], note: 'Top colour at front-left, front-right, back-right and back-left. Same colour: right-back and left-back. Opposite colours: right-front and left-front.', pic: 'top', dim: ['edge', 'centre'], check: { blocks: true }, source: CMLL },
      ],
    },
    {
      title: 'CMLL: Pi',
      blurb: 'No corner up; two top-colour stickers make a pair on the left, the other two sit at front-right and back-left.',
      cases: [
        { name: 'Pi Right Bar', alg: "F R U R' U' R U R' U' F'", alt: ["r' U r2 U' r2 U' r2 U r' U2"], note: 'Top colour at front-right, back-right, left-back and left-front. Same colour: front-left and back-left. Opposite colours: right-front and right-back.', pic: 'top', dim: ['edge', 'centre'], check: { blocks: true }, source: CMLL },
        { name: 'Pi Down Slash', alg: "U F R' F' R U2 R U' R' U R U2 R'", alt: ["U F U R U' R2 F' R U2 R U2 R'"], note: 'Top colour at front-right, back-right, left-back and left-front. Same colour: front-left and right-back. Opposite colours: right-front and back-left.', pic: 'top', dim: ['edge', 'centre'], check: { blocks: true }, source: CMLL },
        { name: 'Pi X', alg: "R' F2 D R2 U' R2 D' F2 R", alt: ["U' R' F R U F U' R U R' U' F' U'"], note: 'Top colour at front-right, back-right, left-back and left-front. Same colour: front-left and back-left; right-front and right-back.', pic: 'top', dim: ['edge', 'centre'], check: { blocks: true }, source: CMLL },
        { name: 'Pi Up Slash', alg: "R U2 R' U' R U R' U2 R' F R F'", alt: ["R U2 R' U2 R' F R2 U R' U' F'"], note: 'Top colour at front-right, back-right, left-back and left-front. Same colour: right-front and back-left. Opposite colours: front-left and right-back.', pic: 'top', dim: ['edge', 'centre'], check: { blocks: true }, source: CMLL },
        { name: 'Pi Columns', alg: "U' r U' r2 D' r U r' D r2 U r'", alt: ["U2 R' F R F' r U' r' U' R U' R' U'"], note: 'Top colour at front-right, back-right, left-back and left-front. Same colour: front-left and right-back; right-front and back-left.', pic: 'top', dim: ['edge', 'centre'], check: { blocks: true }, source: CMLL },
        { name: 'Pi Left Bar', alg: "U' R' U' R' F R F' R U' R' U2 R", alt: ["R' F' U' F U' R U R' U R U'"], note: 'Top colour at front-right, back-right, left-back and left-front. Same colour: right-front and right-back. Opposite colours: front-left and back-left.', pic: 'top', dim: ['edge', 'centre'], check: { blocks: true }, source: CMLL },
      ],
    },
    {
      title: 'CMLL: U',
      blurb: 'The two front corners are up; the two back corners show their top colour on the back.',
      cases: [
        { name: 'U Up Slash', alg: "U2 R2 D R' U2 R D' R' U2 R'", alt: ["U2 R r D r' U2 r D' r' U2 R'"], note: 'Top colour at back-right and back-left. Same colour: front-right and right-back; right-front and left-back. Opposite colours: front-left and right-front; front-left and left-back; front-right and left-front; right-back and left-front.', pic: 'top', dim: ['edge', 'centre'], check: { blocks: true }, source: CMLL },
        { name: 'U Down Slash', alg: "R2 D' R U2 R' D R U2 R", alt: ["R' F R U R' F R U F U2 F' U2"], note: 'Top colour at back-right and back-left. Same colour: front-left and left-back; right-back and left-front. Opposite colours: front-left and right-front; front-right and right-back; front-right and left-front; right-front and left-back.', pic: 'top', dim: ['edge', 'centre'], check: { blocks: true }, source: CMLL },
        { name: 'U Bottom Row', alg: "R' U' R U' R' U2 R2 U R' U R U2 R'", alt: ["U' R2 F2 r U r' F R2 U2 r' U' r"], note: 'Top colour at back-right and back-left. Same colour: front-left and front-right; right-back and left-back. Opposite colours: right-front and left-front.', pic: 'top', dim: ['edge', 'centre'], check: { blocks: true }, source: CMLL },
        { name: 'U Rows', alg: "U' F R2 D R' U R D' R2 U' F'", alt: ["F U R2 D R' U' R D' R2 F' U"], note: 'Top colour at back-right and back-left. Same colour: front-left and front-right; right-front and left-back; right-back and left-front.', pic: 'top', dim: ['edge', 'centre'], check: { blocks: true }, source: CMLL },
        { name: 'U X', alg: "U2 r U' r' U r' D' r U' r' D r", alt: ["F R U' R' U R U R' U R U' R' F' U2"], note: 'Top colour at back-right and back-left. Same colour: right-front and left-front; right-back and left-back. Opposite colours: front-left and front-right.', pic: 'top', dim: ['edge', 'centre'], check: { blocks: true }, source: CMLL },
        { name: 'U Upper Row', alg: "U' F R U R' U' F'", alt: ["U F U R U' R' F' U2"], note: 'Top colour at back-right and back-left. Same colour: front-left and left-back; front-right and right-back; right-front and left-front.', pic: 'top', dim: ['edge', 'centre'], check: { blocks: true }, source: CMLL },
      ],
    },
    {
      title: 'CMLL: T',
      blurb: 'The two front corners are up; the back-right corner shows its top colour on the right and the back-left one on the left.',
      cases: [
        { name: 'T Left Bar', alg: "U' R U R' U' R' F R F'", alt: ["U' r U R' U' r' F R F'"], note: 'Top colour at right-back and left-back. Same colour: front-right and back-left; right-front and back-right. Opposite colours: front-left and right-front; front-left and back-right; front-right and left-front; back-left and left-front.', pic: 'top', dim: ['edge', 'centre'], check: { blocks: true }, source: CMLL },
        { name: 'T Right Bar', alg: "U L' U' L U L F' L' F", alt: ["U r' F' r U r U' r' F"], note: 'Top colour at right-back and left-back. Same colour: front-left and back-right; back-left and left-front. Opposite colours: front-left and right-front; front-right and back-left; front-right and left-front; right-front and back-right.', pic: 'top', dim: ['edge', 'centre'], check: { blocks: true }, source: CMLL },
        { name: 'T Rows', alg: "R U2 R' U' R U' R2 U2 R U R' U R", alt: ["F R' F R2 U' R' U' R U R' F2 U"], note: 'Top colour at right-back and left-back. Same colour: front-left and front-right; right-front and back-right; back-left and left-front.', pic: 'top', dim: ['edge', 'centre'], check: { blocks: true }, source: CMLL },
        { name: 'T Bottom Row', alg: "r' U r U2 R2 F R F' R", alt: ["R U R2 F R F' U r U r'"], note: 'Top colour at right-back and left-back. Same colour: front-left and front-right; back-right and back-left. Opposite colours: right-front and left-front.', pic: 'top', dim: ['edge', 'centre'], check: { blocks: true }, source: CMLL },
        { name: 'T Top Row', alg: "r' D' r U r' D r U' r U r'", alt: ["U R' D R U' R U R' U R' D' R U'"], note: 'Top colour at right-back and left-back. Same colour: front-left and back-right; front-right and back-left; right-front and left-front.', pic: 'top', dim: ['edge', 'centre'], check: { blocks: true }, source: CMLL },
        { name: 'T Columns', alg: "U2 r U' r2 D' r U2 r' D r2 U r'", alt: ["U2 r2 D' r U r' D r2 U' r' U' r U"], note: 'Top colour at right-back and left-back. Same colour: right-front and left-front; back-right and back-left. Opposite colours: front-left and front-right.', pic: 'top', dim: ['edge', 'centre'], check: { blocks: true }, source: CMLL },
      ],
    },
    {
      title: 'CMLL: Sune',
      blurb: 'One corner up, the front-right one; the other three show their top colour at right-back, back-left and left-front, each one place round from its corner.',
      cases: [
        { name: 'S Left Bar', alg: "U R U R' U R U2 R'", alt: ["R' U2 R U R' U R U"], note: 'Top colour at right-back, back-left and left-front. Same colour: right-front and back-right. Opposite colours: front-left and right-front; front-left and back-right; front-right and left-back.', pic: 'top', dim: ['edge', 'centre'], check: { blocks: true }, source: CMLL },
        { name: 'S X', alg: "U L' U2 L U2 r U' r' F", alt: ["U r' F2 r U2 r U' r' F"], note: 'Top colour at right-back, back-left and left-front. Same colour: right-front and back-right. Opposite colours: front-left and front-right; right-front and left-back; back-right and left-back.', pic: 'top', dim: ['edge', 'centre'], check: { blocks: true }, source: CMLL },
        { name: 'S Up Slash', alg: "U F R' F' R U2 R U2 R'", note: 'Top colour at right-back, back-left and left-front. Same colour: right-front and left-back. Opposite colours: front-left and right-front; front-left and left-back; front-right and back-right.', pic: 'top', dim: ['edge', 'centre'], check: { blocks: true }, source: CMLL },
        { name: 'S Columns', alg: "U R U R' U' R' F R F' R U R' U R U2 R'", alt: ["R U R' U R U' R D R' U' R D' R2 U"], note: 'Top colour at right-back, back-left and left-front. Same colour: right-front and left-back. Opposite colours: front-left and front-right; right-front and back-right; back-right and left-back.', pic: 'top', dim: ['edge', 'centre'], check: { blocks: true }, source: CMLL },
        { name: 'S Right Bar', alg: "U' R U R' U R' F R F' R U2 R'", alt: ["U' R U R' U r' F R F' r U2 R'"], note: 'Top colour at right-back, back-left and left-front. Same colour: front-left and right-front. Opposite colours: front-left and back-right; front-right and left-back; right-front and back-right.', pic: 'top', dim: ['edge', 'centre'], check: { blocks: true }, source: CMLL },
        { name: 'S Down Slash', alg: "U r U' r' F R' F' R", alt: ["U R U' r' F R' F' r"], note: 'Top colour at right-back, back-left and left-front. Same colour: front-left and right-front. Opposite colours: front-left and left-back; front-right and back-right; right-front and left-back.', pic: 'top', dim: ['edge', 'centre'], check: { blocks: true }, source: CMLL },
      ],
    },
    {
      title: 'CMLL: Anti-Sune',
      blurb: 'One corner up, the front-left one; the other three show their top colour at right-front, back-right and left-back.',
      cases: [
        { name: 'AS Right Bar', alg: "U R' U' R U' R' U2 R", alt: ["U2 R U2 R' U' R U' R' U'"], note: 'Top colour at right-front, back-right and left-back. Same colour: back-left and left-front. Opposite colours: front-left and right-back; front-right and back-left; front-right and left-front.', pic: 'top', dim: ['edge', 'centre'], check: { blocks: true }, source: CMLL },
        { name: 'AS Columns', alg: "U2 R U R2 F' r F R U' r2 F r", alt: ["U' R2 D R' U R D' R' U R' U' R U' R' U2"], note: 'Top colour at right-front, back-right and left-back. Same colour: right-back and left-front. Opposite colours: front-left and front-right; right-back and back-left; back-left and left-front.', pic: 'top', dim: ['edge', 'centre'], check: { blocks: true }, source: CMLL },
        { name: 'AS Down Slash', alg: "U' F' L F L' U2 L' U2 L", alt: ["U' F' r U r' U2 r' F2 r"], note: 'Top colour at right-front, back-right and left-back. Same colour: right-back and left-front. Opposite colours: front-left and back-left; front-right and right-back; front-right and left-front.', pic: 'top', dim: ['edge', 'centre'], check: { blocks: true }, source: CMLL },
        { name: 'AS X', alg: "U' R U2 R' U2 R' F R F'", alt: ["U' R U2 R' U2 r' F R F' M'"], note: 'Top colour at right-front, back-right and left-back. Same colour: back-left and left-front. Opposite colours: front-left and front-right; right-back and back-left; right-back and left-front.', pic: 'top', dim: ['edge', 'centre'], check: { blocks: true }, source: CMLL },
        { name: 'AS Up Slash', alg: "U' R' F R F' r U r'", alt: ["U' r' F R F' r U R'"], note: 'Top colour at right-front, back-right and left-back. Same colour: front-right and left-front. Opposite colours: front-left and back-left; front-right and right-back; right-back and left-front.', pic: 'top', dim: ['edge', 'centre'], check: { blocks: true }, source: CMLL },
        { name: 'AS Left Bar', alg: "U R U2 R' F R' F' R U' R U' R'", alt: ["R' U' R U' R' U R' F R F' U R U"], note: 'Top colour at right-front, back-right and left-back. Same colour: front-right and left-front. Opposite colours: front-left and right-back; front-right and back-left; back-left and left-front.', pic: 'top', dim: ['edge', 'centre'], check: { blocks: true }, source: CMLL },
      ],
    },
    {
      title: 'CMLL: L',
      blurb: 'Two corners up on a diagonal, back-left and front-right; the other two show their top colour at back-right and left-front.',
      cases: [
        { name: 'L Best', alg: "U' F' r U r' U' r' F r", alt: ["U2 F R U' R' U' R U R' F' U2"], note: 'Top colour at back-right and left-front. Same colour: front-left and right-back; right-front and back-left. Opposite colours: front-right and left-back.', pic: 'top', dim: ['edge', 'centre'], check: { blocks: true }, source: CMLL },
        { name: 'L Good', alg: "U2 F R' F' R U R U' R'", alt: ["U2 F R' F' r U R U' r'"], note: 'Top colour at back-right and left-front. Same colour: front-left and right-back; front-right and left-back. Opposite colours: right-front and back-left.', pic: 'top', dim: ['edge', 'centre'], check: { blocks: true }, source: CMLL },
        { name: 'L Pure', alg: "R U R' U R U' R' U R U' R' U R U2 R'", alt: ["R U2 R' U' R U R' U' R U R' U' R U' R'"], note: 'Top colour at back-right and left-front. Same colour: front-left and left-back; right-back and back-left. Opposite colours: front-left and right-front; front-right and right-back; front-right and back-left; right-front and left-back.', pic: 'top', dim: ['edge', 'centre'], check: { blocks: true }, source: CMLL },
        { name: 'L Front Commutator', alg: "U2 R U2 R D R' U2 R D' R2", alt: ["U2 R U2 r D r' U2 r D' r' R'"], note: 'Top colour at back-right and left-front. Same colour: front-left and right-front; front-right and left-back; right-back and back-left.', pic: 'top', dim: ['edge', 'centre'], check: { blocks: true }, source: CMLL },
        { name: 'L Diagonal', alg: "U2 R U2 R2 F R F' R U2 R'", alt: ["U2 r U2 R2 F R F' R U2 r'"], note: 'Top colour at back-right and left-front. Same colour: front-left and right-front; front-right and right-back. Opposite colours: front-left and left-back; front-right and back-left; right-front and left-back; right-back and back-left.', pic: 'top', dim: ['edge', 'centre'], check: { blocks: true }, source: CMLL },
        { name: 'L Back Commutator', alg: "U R' U2 R' D' R U2 R' D R2", alt: ["U2 R U R' U' R' F R2 U' R' U R U R' F' U2"], note: 'Top colour at back-right and left-front. Same colour: front-left and left-back; front-right and right-back; right-front and back-left.', pic: 'top', dim: ['edge', 'centre'], check: { blocks: true }, source: CMLL },
      ],
    },
    {
      title: 'LSE 4a: edge orientation',
      blurb: 'Nine cases, counted as wrong edges on top and below; the pictures show every side down to the bottom edge, so a wrong edge below is the top-or-bottom colour showing on the front or back strip. The corners are greyed: they are done and the algs put them back.',
      cases: [
        { name: 'Two on top, across from each other', alg: "M U M' U' M U M' U'", note: 'Flipped: top-front and top-back.', pic: 'top3', dim: ['corner'], check: { blocks: true, only: ['edge', 'centre'] }, source: SEARCH },
        { name: 'Two on top, next to each other', alg: "M' U M' U2 M' U M'", note: 'Flipped: top-back and top-left.', pic: 'top3', dim: ['corner'], check: { blocks: true, only: ['edge', 'centre'] }, source: SEARCH },
        { name: 'Four on top', alg: "U M' U2 M' U2 M' U' M'", note: 'Flipped: top-front, top-back, top-left and top-right.', pic: 'top3', dim: ['corner'], check: { blocks: true, only: ['edge', 'centre'] }, source: SEARCH },
        { name: 'One on top, one below', alg: "U2 M U' M' U' M U M' U'", note: 'Flipped: top-back and bottom-back.', pic: 'top3', dim: ['corner'], check: { blocks: true, only: ['edge', 'centre'] }, source: SEARCH },
        { name: 'Arrow: three on top, one below', alg: "U M U' M'", note: 'Flipped: top-front, top-back, top-left and bottom-back.', pic: 'top3', dim: ['corner'], check: { blocks: true, only: ['edge', 'centre'] }, source: SEARCH },
        { name: 'Two below', alg: "U M U M U' M' U' M'", note: 'Flipped: bottom-front and bottom-back.', pic: 'top3', dim: ['corner'], check: { blocks: true, only: ['edge', 'centre'] }, source: SEARCH },
        { name: 'Two below, two on top across from each other', alg: "U M U2 M U2 M' U' M'", note: 'Flipped: top-front, top-back, bottom-front and bottom-back.', pic: 'top3', dim: ['corner'], check: { blocks: true, only: ['edge', 'centre'] }, source: SEARCH },
        { name: 'Two below, two on top next to each other', alg: "M2 U' M' U M'", note: 'Flipped: top-back, top-left, bottom-front and bottom-back.', pic: 'top3', dim: ['corner'], check: { blocks: true, only: ['edge', 'centre'] }, source: SEARCH },
        { name: 'All six', alg: "M' U M' U2 M' U' M U' M' U' M'", note: 'Flipped: top-front, top-back, top-left, top-right, bottom-front and bottom-back.', pic: 'top3', dim: ['corner'], check: { blocks: true, only: ['edge', 'centre'] }, source: SEARCH },
      ],
    },
    {
      title: 'LSE 4c: the last four edges',
      folded: true,
      blurb: 'With the left and right top edges in and the middle-slice centres matched, the four edges left are top-front, top-back, bottom-front and bottom-back. Eleven cases: eight three-cycles (one edge already right) and three pairs of swaps. The pictures are read like the ones above.',
      cases: [
        { name: 'Three cycle, bottom-front stays: top-front → top-back → bottom-back', alg: "M U2 M' U2", note: 'Bottom-front is already right; the other three each move one place on: top-front → top-back → bottom-back → top-front.', pic: 'top3', dim: ['corner'], check: { blocks: true, only: ['edge', 'centre'] }, source: SEARCH },
        { name: 'Three cycle, bottom-back stays: top-front → bottom-front → top-back', alg: "M' U2 M U2", note: 'Bottom-back is already right; the other three each move one place on: top-front → bottom-front → top-back → top-front.', pic: 'top3', dim: ['corner'], check: { blocks: true, only: ['edge', 'centre'] }, source: SEARCH },
        { name: 'Three cycle, bottom-front stays: top-front → bottom-back → top-back', alg: "U2 M U2 M'", note: 'Bottom-front is already right; the other three each move one place on: top-front → bottom-back → top-back → top-front.', pic: 'top3', dim: ['corner'], check: { blocks: true, only: ['edge', 'centre'] }, source: SEARCH },
        { name: 'Three cycle, bottom-back stays: top-front → top-back → bottom-front', alg: "U2 M' U2 M", note: 'Bottom-back is already right; the other three each move one place on: top-front → top-back → bottom-front → top-front.', pic: 'top3', dim: ['corner'], check: { blocks: true, only: ['edge', 'centre'] }, source: SEARCH },
        { name: 'Three cycle, top-front stays: top-back → bottom-front → bottom-back', alg: "M U2 M U2 M2", note: 'Top-front is already right; the other three each move one place on: top-back → bottom-front → bottom-back → top-back.', pic: 'top3', dim: ['corner'], check: { blocks: true, only: ['edge', 'centre'] }, source: SEARCH },
        { name: 'Two swaps: top-front with bottom-front, top-back with bottom-back', alg: "M U2 M2 U2 M", note: 'The pieces change places in pairs.', pic: 'top3', dim: ['corner'], check: { blocks: true, only: ['edge', 'centre'] }, source: SEARCH },
        { name: 'Three cycle, top-back stays: top-front → bottom-back → bottom-front', alg: "M' U2 M' U2 M2", note: 'Top-back is already right; the other three each move one place on: top-front → bottom-back → bottom-front → top-front.', pic: 'top3', dim: ['corner'], check: { blocks: true, only: ['edge', 'centre'] }, source: SEARCH },
        { name: 'Three cycle, top-back stays: top-front → bottom-front → bottom-back', alg: "M2 U2 M U2 M", note: 'Top-back is already right; the other three each move one place on: top-front → bottom-front → bottom-back → top-front.', pic: 'top3', dim: ['corner'], check: { blocks: true, only: ['edge', 'centre'] }, source: SEARCH },
        { name: 'Three cycle, top-front stays: top-back → bottom-back → bottom-front', alg: "M2 U2 M' U2 M'", note: 'Top-front is already right; the other three each move one place on: top-back → bottom-back → bottom-front → top-back.', pic: 'top3', dim: ['corner'], check: { blocks: true, only: ['edge', 'centre'] }, source: SEARCH },
        { name: 'Two swaps: top-front with top-back, bottom-front with bottom-back', alg: "M2 U2 M2 U2", note: 'The pieces change places in pairs.', pic: 'top3', dim: ['corner'], check: { blocks: true, only: ['edge', 'centre'] }, source: SEARCH },
        { name: 'Two swaps: top-front with bottom-back, top-back with bottom-front', alg: "U2 M U2 M2 U2 M U2", note: 'The pieces change places in pairs.', pic: 'top3', dim: ['corner'], check: { blocks: true, only: ['edge', 'centre'] }, source: SEARCH },
      ],
    },
  ],
};

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

const BEN = 'https://docs.google.com/document/d/e/2PACX-1vTDL7-XvpNrhIc2Q_1nHfeJyG7tIazgBCq88PE8ahqIbvPb3LPQsM3_vsdqX6y8sxte1n5jGk2J3c5V/pub';
const LC = 'https://www.lowcubes.com/fto/tcp';
// Every FTO alg runs on cube/fto.ts (checked against cubing.js and lowcubes' model by test/fto.test.ts); the notes
// say what that run showed. In the picture the U face is the top triangle with its apex at the centre, so its
// corners are top-left, top-right and bottom; a corner's "inner" triangle is the one on the U face beside it, its
// "outer" triangle the one on the back face behind it (top end of the left strip, top end of the right strip, and
// the F face's top triangle for the bottom corner).
// Step 3's hold on the solver's own puzzle (Tingman's scheme): white centre at the back-left, grey at the back-right,
// green and orange the two being finished. The one orientation of that scheme with white and grey there, found from
// photos of eight of its corners; it puts purple on the left and yellow on the right.
const HEX = { white: '#ffffff', green: '#44ee00', red: '#ff0000', yellow: '#f4f400', blue: '#2266ff', purple: '#8800dd', orange: '#ff8000', grey: '#888888' };
const STEP3_HOLD: Record<FtoFace, string> = { U: HEX.green, F: HEX.orange, L: HEX.purple, R: HEX.yellow, D: HEX.blue, B: HEX.red, BL: HEX.white, BR: HEX.grey };
const fto: Puzzle = {
  id: 'fto', name: 'FTO', viewer: 'fto',
  notation: 'Ben Streeter\'s notation, which twizzle uses: hold the octahedron with a corner pointing at you. The four faces around that corner are <code>U</code> (upper), <code>F</code> (lower), <code>L</code> and <code>R</code>; the four at the back are <code>D</code> (behind U), <code>B</code> (behind F), <code>BL</code> and <code>BR</code>. A letter turns that face 120° clockwise looking at it, a prime anticlockwise, <code>X2</code> is two turns (the same as <code>X\'</code>). <code>Xw</code> turns the face and the slice under it, <code>Xs</code> the slice alone, <code>Xo</code> the whole puzzle the way X turns. Standard colours: white on U, green on F. A triple is a corner with the two triangles on either side of it. The pictures look at the front corner: U is the top triangle, F the bottom, L and R the sides, and the strips around the square are the back faces\' rows along the shared edges (B above, D below, BL left, BR right). The TCP cases are written in lowcubes\' edge-in-front letters instead, explained under their heading.',
  intro: '<b>Bencisco</b> (Ben Streeter\'s method) is the standard: a block, the first centre, two triples, the second centre, the last two centres, then the last bottom triple and the last three triples. Everything but the end is intuitive; the memorised part is a handful of algs (Tingman\'s five below), or lowcubes\' eighteen TCP cases for a one-alg finish. Edges have no orientation and ride along with the triangles.',
  sections: [
    {
      title: 'Tingman\'s beginner method, step by step',
      // Summarised from the video's captions (2026-09-26), in our own words; the two mid-solve algs in step 3 are
      // as heard, not run on the model: they move unsolved pieces by design, so there is no "only moves X" to check.
      blurb: 'The six steps of <a href="https://www.youtube.com/watch?v=6GIyEJP5FO8" target="_blank" rel="noopener">Tingman\'s tutorial</a> with the tips he gives along the way. His colours: yellow opposite white; going anticlockwise round the white face (looking at it) the edges run red, blue, purple; the middle centres are grey, orange and green. <b>The hold</b> (Ben\'s, as in the notation box): a corner points at you. The face above it is the <b>top face</b>, and its three corners are the <b>front corner</b> (pointing at you), the <b>back-left corner</b> and the <b>back-right corner</b>. The face to the right of the front corner, sharing the top face\'s front-to-back-right edge, is the <b>right face</b>. The front corner sits between the left thumb and fingers, so the right hand does R and U.',
      steps: [
        '<b>White centre.</b> A centre is six pieces (three triangles, three edges) and is built as two halves. The <b>large trap</b> is one triangle with an edge on each side of it; the <b>small trap</b> is one edge with a triangle on each side of it. Build the large one, then the small one, then join them. Large trap: stick any white edge onto any white triangle. The edge for the triangle\'s other side is the next one anticlockwise round white (red → blue → purple → red): with white-red on, it is white-blue. Don\'t drag that edge over to the pair, which pulls the pair apart; move the pair into the edge\'s layer and bring the pair and edge across together. Then hold the large trap on the left face so R, U and wide moves never touch it. Small trap: stick the last white edge onto one of the two loose white triangles, bring the other loose triangle onto that edge\'s free side, then slide the small trap in beside the large one. If a finished small trap looks as if it pushes straight in but lands wrong, turn its layer once so it meets the large trap from the other end. Every centre later in the solve is built the same way.',
        '<b>Two white triples.</b> A triple is a white corner with its two correct triangles, one on each side of it. Keep the white centre on the left face and use only R, Rw and U, which never move it. <b>Start with a corner that is already half made</b> (one of its two triangles attached): there usually is one, often two. The triangle it still needs is usually lying loose in the bottom of the puzzle, where the finished triples end up. Move the half-made triple aside, turn a layer that doesn\'t touch the white centre to bring that triangle to where the triple\'s empty side will land, then bring the triple back onto it. <b>If the triangle you can reach fits the corner\'s other side, flip the triple over first</b>: turning it out of its layer and back the other way round swaps which side faces which; then find the triangle for that side. <b>Insert each triple as soon as it is complete</b>: turn the white centre until the slot\'s neighbouring faces match the triple\'s two triangles. If they don\'t line up, turn white one more time and insert from the other side. A corner sitting in its slot unfinished comes out first. Leave the third white triple for step 4: its empty slot is what lets R and U turn freely in step 3.',
        '<b>Middle three centres</b> (grey, orange, green, the centres in white\'s orbit; blue, red and purple come out right by themselves). R, U and wide moves only. Build each one as in step 1, but the edge order is the <b>reverse</b> of white\'s: where white\'s edges run red → blue anticlockwise, these run blue → red (so a grey centre\'s large trap is grey-red with grey-blue on the triangle\'s other side). A large trap that turns up ready-made still needs this order checked. Turn each finished centre so its yellow edge is on the top face. <b>Second centre</b> (the third comes with it): every R you do to move pieces round the top must be undone with R\' before the next step, and never pull pieces of the first finished centre into the top layer. Large traps only sit in slices, not outer layers, so take a triangle-edge pair from the third centre, join it to an edge on the second centre\'s face, and slide it left into place. <b>Finish</b>: <code>Rw\'</code> brings the third centre to the top face. You want its last edge-triangle pair on the top face and one loose triangle ready to finish it: then <code>R U R\'</code>, or <code>R U\' R\'</code> when the triangle is in the other of its two places (if one doesn\'t finish it, undo and do the other). The loose triangle is in the wrong place: put the pair into the right face (<code>R</code>), <code>U</code> or <code>U\'</code> to move the triangle across, <code>R\'</code> to bring the pair back. Pair and triangle are the other way round (triangle on the top face, pair in the right face): <code>R</code>, <code>U</code> or <code>U\'</code>, <code>R\'</code> swaps them, which leaves the wrong-place case above. When the two faces share the pieces half and half, the two cards under <i>Middle centres: the last two</i> below finish both faces at once: one for the top face holding a pair and a loose triangle, one for it holding a whole small trap. Anything else is usually one <code>R U R\'</code> or <code>R U\' R\'</code> away from these. The whole small trap made on the top face: <code>R U R\' U\' R U R\' U\' U\' R\'</code>. Check against white: line the white layer up with the centres; if they are wrong, exactly two are swapped, which comes from a large trap built in the wrong edge order (the finishing moves cannot see that: they fill each face with one colour either way). In the hold of <i>Middle centres: the last two</i> (white at the back-left), the swap is: top and back-right <code>R\' U R U Rw\' U R U Rw R U\' R</code>; bottom-front and back-right <code>R U R Rw U\' R U\' Rw\' U\' R U\' Rw R\'</code>; top and bottom-front <code>R U R Rw U\' R U\' Rw\' U\' R U\' R\'</code>. Each knocks a white triple out, so rebuild it as in step 2 afterwards.',
        '<b>Last white triple.</b> From here white is on the bottom and yellow on the top face. The tool is the sledge <code>R\' L R L\'</code> (and the hedge <code>R B\' R\' B</code>). Here a "triple" is any of the top face\'s three corners with the two triangles either side of it: the one on the top face and the one on the side below it. <b>A sledge leaves the back-left triple as it is (it moves to the back-right corner) and turns the front and back-right triples over</b>, swapping their top-face and side triangles. Find the last white corner in the top layer and turn U until a triangle it needs is next to it. If that triangle is on the corner\'s wrong side, hold the puzzle so the triangle\'s triple is at the back-left corner (it stays) and the white corner is at the front or back-right corner (it turns over), sledge, then U or U\' to join them. Choose the hold so the side you already joined is not the one broken. Insert: turn the white bottom layer until the slot sits correctly (from the wrong side the triple would go in upside down). Put the triple at the front corner, then <code>L R L\' R\'</code> if its slot is the bottom-right corner (below the right face) or <code>R\' L\' R L</code> if it is the bottom-left: open the slot, drop it in, close it, like an F2L pair. If the white corner is already in a bottom slot wrongly, or a triangle you need is trapped down there, do the same insert with any other top triple to swap it out. If nothing works, a corner may be twisted or the puzzle reassembled wrong.',
        '<b>Pair formation.</b> Make three corner-triangle pairs from the last layer\'s corners and its purple, blue and red triangles (a pair\'s colours need not match). Finished looks like two pairs with their triangle on the top face and one with its triangle on the side. Only sledges and U. A pair can only be made with its triangle on the side, so <b>after making one, sledge it up</b> (hold it at the front or back-right corner, which the sledge turns over), and keep a finished top-face pair at the back-left corner, which the sledge leaves alone. None made: sledge once and see. Watch for the <b>one flip</b>: two pairs done and the last corner and triangle stuck the wrong way, with no U or sledge able to fix it. Avoid it by seeing it coming and pairing the other corner instead. If you\'re in it: put one finished pair at the back-left corner, sledge, and rebuild the pair it breaks.',
        '<b>Two-look TCP, first look: make the top face all yellow.</b> Turn the whole puzzle (about the top face) until the pair with its triangle <i>on the side</i> is at the <b>back-left corner</b>. The two pairs with their triangle on the top face are then at the front and back-right corners, and both touch the right face. Compare each of those two corners\' sticker on the right face with the right face\'s triangles beside it. <b>Back-right corner matches: sledge</b> <code>R\' L R L\'</code>. <b>Front corner matches: hedge</b> <code>R B\' R\' B</code>. (The matching corner is the one that moves first: the far one sledge, the near one hedge.) <b>Neither matches</b>: turn the puzzle so the side pair is at the <b>front corner</b> instead (the two top-face pairs at back-left and back-right), then hedge, then sledge. Turn U to line the layer up. <b>Second look</b>: two triangles to swap, or three to cycle: the algs in <i>Tingman\'s finish</i> below, held with an edge pointing at you instead of a corner.',
      ],
      cases: [],
    },
    {
      title: 'Middle centres: the last two',
      blurb: 'Step 3\'s finish in the corner-in-front hold, drawn in Tingman\'s colours as you hold it then: white at the back-left, grey (done) at the back-right, green on top and orange below being finished, purple on the left and yellow on the right. R and U only, so the white centre, the first middle centre and the two white triples at the back stay put. In both cases the lower-front face already holds one colour\'s large trap (the triangle by its bottom-left corner with both its edges) and the other colour\'s small trap (the edge from the front corner to the bottom-right corner, with a triangle each side). Both algs finish the two faces at once, but only as solid colours: a large trap built in the wrong edge order finishes just the same and shows up at the white check as two centres swapped (step 3 has the fix), so check the order before.',
      cases: [
        { name: 'Pair and loose triangle on top', alg: "R U' R' U R U' R'", note: 'The top face holds the first colour\'s edge-triangle pair (the triangle by the front corner, the edge running to the back-right corner) and its loose triangle by the back-left corner. Turn U until they sit there.', check: {}, scheme: STEP3_HOLD },
        { name: 'Whole small trap on top', alg: "R U' R' U R U' R' U R U R'", note: 'The top face holds the other colour\'s large trap by the front corner (the triangle there with both its edges) and the first colour\'s whole small trap along the back edge, so neither can be pushed straight down. The first seven moves are the case before; <code>U R U R\'</code> after them deals with the small trap being whole.', check: {}, scheme: STEP3_HOLD },
      ],
    },
    {
      title: 'Triples: sledge and hedge',
      blurb: 'Both cycle the three corners of the U face, one each way, and carry six triangles round in two cycles: the triangles do not stay with their corners.',
      cases: [
        { name: 'Sledge (clockwise)', alg: "R' L R L'", note: 'Corners top-right → bottom → top-left. Triangles: inner top-right → outer bottom → inner top-left, and outer top-left → outer top-right → inner bottom. Any two faces that share only a corner make a sledge: F\' U F U\' is the same shape aimed at the R face (its bottom-right, centre and top-right corners).', check: { only: ['corner', 'centre'], top: true }, source: BEN },
        { name: 'Hedge (anticlockwise)', alg: "R B' R' B", note: 'Corners top-left → bottom → top-right. Triangles: outer top-left → outer bottom → inner top-right, and inner bottom → outer top-right → inner top-left.', check: { only: ['corner', 'centre'], top: true }, source: BEN },
      ],
    },
    {
      title: 'Last three triples: the corner cycle',
      blurb: 'After the triangles are placed with sledges and hedges, the three corners of the R face (the right triangle of the picture) may still need cycling. Both algs carry the R triangle beside each corner round with it.',
      cases: [
        { name: 'Corners clockwise', alg: "F' U F' D' F U' F' D F'", note: 'Cycles the three corners of the R face (bottom-right → centre → top-right, clockwise looking at R), each with the R triangle beside it. Nothing else moves.', check: { only: ['corner', 'centre'] }, source: BEN },
        { name: 'Corners anticlockwise', alg: "F D' F U F' D F U' F", note: 'The inverse: the same three corners the other way, each with its R triangle.', check: { only: ['corner', 'centre'] }, source: BEN },
      ],
    },
    {
      title: 'Last bottom triple',
      blurb: 'Ninety-odd cases, most of them a setup move, a sledge and the setup undone. One to show the shape; the full table is at zwegner.github.io/cubing/fto/lbt-algs.html.',
      cases: [
        { name: 'Keyhole insert', alg: "BL R' L' R L BL'", note: 'A BL setup, a sledge from the left, and the setup undone: the same corner cycle as the sledge (top-right → bottom → top-left) with a different pair of triangle cycles, one of them reaching a triangle of F by the bottom-left corner of the picture.', check: { only: ['corner', 'centre'] }, source: 'https://zwegner.github.io/cubing/fto/lbt-algs.html' },
      ],
    },
    {
      title: 'Tingman\'s finish: the last triple and a two-look TCP',
      blurb: 'From Tingman\'s beginner tutorial (Bencisco, thanks to Ben in the credits). These and the lowcubes table below are written in <b>edge-in-front</b> letters, not Ben\'s: hold an edge toward you, <code>U</code> above it, <code>F</code> below it (the last face), <code>L</code> and <code>R</code> beside F, <code>D</code> opposite U, <code>B</code> opposite F, <code>Bl</code> and <code>Br</code> beside U at the back; <code>Rw</code> turns R and the slice under it, <code>Rs</code> the slice alone. The model tells the two notations apart: these algs move only triangles read this way and would move edges read as Ben\'s. In the picture the last face F is the top triangle, U\'s row is the strip above it, L and R the side triangles, D the bottom one, Bl and Br the side strips; a corner\'s inner triangle is beside it on F, its outer one behind it. Playing one in 3D shows it in Ben\'s letters with the rotations pushed through.',
      cases: [
        { name: 'Last white triple, to the right', alg: "L R L' R'", note: 'The triple at the bottom of the last face goes into the slot below it on the right and the top-left one drops to the bottom (corners top-left → bottom → below-right, each with triangles). Tingman\'s insert when the last white triple is at the bottom of the last face and its slot is on the right.', frame: 'eif', check: { only: ['corner', 'centre'] }, source: 'https://www.youtube.com/watch?v=6GIyEJP5FO8' },
        { name: 'Last white triple, to the left', alg: "R' L' R L", note: 'The mirror: the bottom triple goes into the slot below it on the left and the top-right one drops to the bottom.', frame: 'eif', check: { only: ['corner', 'centre'] }, source: 'https://www.youtube.com/watch?v=6GIyEJP5FO8' },
        { name: 'Three triangles clockwise', alg: "U' R U' Rs U R' U' Rs' U'", note: 'The three outer triangles cycle clockwise, top-right → bottom → top-left. Nothing else moves.', frame: 'eif', check: { only: ['centre'], top: true }, source: 'https://www.youtube.com/watch?v=6GIyEJP5FO8' },
        { name: 'Three triangles anticlockwise', alg: "U Rs U R U' Rs' U R' U", note: 'The three outer triangles cycle anticlockwise, top-left → bottom → top-right. Nothing else moves.', frame: 'eif', check: { only: ['centre'], top: true }, source: 'https://www.youtube.com/watch?v=6GIyEJP5FO8' },
        { name: 'Swap two triangles', alg: "Rw U R' U' Rs' U R U' R'", note: 'Inner top-right → inner top-left → the Br triangle behind the top-back corner (out of the picture): a swap of two triangles alone is impossible on the FTO, so the third rides along, which is why Tingman uses it before the three-cycles.', frame: 'eif', check: { only: ['centre'] }, source: 'https://www.youtube.com/watch?v=6GIyEJP5FO8' },
        { name: 'Swap two triangles, corner in front', alg: "R F U F' U' Fs U F U' F' Fs' R'", alt: ["R F U F' U' Fw F' U F U' F' Fw' F R'"], note: 'The same fix in the corner-in-front hold of steps 1-5, in Ben\'s letters: for when everything is solved but the left and right faces\' triangles beside the front corner, each the other\'s colour. It cycles left-beside-the-front-corner → right-beside-the-front-corner → left-beside-the-top-left-corner, and the triangle it brings from beside the top-left corner is the same colour as the one it moves away from the right face, so it reads as a swap. <code>Fs</code> is the middle layer behind the bottom face, turned the way F turns; the alt spells it <code>Fw F\'</code>. It only reaches triangles on the left and right faces: the triangles come in two sets that never mix, and the ones on the top and bottom faces are the other set. Two wrong triangles on the top and bottom faces: turn the whole puzzle a quarter turn about the front corner first, which moves those faces to the sides.', check: { only: ['centre'] } },
      ],
    },
    {
      title: 'TCP: all eighteen cases (lowcubes)',
      folded: true,
      blurb: 'lowcubes\' 2-look L3T: pair formation, then one of these places the three corners with their triangles in one alg. The same edge-in-front letters as above; <code>Rt2</code> turns the whole puzzle 180° about the corner between U, F, R and Br, <code>R2\'</code> is <code>R</code>. A cases cycle the corners clockwise (bottom → top-left → top-right), B cases anticlockwise, C cases turn the two top corners in place; each note then lists the triangle cycles (→) and swaps (↔).',
      cases: [
        { name: 'A1', alg: "U' R U R'", note: 'Corners clockwise; inner bottom → inner top-left → outer top-right; outer top-left → inner top-right → outer bottom.', frame: 'eif', check: { only: ['corner', 'centre'], top: true }, source: LC },
        { name: 'A2', alg: "Uo' U R' U' R' D' R U R' D R U' R Uo", note: 'Corners clockwise; inner bottom → inner top-left → outer bottom → outer top-right; outer top-left ↔ inner top-right.', frame: 'eif', check: { only: ['corner', 'centre'], top: true }, source: LC },
        { name: 'A3', alg: "Fo R' D R' U' R D R U R' D R Fo'", note: 'Corners clockwise; inner bottom → inner top-left → outer top-left; outer top-right → inner top-right → outer bottom.', frame: 'eif', check: { only: ['corner', 'centre'], top: true }, source: LC },
        { name: 'A4', alg: "Rt2 U D' R U' R' D Lo' U R' U' R Ro'", note: 'Corners clockwise; one long cycle: inner bottom → inner top-left → outer bottom → outer top-left → inner top-right → one of Br\'s triangles at the back (not in the picture) → outer top-right.', frame: 'eif', check: { only: ['corner', 'centre'] }, source: LC },
        { name: 'A5', alg: "Rt2 U Rw' U' R U Rw R2' U' R Rt2", note: 'Corners clockwise; inner bottom → inner top-left → outer top-right; outer top-left ↔ inner top-right; outer bottom ↔ D\'s triangle at the bottom-right of the picture.', frame: 'eif', check: { only: ['corner', 'centre'] }, source: LC },
        { name: 'A6', alg: "Rt2 R' U' Rw' R U' R U R' Rw U Rt2", note: 'Corners clockwise; five triangles cycle, inner bottom → inner top-left → outer top-left → inner top-right → outer top-right; the outer bottom one stays.', frame: 'eif', check: { only: ['corner', 'centre'], top: true }, source: LC },
        { name: 'B1', alg: "Fo R U' R' U Fo'", note: 'Corners anticlockwise; outer top-right → inner top-left → outer bottom; inner bottom → inner top-right → outer top-left.', frame: 'eif', check: { only: ['corner', 'centre'], top: true }, source: LC },
        { name: 'B2', alg: "U' R U R D R' U' R D' R' U R'", note: 'Corners anticlockwise; outer top-right ↔ inner top-left; inner bottom → inner top-right → outer bottom → outer top-left.', frame: 'eif', check: { only: ['corner', 'centre'], top: true }, source: LC },
        { name: 'B3', alg: "F' R' D' R U' R' D' R' U R D' R", note: 'The whole layer turns clockwise (corners, edges and the side triangles beside them) except two triangle cycles: inner bottom → inner top-left → outer bottom → outer top-left, and outer top-right ↔ inner top-right.', frame: 'eif', check: { top: true }, source: LC },
        { name: 'B4', alg: "Fo U' D R' U R D' Ro R' U R U' Rt2", note: 'Corners anticlockwise; one long cycle: outer top-right → inner top-left → one of Bl\'s triangles at the back (not in the picture) → outer top-left → inner bottom → inner top-right → outer bottom.', frame: 'eif', check: { only: ['corner', 'centre'] }, source: LC },
        { name: 'B5', alg: "Fo U' Rw U R' U' Rw2 R' U R' Fo'", note: 'Corners anticlockwise; outer top-right ↔ inner top-left; inner bottom → inner top-right → outer top-left; outer bottom ↔ D\'s triangle at the bottom-left of the picture.', frame: 'eif', check: { only: ['corner', 'centre'] }, source: LC },
        { name: 'B6', alg: "Fo R U R' Rw U R' U' R Rw' U' Fo'", note: 'Corners anticlockwise; five triangles cycle, outer top-right → inner top-left → outer top-left → inner bottom → inner top-right; the outer bottom one stays.', frame: 'eif', check: { only: ['corner', 'centre'], top: true }, source: LC },
        { name: 'C1', alg: "U' R' D R' U R D' R", note: 'The two top corners turn in place; outer top-left → inner top-left → outer top-right → inner top-right → outer bottom.', frame: 'eif', check: { only: ['corner', 'centre'], top: true }, source: LC },
        { name: 'C2', alg: "Uo' U R D' R U' R' D R' Uo", note: 'The two top corners turn in place; outer top-left → inner top-left → outer bottom → outer top-right → inner top-right.', frame: 'eif', check: { only: ['corner', 'centre'], top: true }, source: LC },
        { name: 'C3', alg: "Fo' F R Br R' L R Br' R2' L' R Fo", note: 'The whole layer turns clockwise (corners, edges and the side triangles beside them) except two triangle cycles: inner bottom → inner top-left → outer top-left, and outer top-right → inner top-right → outer bottom.', frame: 'eif', check: { top: true }, source: LC },
        { name: 'C4', alg: "F' R' D' R U' R' D R2 U R'", note: 'The whole layer turns anticlockwise (corners, edges and the side triangles beside them) except two triangle cycles: outer top-left → inner top-left → outer bottom, and inner bottom → inner top-right → outer top-right.', frame: 'eif', check: { top: true }, source: LC },
        { name: 'C5', alg: "Uo R' U' R D' R U' R' D R' U' R Uo'", note: 'The two top corners turn in place; outer top-left → inner top-left → R\'s triangle at the bottom-right of the picture → outer top-right → inner top-right.', frame: 'eif', check: { only: ['corner', 'centre'] }, source: LC },
        { name: 'C6', alg: "R U' R' U Ro R' U R U' Ro'", note: 'The two top corners turn in place; outer top-left ↔ inner top-left and outer top-right ↔ inner top-right: the two top corners\' triangles change sides.', frame: 'eif', check: { only: ['corner', 'centre'], top: true }, source: LC },
      ],
    },
  ],
};

// (the 3x3's last layer is not here: its OCLL and PLL are the Cases sheet's own, user 2026-09-27; Roux is, 2026-09-28)
export const PUZZLES: Puzzle[] = [roux, p222, p444, p555, pyra, skewb, fto];
