import { MIN_OCR_PAGE_LONG_SIDE, readScore, readsAsText, sauvolaWins, turnBeatsUpright } from '../ocr.js';
import { rasterScale } from '../pdfExtractor.js';
import { getSpell, type Spell } from '../../validators/dictionary.js';

// Real OCR output of one PAN card photo (client QA 2026-10, 650930 p.7), abridged.
const UPRIGHT = `INCOME TAX DEPARTMENT 2 GOVT. OF INDIA
¥ Toefl Fre HEAT FE AE EE:
Permanent Account Number Card RE RE tas hah
ABCPV5678K TREES Eis
© RAVI KUMAR SHARMA AI +3
fam = 71 978 / Father s Name BREASTS
MOHAN LAL (s1a01%
| | M0 TENET Signature`;
// The same card read at 180°: more letter clusters than the upright read, almost no words.
const UPSIDE_DOWN = `GES Curird (pT Fr rs ? - 5 - . .
asmeuliug gpA. 000z/¥0/0Z |
FLozes LAL NAHOM
RRR RRS H3HAOJSIRRO
SRST a a AMRAHS RAMUK IVAR
RIB FRI en A
SAN aan ae
A BEB BEE N.4321dOBA
yee a a pie7) JaquINN JUNOdJY usueulad
Fra SAC IaR Si InSb LB pits: 3
VIANI 40 LAOD 4 INTADIVAAQ XVLINOONT`;
// A card's background pattern read upright as noise (643885 p.6) vs the contrast-boosted read.
const PATTERN_NOISE = `evs SE Es
= EE SRE SERRE EER TE
% + SER BE Re AE RA ar pat
J Do fi BRE a Fe | ppg Rp CRs ER RR I a
i Site SSE Ss Te RS, a i * uy Br —— — Bo) EA
CINACATT TAY TED EE i ER Saadeh i
Sale = SESE EEE, Les ie TERE © A IT OF] INT igs al
ead SEER REE Er Dn eat nieecti & el or IAT
Permanent Accoun ES SEE i Lo
SARS ME ACCOUNT NUM ppc ps`;
const BOOSTED = `INCOME TAX DEPARTMENT &D GOVT. OF INDIA
KONDAPALLI VENKATA LATHA Ar
KONDAPALLI VENKATA RAMARAO es TA
: Permanent Account Number Ei i | go
BQRPK4821C FN`;

// A sideways Aadhaar front (059741 p.9): the right turn reads the card, the wrong one reads
// only the "Issue Date" strip printed along its edge — fewer words, all of them short.
const AADHAAR_RIGHT_TURN = `| £1007 GOVERNMENT OF INDIR: = 7 Zey il
8 : Suresh Chandra Tiwari
| 3 a5 4 fafd / DOB : 01/01/1960
| ¥ FY / MALE
IE. A Mobile No. 9000000001
FH | 1234 5678 9012`;
const AADHAAR_WRONG_TURN = `f Issue Date 18032014
EE ERE
8P 2: FP 4 |
ABLE :
“SHEL &`;

// Value: protects=OCR keeps the card orientation that reads as real words, and turns a page only on clear evidence; fails_when=the score goes back to counting word-shaped tokens (upside-down and pattern-noise reads win, PAN/Aadhaar reported missing), or a turn is taken on a word or two (upright cards read sideways); why_new=readScore, readsAsText and turnBeatsUpright are new; seam=the pure scoring only — the rotation sweep itself needs tesseract and is checked with a tsx harness; no_claim=threshold tuning beyond the measured cases
describe('OCR orientation scoring', () => {
  let spell: Spell;
  beforeAll(async () => {
    spell = await getSpell();
  });
  const words = (text: string) => readScore(text, spell);

  it('a card read upside down finds no real words, though it has more letter clusters', () => {
    expect(words(UPRIGHT)).toBeGreaterThanOrEqual(10);
    expect(words(UPSIDE_DOWN)).toBeLessThanOrEqual(1);
    // The page arrived upside down: the 180° turn is believed over it, never the reverse.
    expect(turnBeatsUpright(words(UPRIGHT), words(UPSIDE_DOWN))).toBe(true);
    expect(turnBeatsUpright(words(UPSIDE_DOWN), words(UPRIGHT))).toBe(false);
  });

  it('prefers a clean read over background-pattern noise that has more word-shaped tokens', () => {
    expect(words(BOOSTED)).toBeGreaterThan(words(PATTERN_NOISE));
  });

  it('does not count short dictionary hits, which noise is full of', () => {
    expect(words('ERR SEE EAR TEE ODE ERE ABLE DATE PIED NEAR')).toBe(0);
  });

  it('believes the turn that reads a sideways card over one that reads a short edge strip', () => {
    expect(turnBeatsUpright(words(AADHAAR_RIGHT_TURN), words(AADHAAR_WRONG_TURN))).toBe(true);
  });

  it('does not turn a page on a word or two', () => {
    expect(turnBeatsUpright(1, 0)).toBe(false); // a staff ID read upside down on one stray word
    expect(turnBeatsUpright(2, 1)).toBe(false);
    expect(turnBeatsUpright(7, 6)).toBe(false); // a PAN card read sideways
    expect(turnBeatsUpright(2, 0)).toBe(true);
  });

  it('takes a page as plainly readable only on ten real words that are not lost in noise', () => {
    expect(readsAsText(UPRIGHT, words(UPRIGHT))).toBe(true);
    // A sparse card still gets the contrast-boosted and turned reads.
    expect(readsAsText(BOOSTED, words(BOOSTED))).toBe(false);
    // An upside-down policy page: 26 dictionary words by chance, among 434 letter clusters.
    expect(readsAsText('Xqz '.repeat(434), 26)).toBe(false);
    expect(readsAsText('Xqz '.repeat(200), 26)).toBe(true);
  });
});

// Value: protects=the Sauvola read replaces a card's read only when it reads clearly more and is more than a scrap, and only pages smaller than paper are rendered larger; fails_when=the gate drops to "any gain" or to a 2-3 word read (Sauvola reads that lost a PAN and an Aadhaar marker win again), or the floor starts enlarging A4/Letter pages (every dense page pays for it, and near-paper scans lose numbers to OCR noise); why_new=sauvolaWins and rasterScale are new; seam=the pure decisions only — the Sauvola pass and the render need tesseract/pdfjs and are checked with a tsx harness; no_claim=threshold tuning beyond the measured cases
describe('OCR second looks', () => {
  it('takes the Sauvola read only when it reads clearly more, and more than a scrap', () => {
    expect(sauvolaWins(5, 3)).toBe(true); // a PAN card on a patterned ground (301725 p.4)
    expect(sauvolaWins(4, 2)).toBe(true);
    expect(sauvolaWins(8, 7)).toBe(false); // a gain this small splits "Unique Identification"
    expect(sauvolaWins(3, 2)).toBe(false); // read "INCOME TAX" as "COMETAX" (632308 p.3)
    expect(sauvolaWins(3, 1)).toBe(false); // read "Male" as "Make" (648687 p.7)
    expect(sauvolaWins(4, 3)).toBe(false);
  });

  it('renders only pages smaller than paper larger', () => {
    expect(rasterScale(595.28, 841.89, 2, MIN_OCR_PAGE_LONG_SIDE)).toBe(2); // A4
    expect(rasterScale(841.89, 595.28, 2, MIN_OCR_PAGE_LONG_SIDE)).toBe(2); // A4 landscape
    expect(rasterScale(612, 792, 2, MIN_OCR_PAGE_LONG_SIDE)).toBe(2); // US Letter
    expect(rasterScale(595, 770, 2, MIN_OCR_PAGE_LONG_SIDE)).toBe(2); // a cropped A4 scan
    // A voter card saved as its own 465x280pt page: 930 px wide at scale 2.
    expect(465 * rasterScale(465, 280.5, 2, MIN_OCR_PAGE_LONG_SIDE)).toBeCloseTo(MIN_OCR_PAGE_LONG_SIDE);
    // The high-resolution retry keeps twice the first look's size.
    expect(rasterScale(465, 280.5, 4, 2 * MIN_OCR_PAGE_LONG_SIDE)).toBeCloseTo(
      2 * rasterScale(465, 280.5, 2, MIN_OCR_PAGE_LONG_SIDE)
    );
    expect(rasterScale(595.28, 841.89, 4, 2 * MIN_OCR_PAGE_LONG_SIDE)).toBe(4);
    // Callers that ask for no floor (the QR scan) and degenerate pages keep their scale.
    expect(rasterScale(465, 280.5, 2, 0)).toBe(2);
    expect(rasterScale(0, 0, 2, MIN_OCR_PAGE_LONG_SIDE)).toBe(2);
  });
});
