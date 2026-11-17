# arcane-mcp

Serveur MCP pour l'API d'[Arcane](https://github.com/getarcaneapp/arcane), utilisable depuis Claude Code et Claude Desktop.

Au démarrage, il lit la spec OpenAPI de **ton** instance (`/api/openapi.json`). Les ~440 endpoints sont donc toujours à jour, sans régénérer quoi que ce soit, et l'agent ne voit que 4 outils :

| Outil | Rôle |
|---|---|
| `arcane_search` | Trouve un endpoint par mots-clés (`"restart container"`). Sans argument : liste les tags. |
| `arcane_describe` | Paramètres, corps et forme de la réponse d'un endpoint. |
| `arcane_get` | Requête GET. JSON compact, option `fields` pour ne garder que certaines clés. |
| `arcane_call` | POST / PUT / PATCH / DELETE. Absent en mode lecture seule. |

Les chemins `/agents/{id}/...` ciblent l'environnement par défaut (`ARCANE_ENV_ID`, `0` = Docker local). Les réponses sont plafonnées à 20 000 caractères : début du JSON, fin des logs.

## Configuration

| Variable | Obligatoire | Défaut |
|---|---|---|
| `ARCANE_URL` | oui | – (ex. `http://localhost:3552`) |
| `ARCANE_API_KEY` | oui | – (Arcane : Settings > API Keys) |
| `ARCANE_ENV_ID` | non | `0` |
| `ARCANE_READONLY` | non | `false` |

Node.js 20 ou plus récent.

```sh
npm install
npm test
```

## Claude Code

```sh
claude mcp add arcane --scope user \
  -e ARCANE_URL=http://localhost:3552 \
  -e ARCANE_API_KEY=arc_xxx \
  -- node /chemin/vers/arcane-mcp/server/index.js
```

Pour autoriser les lectures sans confirmation tout en gardant une validation sur les écritures, dans `~/.claude/settings.json` :

```json
{ "permissions": { "allow": ["mcp__arcane__arcane_search", "mcp__arcane__arcane_describe", "mcp__arcane__arcane_get"] } }
```

## Claude Desktop

```sh
npm install && npm run pack:mcpb
```

Ouvre `arcane-mcp.mcpb` (double-clic, ou Settings > Extensions > Install Extension) puis renseigne l'URL et la clé API. Claude Desktop fournit Node.js.
