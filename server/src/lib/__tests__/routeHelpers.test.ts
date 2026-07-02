import { parsePagination, paginated } from '../routeHelpers.js';

describe('parsePagination', () => {
  it('defaults to page 1 and the given default limit', () => {
    expect(parsePagination({})).toEqual({ page: 1, limit: 10, skip: 0, take: 10 });
    expect(parsePagination({}, 25)).toEqual({ page: 1, limit: 25, skip: 0, take: 25 });
  });

  it('computes skip from page/limit', () => {
    expect(parsePagination({ page: '3', limit: '20' })).toEqual({
      page: 3,
      limit: 20,
      skip: 40,
      take: 20,
    });
  });

  it('clamps a non-positive page up to 1 and falls back on garbage', () => {
    expect(parsePagination({ page: '0' }).page).toBe(1);
    expect(parsePagination({ page: 'x', limit: 'y' }, 15)).toEqual({
      page: 1,
      limit: 15,
      skip: 0,
      take: 15,
    });
  });
});

describe('paginated', () => {
  it('shapes { data, pagination } with ceil totalPages', () => {
    expect(paginated([1, 2], 21, 2, 10)).toEqual({
      data: [1, 2],
      pagination: { page: 2, limit: 10, total: 21, totalPages: 3 },
    });
  });
});
