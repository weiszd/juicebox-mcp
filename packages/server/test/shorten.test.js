/**
 * POST /shorten: the page's Share button shortening through the Worker (ticket 31).
 */
import { SELF, env, createExecutionContext } from 'cloudflare:test';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { ORIGIN } from './pages.js';
import worker from '../src/index.js';

afterEach(() => vi.restoreAllMocks());

const LONG = `${ORIGIN}/?session=blob:abc123`;

function shorten(url, { origin = ORIGIN, vars } = {}) {
  const request = new Request('https://jbmcp.test/shorten', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) },
    body: JSON.stringify({ url }),
  });
  return vars ? worker.fetch(request, { ...env, ...vars }, createExecutionContext()) : SELF.fetch(request);
}

describe('POST /shorten', () => {
  it('shortens a page\'s own link with TinyURL and answers in TinyURL\'s shape, CORS for that origin', async () => {
    const tinyurl = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ data: { tiny_url: 'https://t.3dg.io/xyz' } }));

    const res = await shorten(LONG, { vars: { TINYURL_API_KEY: 'test-key' } });

    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
    expect(await res.json()).toEqual({ data: { tiny_url: 'https://t.3dg.io/xyz' } });
    expect(tinyurl).toHaveBeenCalledOnce();
    const [endpoint, init] = tinyurl.mock.calls[0];
    expect(endpoint).toBe('https://api.tinyurl.com/create');
    expect(init.headers.Authorization).toBe('Bearer test-key');
    expect(JSON.parse(init.body)).toEqual({ url: LONG, domain: 't.3dg.io' });
  });

  it('without a TinyURL key answers with the long link', async () => {
    const tinyurl = vi.spyOn(globalThis, 'fetch');

    const res = await shorten(LONG, { vars: { TINYURL_API_KEY: undefined } });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { tiny_url: LONG } });
    expect(tinyurl).not.toHaveBeenCalled();
  });

  it('refuses an origin that is not on ALLOWED_ORIGINS, and a missing one', async () => {
    expect((await shorten(LONG, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await shorten(LONG, { origin: null })).status).toBe(403);
  });

  it('refuses a link to another origin: not an open shortener', async () => {
    const res = await shorten('https://example.com/anything');

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/requesting origin/);
  });

  it('refuses a body without an absolute url', async () => {
    expect((await shorten('?session=blob:abc')).status).toBe(400);
  });

  it('answers the CORS preflight for an allowed origin only', async () => {
    const preflight = (origin) => SELF.fetch('https://jbmcp.test/shorten', {
      method: 'OPTIONS',
      headers: { Origin: origin, 'Access-Control-Request-Method': 'POST' },
    });

    const ok = await preflight(ORIGIN);
    expect(ok.status).toBe(204);
    expect(ok.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
    expect(ok.headers.get('Access-Control-Allow-Methods')).toContain('POST');
    expect((await preflight('https://evil.example')).status).toBe(403);
  });

  it('reports a TinyURL failure as 502 rather than a long link', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"errors":["Unauthenticated."]}', { status: 401, statusText: 'Unauthorized' }));

    const res = await shorten(LONG, { vars: { TINYURL_API_KEY: 'bad-key' } });

    expect(res.status).toBe(502);
  });
});
