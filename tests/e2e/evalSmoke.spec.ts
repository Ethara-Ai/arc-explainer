

import { test, expect } from '@playwright/test';

const BASE_URL = 'http://localhost:5000';

// ─── API Endpoint Smoke Tests ──────────────────────────────────────────────

test.describe('Eval API Endpoints', () => {
  test('GET /api/eval/games returns ARC3 game list', async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/eval/games`);
    expect(res.ok()).toBeTruthy();

    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.games).toBeDefined();
    expect(Array.isArray(json.data.games)).toBe(true);
    expect(json.data.games.length).toBeGreaterThan(0);

    // Verify known ARC3 game IDs are present
    const gameIds = json.data.games.map((g: { id: string }) => g.id);
    expect(gameIds).toContain('ct01');
    expect(gameIds).toContain('ls20');
    expect(gameIds).toContain('vc33');

    // Each game should have id, type, title
    const firstGame = json.data.games[0];
    expect(firstGame).toHaveProperty('id');
    expect(firstGame).toHaveProperty('type');
    expect(firstGame).toHaveProperty('title');
    expect(firstGame.type).toBe('arc3');
  });

  test('GET /api/eval/models returns model registry', async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/eval/models`);
    expect(res.ok()).toBeTruthy();

    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.models).toBeDefined();
    expect(Array.isArray(json.data.models)).toBe(true);
    expect(json.data.models.length).toBeGreaterThan(0);

    // Each model should have key, name, provider
    const firstModel = json.data.models[0];
    expect(firstModel).toHaveProperty('key');
    expect(firstModel).toHaveProperty('name');
    expect(firstModel).toHaveProperty('provider');
  });

  test('GET /api/eval/sessions returns session list (possibly empty)', async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/eval/sessions`);

    // May return 200 with empty array, or 500 if DB not connected — both acceptable for smoke test
    if (res.ok()) {
      const json = await res.json();
      expect(json.success).toBe(true);
      // Controller wraps in { sessions, activeSessions }
      expect(json.data).toHaveProperty('sessions');
      expect(json.data).toHaveProperty('activeSessions');
      expect(Array.isArray(json.data.sessions)).toBe(true);
      expect(Array.isArray(json.data.activeSessions)).toBe(true);
    } else {
      // DB not connected — acceptable in smoke test, just verify it's a server error not a routing error
      expect(res.status()).toBeGreaterThanOrEqual(500);
    }
  });

  test('GET /api/eval/runs returns runs list (possibly empty)', async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/eval/runs`);

    if (res.ok()) {
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data).toHaveProperty('runs');
      expect(Array.isArray(json.data.runs)).toBe(true);
    } else {
      expect(res.status()).toBeGreaterThanOrEqual(500);
    }
  });

  test('POST /api/eval/start validates required fields', async ({ request }) => {
    // Missing gameIds
    const res1 = await request.post(`${BASE_URL}/api/eval/start`, {
      data: { modelKeys: ['gpt-5.4-thinking'] },
    });
    expect(res1.status()).toBe(400);
    const json1 = await res1.json();
    expect(json1.success).toBe(false);

    // Missing modelKeys
    const res2 = await request.post(`${BASE_URL}/api/eval/start`, {
      data: { gameIds: ['ct01'] },
    });
    expect(res2.status()).toBe(400);
    const json2 = await res2.json();
    expect(json2.success).toBe(false);

    // Empty arrays
    const res3 = await request.post(`${BASE_URL}/api/eval/start`, {
      data: { gameIds: [], modelKeys: [] },
    });
    expect(res3.status()).toBe(400);

    // No body at all
    const res4 = await request.post(`${BASE_URL}/api/eval/start`, {
      data: {},
    });
    expect(res4.status()).toBe(400);
  });

  test('POST /api/eval/cancel/:id returns 404 for unknown session', async ({ request }) => {
    const res = await request.post(`${BASE_URL}/api/eval/cancel/nonexistent_session_id`);
    expect(res.status()).toBe(404);
    const json = await res.json();
    expect(json.success).toBe(false);
  });

  test('GET /api/eval/runs/:id/steps validates run ID', async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/eval/runs/nonexistent_run_id/steps`);
    // Should return 200 with empty array, or 500 if DB not connected
    if (res.ok()) {
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data).toHaveProperty('steps');
    } else {
      expect(res.status()).toBeGreaterThanOrEqual(500);
    }
  });
});

// ─── SSE Stream Endpoint ────────────────────────────────────────────────────

test.describe('Eval SSE Stream', () => {
  test('GET /api/eval/stream/:id sets SSE content-type headers', async ({ page }) => {
    // SSE endpoints keep the connection open — use page.goto with a short waitUntil
    // to verify the server responds with correct SSE headers
    const response = await page.goto(`${BASE_URL}/api/eval/stream/nonexistent_session`, {
      waitUntil: 'commit',
      timeout: 5_000,
    });

    // Should get a response (200 with SSE headers or 404)
    expect(response).not.toBeNull();
    const status = response!.status();
    if (status === 200) {
      const contentType = response!.headers()['content-type'];
      expect(contentType).toContain('text/event-stream');
    } else {
      // 404 is also acceptable (session not found)
      expect(status).toBe(404);
    }
  });
});


// ─── Data Integration Tests ─────────────────────────────────────────────────

test.describe('Eval Data Pipeline', () => {
  test('Games endpoint returns valid ARC3 game metadata', async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/eval/games`);
    const json = await res.json();
    const games = json.data.games;

    // All 9 known ARC3 games should be listed
    const expectedGames = ['ct01', 'ct03', 'ft09', 'gw01', 'gw02', 'ls20', 'vc33', 'ws03', 'ws04'];
    const gameIds = games.map((g: { id: string }) => g.id);

    for (const expected of expectedGames) {
      expect(gameIds).toContain(expected);
    }

    // All should be arc3 type
    for (const game of games) {
      expect(game.type).toBe('arc3');
    }
  });

  test('Models endpoint returns known providers', async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/eval/models`);
    const json = await res.json();
    const models = json.data.models;

    // Should have at least some well-known providers
    const providers = new Set(models.map((m: { provider: string }) => m.provider));
    expect(providers.size).toBeGreaterThan(0);

    // Each model must have non-empty key and name
    for (const model of models) {
      expect(model.key).toBeTruthy();
      expect(model.name).toBeTruthy();
      expect(model.provider).toBeTruthy();
    }
  });

  test('Health check endpoint responds', async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/health`);
    expect(res.ok()).toBeTruthy();
  });
});
