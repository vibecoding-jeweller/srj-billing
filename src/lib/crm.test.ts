import { describe, expect, it } from 'vitest';
import { daysUntilAnnual, fmtDayMonth, upcomingOccasions } from './crm';

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
