import { describe, expect, it } from 'vitest';
import { daysUntilAnnual, fmtDayMonth, upcomingOccasions } from './crm';
import { customersCsv, CUSTOMER_SHEET_HEADER } from './crm';

describe('birthdays and anniversaries', () => {
  it('shows day and month', () => {
    expect(fmtDayMonth('10-25')).toBe('25 October');
    expect(fmtDayMonth('1998-02-03')).toBe('3 February');
    expect(fmtDayMonth('')).toBe('');
  });
  it('counts days to the next yearly date', () => {
    expect(daysUntilAnnual('1990-10-17', '2026-10-17')).toBe(0);
    expect(daysUntilAnnual('1990-10-20', '2026-10-17')).toBe(3);
    expect(daysUntilAnnual('1990-10-16', '2026-10-17')).toBe(364); // just passed: next year
    expect(daysUntilAnnual('1985-01-02', '2026-12-30')).toBe(3); // across the new year
    expect(daysUntilAnnual('', '2026-10-17')).toBeNull();
    expect(daysUntilAnnual('10-25', '2026-10-23')).toBe(2); // stored as day + month only
    expect(daysUntilAnnual('01-01', '2026-12-31')).toBe(1);
  });
  it('lists only the next 7 days, soonest first', () => {
    const list = upcomingOccasions(
      [
        { id: 1, name: 'Shruti', mobile: '7060329291', dob: '1998-10-20', anniversary: '' },
        { id: 2, name: 'Lakhmichand', mobile: '9027515504', dob: '1970-12-01', anniversary: '1995-10-17' },
        { id: 3, name: 'Asha', mobile: '9000000000', dob: '', anniversary: '' },
      ],
      '2026-10-17',
    );
    expect(list.map((o) => [o.name, o.kind, o.inDays])).toEqual([
      ['Lakhmichand', 'Anniversary', 0],
      ['Shruti', 'Birthday', 3],
    ]);
  });
});

describe('customer sheet', () => {
  const base = {
    name: 'Shruti Mohan', relation: 'D/o', relativeName: 'Sanjay', mobile: '9027515504', otherMobile: '', address: 'Lal Kuan,\nBulandshahr',
    state: 'Uttar Pradesh', pan: '', dob: '03-12', anniversary: '', notes: 'likes "payal"', bills: 2, estimates: 3, paid: 12345600,
    lastVisit: '2026-11-05', createdAt: '2026-10-01 10:00:00',
  };
  it('writes an Excel-friendly CSV with every customer', () => {
    const csv = customersCsv([base, { ...base, name: 'राम', mobile: '9000000001', otherMobile: '9000000002', paid: 0, lastVisit: null }]);
    expect(csv.startsWith('\uFEFF')).toBe(true);
    const lines = csv.slice(1).trimEnd().split('\r\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe(CUSTOMER_SHEET_HEADER.join(','));
    expect(lines[1]).toBe('Shruti Mohan,D/o,Sanjay,"=""9027515504""",,"Lal Kuan, Bulandshahr",Uttar Pradesh,,12 March,,2,3,123456.00,2026-11-05,2026-10-01,"likes ""payal"""');
    expect(lines[2]).toContain('राम');
    expect(lines[2]).toContain(',0.00,,2026-10-01,');
  });
});
