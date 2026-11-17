// Arcane API helpers: config, OpenAPI index, search, describe, HTTP calls. No MCP code here so it stays testable.

const METHODS = ['get', 'post', 'put', 'patch', 'delete'];
const MAX_CHARS = 20000;

export function loadConfig(env = process.env) {
  const url = (env.ARCANE_URL || '').trim().replace(/\/+$/, '').replace(/\/api$/, '');
  if (!url) throw new Error('ARCANE_URL is required (e.g. http://localhost:3552)');
  if (!env.ARCANE_API_KEY) throw new Error('ARCANE_API_KEY is required (create one in Arcane: Settings > API Keys)');
  return {
    api: `${url}/api`,
    key: env.ARCANE_API_KEY,
    envId: env.ARCANE_ENV_ID || '0', // "0" is Arcane's local environment
    readOnly: /^(1|true|yes)$/i.test(env.ARCANE_READONLY || ''),
  };
}

// Fetches the instance's own spec once, so tools always match the running Arcane version.
export function specLoader(cfg, fetchImpl = fetch) {
  let pending;
  return () =>
    (pending ??= fetchImpl(`${cfg.api}/openapi.json`, { headers: { 'X-API-Key': cfg.key } })
      .then(async (r) => {
        if (!r.ok) throw new Error(`Cannot load ${cfg.api}/openapi.json: HTTP ${r.status}`);
        return buildIndex(await r.json());
      })
      .catch((e) => {
        pending = undefined; // retry on next call
        throw e;
      }));
}

export function buildIndex(spec) {
  const ops = [];
  for (const [path, item] of Object.entries(spec.paths || {})) {
    for (const m of METHODS) {
      const o = item[m];
      if (!o) continue;
      const params = [...(item.parameters || []), ...(o.parameters || [])].map((p) => deref(spec, p));
      ops.push({
        method: m.toUpperCase(),
        path,
        id: o.operationId || '',
        summary: o.summary || '',
        description: o.description || '',
        tag: o.tags?.[0] || '',
        params,
        body: o.requestBody && deref(spec, o.requestBody),
        responses: o.responses || {},
        text: [o.operationId, o.summary, path, ...(o.tags || [])].join(' ').toLowerCase(),
        descText: (o.description || '').toLowerCase(),
      });
    }
  }
  return { spec, ops };
}

const stem = (w) => (w.length > 3 ? w.replace(/s$/, '') : w);

export function search(index, { query = '', tag, limit = 25 } = {}) {
  let ops = index.ops;
  if (tag) ops = ops.filter((o) => o.tag.toLowerCase() === tag.toLowerCase());
  const words = query.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).map(stem);

  if (!words.length && !tag) {
    const tags = {};
    for (const o of index.ops) tags[o.tag] = (tags[o.tag] || 0) + 1;
    return `${index.ops.length} endpoints. Search with a query, or list one tag:\n` +
      Object.entries(tags).sort().map(([t, n]) => `${t || '(untagged)'} (${n})`).join(', ');
  }

  const ranked = ops
    .map((o) => {
      let hits = 0, score = 0;
      for (const w of words) {
        const s = (o.text.includes(w) ? 3 : 0) + (o.descText.includes(w) ? 1 : 0);
        if (s) hits++;
        score += s;
      }
      return { o, score: hits * 10 + score };
    })
    .filter((x) => !words.length || x.score > 0)
    .sort((a, b) => b.score - a.score || a.o.path.length - b.o.path.length);

  if (!ranked.length) return `No endpoint matches "${query}". Call arcane_search with no arguments to see the tags.`;
  const shown = ranked.slice(0, limit);
  return `${ranked.length} match(es)${ranked.length > shown.length ? `, showing ${shown.length}` : ''}:\n` +
    shown.map(({ o }) => opLine(o)).join('\n');
}

// "GET /agents/{id}/containers?search,status,limit — List containers [Containers]"
function opLine(o) {
  const q = o.params.filter((p) => p.in === 'query').map((p) => p.name);
  return `${o.method} ${o.path}${q.length ? `?${q.join(',')}` : ''}${o.body ? ' +body' : ''} — ${o.summary} [${o.tag}]`;
}

export function findOp(index, ref) {
  const m = ref.trim().match(/^(GET|POST|PUT|PATCH|DELETE)\s+(\S+)$/i);
  if (!m) return index.ops.find((o) => o.id === ref.trim());
  const method = m[1].toUpperCase();
  const path = m[2].split('?')[0].replace(/^\/api(?=\/)/, '');
  const same = index.ops.filter((o) => o.method === method);
  // Exact template first, then a concrete path such as /agents/0/containers/abc.
  return same.find((o) => o.path === path) ||
    same.find((o) => new RegExp(`^${o.path.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\{[^}]+\}/g, '[^/]+')}$`).test(path));
}

export function describe(index, ref) {
  const o = findOp(index, ref);
  if (!o) return `Unknown operation "${ref}". Use "METHOD /path" or an operationId from arcane_search.`;
  const { spec } = index;
  const out = [`${o.method} ${o.path} — ${o.summary}  (op: ${o.id}, tag: ${o.tag})`];
  if (o.description && o.description !== o.summary) out.push(oneLine(o.description, 600));
  if (o.params.length) {
    out.push('params (* = required):');
    for (const p of o.params) {
      const d = p.description ? ` — ${oneLine(p.description)}` : '';
      out.push(`  ${p.in.padEnd(6)}${p.name}${p.required ? '*' : ''}: ${typeOf(spec, p.schema, 1)}${d}`);
    }
  }
  if (o.body) {
    const [ct, media] = Object.entries(o.body.content || {})[0] || [];
    out.push(`body ${ct || ''}${o.body.required ? ' (required)' : ''}:`);
    if (media) out.push(...fieldLines(spec, media.schema));
  }
  const [code, res] = Object.entries(o.responses).find(([c]) => /^2/.test(c)) || [];
  if (code) {
    const [ct, media] = Object.entries(deref(spec, res).content || {})[0] || [];
    out.push(`returns ${code}${ct ? ` ${ct}` : ''}${media?.schema ? `: ${typeOf(spec, media.schema, 2)}` : ''}`);
  }
  return out.join('\n');
}

function deref(spec, s) {
  for (let i = 0; s?.$ref && i < 20; i++) s = s.$ref.split('/').slice(1).reduce((a, k) => a?.[k], spec);
  return s || {};
}

const oneLine = (s, max = 200) => {
  const t = String(s).replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
};

function fieldLines(spec, schema) {
  const s = deref(spec, schema);
  if (!s.properties) return [`  ${typeOf(spec, schema, 2)}`];
  const req = new Set(s.required || []);
  return Object.entries(s.properties)
    .filter(([k]) => k !== '$schema')
    .map(([k, v]) => {
      const d = v.description || deref(spec, v).description;
      return `  ${k}${req.has(k) ? '*' : ''}: ${typeOf(spec, v, 1)}${d ? ` — ${oneLine(d)}` : ''}`;
    });
}

// Compact TypeScript-like rendering of a JSON schema; `depth` limits how many object levels get expanded.
export function typeOf(spec, schema, depth, seen = new Set()) {
  if (!schema) return 'any';
  const ref = schema.$ref?.split('/').pop();
  if (ref) {
    if (seen.has(ref)) return ref;
    schema = deref(spec, schema);
    seen = new Set(seen).add(ref);
  }
  const alt = schema.oneOf || schema.anyOf;
  if (alt) return alt.map((s) => typeOf(spec, s, depth, seen)).join(' | ');
  if (schema.enum) return schema.enum.map((v) => JSON.stringify(v)).join('|');
  let t = schema.type;
  if (Array.isArray(t)) t = t.find((x) => x !== 'null') ?? 'null';
  if (t === 'array') return `${typeOf(spec, schema.items, depth, seen)}[]`;
  if (t === 'object' || schema.properties) {
    const props = Object.entries(schema.properties || {}).filter(([k]) => k !== '$schema');
    if (!props.length) return 'object';
    if (depth <= 0) return ref || 'object';
    const req = new Set(schema.required || []);
    return `{ ${props.map(([k, v]) => `${k}${req.has(k) ? '' : '?'}: ${typeOf(spec, v, depth - 1, seen)}`).join(', ')} }`;
  }
  return `${t || 'any'}${schema.format ? `<${schema.format}>` : ''}`;
}

export function fillPath(path, envId) {
  let p = String(path).trim().replace(/^\/api(?=\/)/, '');
  if (!p.startsWith('/') || p.includes('..')) throw new Error(`Invalid path "${path}": use an API path like /agents/{id}/containers`);
  p = p.replace(/^\/agents\/\{id\}(?=\/|$)/, `/agents/${encodeURIComponent(envId)}`);
  const left = p.match(/\{[^}]+\}/);
  if (left) throw new Error(`Path parameter ${left[0]} not filled: put the real value in the path (e.g. a container ID or name).`);
  return p;
}

export async function request(cfg, args, fetchImpl = fetch) {
  const { method = 'GET', path, query, body, environment, fields, max_chars: maxChars = MAX_CHARS } = args;
  const url = new URL(cfg.api + fillPath(path, environment ?? cfg.envId));
  for (const [k, v] of Object.entries(query || {})) {
    for (const x of [v].flat()) if (x !== undefined && x !== null) url.searchParams.append(k, String(x));
  }
  const headers = { 'X-API-Key': cfg.key, Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  const res = await fetchImpl(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  let out = await res.text();
  let isJson = false;
  if ((res.headers.get('content-type') || '').includes('json') && out) {
    try {
      let data = stripSchema(JSON.parse(out));
      if (fields?.length) data = pick(data, fields);
      out = JSON.stringify(data);
      isJson = true;
    } catch { /* keep raw text */ }
  }
  if (out.length > maxChars) {
    const cut = out.length - maxChars;
    // Text (logs) is most useful at the end; JSON at the start.
    out = isJson
      ? `${out.slice(0, maxChars)}\n…[truncated ${cut} of ${out.length} chars: use fields, query limit/search, or raise max_chars]`
      : `…[first ${cut} of ${out.length} chars omitted]\n${out.slice(cut)}`;
  }
  if (!out) out = `HTTP ${res.status} ${res.statusText}`.trim();
  return { ok: res.ok, text: res.ok ? out : `HTTP ${res.status} ${res.statusText}\n${out}` };
}

function stripSchema(v) {
  if (Array.isArray(v)) return v.map(stripSchema);
  if (v && typeof v === 'object') {
    const o = {};
    for (const [k, x] of Object.entries(v)) if (k !== '$schema') o[k] = stripSchema(x);
    return o;
  }
  return v;
}

// ponytail: top-level keys only; add dotted paths if agents need nested picks.
function pick(data, fields) {
  const keep = (o) => (o && typeof o === 'object' ? Object.fromEntries(fields.filter((f) => f in o).map((f) => [f, o[f]])) : o);
  if (Array.isArray(data)) return data.map(keep);
  if (data && typeof data === 'object' && 'data' in data) {
    return { ...data, data: Array.isArray(data.data) ? data.data.map(keep) : keep(data.data) };
  }
  return keep(data);
}
