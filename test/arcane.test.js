import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildIndex, search, describe, fillPath, request, loadConfig } from '../server/arcane.js';

const spec = {
  paths: {
    '/agents': { get: { operationId: 'list-environments', summary: 'List environments', tags: ['Environments'] } },
    '/agents/{id}/containers': {
      get: {
        operationId: 'list-containers',
        summary: 'List containers',
        tags: ['Containers'],
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: 'Environment ID' },
          { name: 'status', in: 'query', schema: { type: 'string' } },
        ],
        responses: { 200: { content: { 'application/json': { schema: { $ref: '#/components/schemas/Page' } } } } },
      },
    },
    '/agents/{id}/containers/{containerId}': {
      post: {
        operationId: 'container-action',
        summary: 'Run container lifecycle action',
        description: 'Start, stop, restart a container.',
        tags: ['Containers'],
        parameters: [{ name: 'action', in: 'query', required: true, schema: { enum: ['start', 'restart'] } }],
        requestBody: { $ref: '#/components/requestBodies/Opts' },
      },
    },
  },
  components: {
    requestBodies: { Opts: { content: { 'application/json': { schema: { type: 'object', required: ['force'], properties: { force: { type: 'boolean', description: 'Force it' } } } } } } },
    schemas: {
      Page: { type: 'object', properties: { $schema: { type: 'string' }, data: { type: ['array', 'null'], items: { $ref: '#/components/schemas/C' } } } },
      C: { type: 'object', required: ['id'], properties: { id: { type: 'string' }, self: { $ref: '#/components/schemas/C' } } },
    },
  },
};
const ix = buildIndex(spec);
const cfg = { api: 'http://arcane:3552/api', key: 'k', envId: '0' };

test('search ranks the best match first and shows query params', () => {
  const out = search(ix, { query: 'restart containers' });
  assert.match(out.split('\n')[1], /^POST \/agents\/\{id\}\/containers\/\{containerId\}\?action \+body/);
  assert.match(search(ix, { query: 'list container' }), /GET \/agents\/\{id\}\/containers\?status — List containers \[Containers\]/);
  assert.match(search(ix), /3 endpoints.*Containers \(2\), Environments \(1\)/s);
  assert.match(search(ix, { query: 'zzz' }), /No endpoint matches/);
});

test('describe renders params, body and response, from template, concrete path or operationId', () => {
  const out = describe(ix, 'post /agents/0/containers/web');
  assert.match(out, /query action\*: "start"\|"restart"/);
  assert.match(out, /force\*: boolean — Force it/);
  const list = describe(ix, 'list-containers');
  assert.match(list, /returns 200 application\/json: \{ data\?: \{ id: string, self\?: C \}\[\] \}/);
  assert.doesNotMatch(list, /\$schema/);
  assert.match(describe(ix, 'GET /nope'), /Unknown operation/);
});

test('fillPath fills the environment and rejects unfilled or unsafe paths', () => {
  assert.equal(fillPath('/agents/{id}/containers', '0'), '/agents/0/containers');
  assert.equal(fillPath('/api/agents/{id}', 'e 1'), '/agents/e%201');
  assert.throws(() => fillPath('/agents/{id}/containers/{containerId}', '0'), /\{containerId\} not filled/);
  assert.throws(() => fillPath('http://evil/x', '0'), /Invalid path/);
  assert.throws(() => fillPath('/agents/../x', '0'), /Invalid path/);
});

const fakeFetch = (status, ct, body, seen) => async (url, init) => {
  seen?.push({ url: String(url), init });
  return new Response(body, { status, headers: { 'content-type': ct } });
};

test('request builds the URL, sends the key, strips $schema and picks fields', async () => {
  const seen = [];
  const payload = JSON.stringify({ $schema: 'x', success: true, data: [{ id: 'a', names: ['/web'], labels: { big: 1 } }] });
  const r = await request(cfg, { path: '/agents/{id}/containers', query: { status: 'running', tag: ['a', 'b'] }, fields: ['id', 'names'] }, fakeFetch(200, 'application/json', payload, seen));
  assert.equal(seen[0].url, 'http://arcane:3552/api/agents/0/containers?status=running&tag=a&tag=b');
  assert.equal(seen[0].init.headers['X-API-Key'], 'k');
  assert.equal(seen[0].init.body, undefined);
  assert.deepEqual(JSON.parse(r.text), { success: true, data: [{ id: 'a', names: ['/web'] }] });
  assert.ok(r.ok);
});

test('request sends a JSON body, reports HTTP errors and keeps the tail of long text', async () => {
  const seen = [];
  const err = await request(cfg, { method: 'POST', path: '/agents/{id}/x', body: { a: 1 }, environment: '7' }, fakeFetch(404, 'application/problem+json', '{"detail":"nope"}', seen));
  assert.equal(seen[0].url, 'http://arcane:3552/api/agents/7/x');
  assert.equal(seen[0].init.body, '{"a":1}');
  assert.equal(err.ok, false);
  assert.match(err.text, /^HTTP 404.*\n\{"detail":"nope"\}$/);
  const logs = 'x'.repeat(5000) + 'LAST LINE';
  const r = await request(cfg, { path: '/logs', max_chars: 1000 }, fakeFetch(200, 'text/plain', logs));
  assert.match(r.text, /^…\[first 4009 of 5009 chars omitted\]\n/);
  assert.ok(r.text.endsWith('LAST LINE'));
});

test('loadConfig normalises the URL and requires credentials', () => {
  assert.deepEqual(loadConfig({ ARCANE_URL: 'http://h:3552/api/', ARCANE_API_KEY: 'k', ARCANE_READONLY: 'true' }), { api: 'http://h:3552/api', key: 'k', envId: '0', readOnly: true });
  assert.throws(() => loadConfig({ ARCANE_API_KEY: 'k' }), /ARCANE_URL/);
  assert.throws(() => loadConfig({ ARCANE_URL: 'http://h' }), /ARCANE_API_KEY/);
});
