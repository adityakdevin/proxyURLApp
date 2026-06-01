import { classify, ClassifiableType } from '../documentClassifier.js';

const types: ClassifiableType[] = [
  { id: 'aadhar', name: 'Aadhar Card', category: 'GOVT', govtCode: 'AADHAR', displayOrder: 2 },
  { id: 'pan', name: 'PAN Card', category: 'GOVT', govtCode: 'PAN', displayOrder: 3 },
  { id: 'card', name: 'Card', category: 'CUSTOM', govtCode: null, displayOrder: 1 },
  { id: 'bill', name: 'Bill', category: 'CUSTOM', govtCode: null, displayOrder: 4 },
];

describe('documentClassifier.classify', () => {
  it('matches a GOVT govtCode token', () => {
    expect(classify('aadhar_front.pdf', [types[0], types[1]])).toBe('aadhar');
  });
  it('matches a CUSTOM name token (case-insensitive)', () => {
    expect(classify('BILL_jan.PDF', [types[3]])).toBe('bill');
  });
  it('breaks multiple matches by lowest displayOrder', () => {
    // "aadhar_card.pdf" matches both AADHAR (displayOrder 2) and "Card" (1) → Card wins
    expect(classify('aadhar_card.pdf', types)).toBe('card');
  });
  it('returns null when nothing matches', () => {
    expect(classify('random_scan.pdf', types)).toBeNull();
  });
});
