import express from 'express';
import request from 'supertest';
import { errorHandler } from '../errorHandler.js';

describe('errorHandler', () => {
  beforeEach(() => jest.spyOn(console, 'error').mockImplementation(() => undefined));
  afterEach(() => jest.restoreAllMocks());

  // Express 4 set err.status and err.statusCode to 400 on a route param it cannot decode;
  // Express 5's router sets only err.status.
  it('answers 400, not 500, for a malformed percent-encoded route param', async () => {
    const app = express();
    app.get('/x/:id', (_req, res) => {
      res.json({ ok: true });
    });
    app.use(errorHandler);
    const res = await request(app).get('/x/%E0%A4%A');
    expect(res.status).toBe(400);
    // A client error without its own code is not labelled as a server fault.
    expect(res.body.code).toBe('BAD_REQUEST');
  });
});
