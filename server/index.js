#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';
import { loadConfig, specLoader, search, describe, request } from './arcane.js';

const cfg = loadConfig();
const index = specLoader(cfg);

const instructions = `Arcane manages Docker hosts ("environments") through a REST API with ~440 endpoints.
Workflow: arcane_search (find the endpoint) -> arcane_describe (only if you need params/body details) -> arcane_get or arcane_call.
- Environment endpoints live under /agents/{id}/... Keep "{id}" literally to target the default environment (ID "${cfg.envId}"), or pass \`environment\`. List environments: GET /agents.
- Fill every other path parameter with the real value, e.g. /agents/{id}/containers/my-nginx.
- Keep responses small: query params search/status/limit/start, and \`fields\` to keep only some keys of each item.
Common calls:
- GET /agents/{id}/containers  query {status:"running"}  fields ["id","names","image","state","status"]
- POST /agents/{id}/containers/{containerId}  query {action:"restart"}   (start|stop|restart|kill|pause|unpause)
- GET /agents/{id}/containers/{containerId}/logs/download   (returns the log tail)
- GET /agents/{id}/projects   (Compose stacks); POST /agents/{id}/projects/{projectId}/deploy
- GET /agents/{id}/images, /agents/{id}/volumes, /agents/{id}/networks${cfg.readOnly ? '\nRead-only mode: only GET requests are available.' : ''}`;

const server = new McpServer({ name: 'arcane', version: '0.1.0' }, { instructions });

const reply = (text, isError = false) => ({ content: [{ type: 'text', text }], ...(isError && { isError }) });
const guard = (fn) => async (args) => {
  try {
    return await fn(args);
  } catch (e) {
    return reply(e?.name === 'TimeoutError' ? 'Arcane did not answer within 120s.' : String(e?.message || e), true);
  }
};

const scalar = z.union([z.string(), z.number(), z.boolean()]);
const common = {
  path: z.string().describe('API path from arcane_search, e.g. /agents/{id}/containers/abc123. "{id}" after /agents is filled with the environment.'),
  query: z.record(z.string(), z.union([scalar, z.array(scalar)])).optional().describe('Query string parameters'),
  environment: z.string().optional().describe(`Environment ID for /agents/{id}/... paths (default "${cfg.envId}")`),
  max_chars: z.number().int().min(1000).max(200000).optional().describe('Response size cap (default 20000)'),
};

server.registerTool(
  'arcane_search',
  {
    title: 'Search Arcane endpoints',
    description: 'Find Arcane API endpoints by keywords (e.g. "restart container", "project deploy", "image prune"). Returns "METHOD path?queryParams — summary [tag]". No arguments lists the tags.',
    inputSchema: z.object({
      query: z.string().optional().describe('Keywords'),
      tag: z.string().optional().describe('Restrict to one tag, e.g. Containers'),
      limit: z.number().int().min(1).max(100).optional().describe('Max results (default 25)'),
    }),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  guard(async (args) => reply(search(await index(), args))),
);

server.registerTool(
  'arcane_describe',
  {
    title: 'Describe an Arcane endpoint',
    description: 'Show parameters, request body and response shape of one endpoint. Accepts "METHOD /path" (template or concrete) or an operationId.',
    inputSchema: z.object({ operation: z.string().describe('e.g. "POST /agents/{id}/projects" or "list-containers"') }),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  guard(async ({ operation }) => reply(describe(await index(), operation))),
);

server.registerTool(
  'arcane_get',
  {
    title: 'Read from Arcane',
    description: 'Send a GET request to the Arcane API and return compact JSON (or text such as logs).',
    inputSchema: z.object({
      ...common,
      fields: z.array(z.string()).optional().describe('Keep only these top-level keys of each item in `data`'),
    }),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  guard(async (args) => {
    const r = await request(cfg, { ...args, method: 'GET' });
    return reply(r.text, !r.ok);
  }),
);

if (!cfg.readOnly) {
  server.registerTool(
    'arcane_call',
    {
      title: 'Change something in Arcane',
      description: 'Send a POST, PUT, PATCH or DELETE request to the Arcane API (start/stop containers, deploy projects, prune, delete...). Check the endpoint with arcane_describe first when unsure.',
      inputSchema: z.object({
        method: z.enum(['POST', 'PUT', 'PATCH', 'DELETE']),
        ...common,
        body: z.unknown().optional().describe('JSON request body'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    guard(async (args) => {
      const r = await request(cfg, args);
      return reply(r.text, !r.ok);
    }),
  );
}

await server.connect(new StdioServerTransport());
index().catch((e) => console.error(`[arcane-mcp] ${e.message}`)); // warm the spec cache so the first tool call is fast
