/** Regressions from the client QA summary report of 2026-10: Duplicate (#13-19) and Data
 *  Compare (#20-32) extraction gaps. */
import { extractField, extractNames, extractVehicleNos } from '../crossDocLogic.js';
import { extractIdentifiers } from '../dupIdentifiers.js';

const uans = (t: string) => extractIdentifiers(t).filter((i) => i.field === 'UAN').map((i) => i.value);

describe('client QA 2026-10 — Duplicate', () => {
  it('#13 a grouped UAN is read', () => {
    expect(uans('UAN No. : 1012 3456 7890')).toEqual(['101234567890']);
    expect(uans('UAN: 101234567890')).toEqual(['101234567890']);
  });
  it('#13 account numbers with "No." or no separator are read', () => {
    expect(extractField('ACCOUNT_NO', 'A/c No. : 1234 5678 9012')).toEqual(['1234 5678 9012']);
    expect(extractField('ACCOUNT_NO', 'Account No 50100234567890')).toEqual(['50100234567890']);
    expect(extractField('ACCOUNT_NO', 'Contact No: 7088007037')).toEqual([]);
  });
  it('#16 an employee code after "Employee No." is read', () => {
    expect(extractField('EMP_CODE', 'Employee No. : E1234')).toEqual(['E1234']);
  });
  it('#18/19 dealer and payer names are not customers', () => {
    expect(extractNames('MISP Name : PARASAVNATH AUTOWHEELS')).toEqual([]);
    expect(extractNames('M1SP Name : PARASAVNATH AUTOWHEELS')).toEqual([]);
    expect(extractNames('Payer Name : DRIVE N RIDE')).toEqual([]);
    expect(extractNames('Insured Name : BHUPENDER SINGH')).toEqual(['BHUPENDER SINGH']);
  });
});

describe('client QA 2026-10 — Data Compare', () => {
  it('#25 the authorised signatory is not the employee', () => {
    expect(extractNames('Employee Name : NEERAJ TRIVEDI\nAuthorised Signatory\nName : Mayank')).toEqual(['NEERAJ TRIVEDI']);
  });
  it('#27 the nominee under a heading is not the customer', () => {
    expect(extractNames('Insured Name : RAM KUMAR\nNominee Details\nName : SUNITA DEVI')).toEqual(['RAM KUMAR']);
  });
  it('a bare "Name :" with no heading above is still read', () => {
    expect(extractNames('GOVERNMENT OF INDIA\nName : RAM KUMAR')).toEqual(['RAM KUMAR']);
  });
  it('#29 a premium line is not a vehicle number', () => {
    expect(extractVehicleNos('BASIC PREMIUM - Vehicle\nTP 5114')).toEqual([]);
    expect(extractVehicleNos('Basic Premium - Vehicle 5,114')).toEqual([]);
  });
  it('#32 registration numbers with "No." and en-dashes are read whole', () => {
    expect(extractVehicleNos('Regn. No. : MH 12 AB-1234')).toEqual(['MH 12 AB-1234']);
    expect(extractVehicleNos('Registration No.: MH12–AB1234')).toEqual(['MH12-AB1234']);
    expect(extractVehicleNos('Vehicle No : UP32 KQ 5678')).toEqual(['UP32 KQ 5678']);
    expect(extractVehicleNos('Vehicle Registration No. HR 26 DK 8337')).toEqual(['HR 26 DK 8337']);
  });
  it('#31 a multi-line Aadhaar address is read through the PIN, without the S/O prefix', () => {
    const [a] = extractField('ADDRESS', 'Address: S/O Ram Kumar,\nH No 12, Gandhi Nagar,\nLucknow, Uttar Pradesh - 226001');
    expect(a).toMatch(/Gandhi Nagar/);
    expect(a).toMatch(/226001/);
    expect(a).not.toMatch(/Ram Kumar/);
  });
});
