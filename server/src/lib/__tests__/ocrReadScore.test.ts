import { readScore, readsAsText, turnBeatsUpright } from '../ocr.js';
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
