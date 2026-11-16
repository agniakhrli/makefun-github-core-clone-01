// Main server application routing all surfaces (healthz, REST v3, GraphQL v4, MCP, and Git smart HTTP).

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleRest } from './rest.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleInfoRefs, handleUploadPack, handleReceivePack } from './git.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  const requestId = Math.random().toString(36).substring(2, 15);
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'X-GitHub-Request-Id': requestId,
    ...headers
  });
  res.end(text);
}

function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

export function createApp(): Server {
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host || 'localhost'}`);
    const path = url.pathname;
    const method = req.method ?? 'GET';

    // 1. Health probe
    if (method === 'GET' && path === '/healthz') {
      sendJson(res, 200, { ok: true });
      return;
    }

    // 2. REST v3 API root
    if (path.startsWith('/api/v3')) {
      handleRest(req, res, url, method);
      return;
    }

    // 3. GraphQL v4 API
    if (path === '/api/graphql') {
      await handleGraphql(req, res);
      return;
    }

    // 4. MCP endpoint
    if (path === '/mcp') {
      await handleMcp(req, res);
      return;
    }

    // 5. Git Smart HTTP (`/{owner}/{repo}.git/...`)
    const gitMatch = path.match(/^\/([^/]+)\/([^/]+)\.git(.*)$/);
    if (gitMatch) {
      const [, owner, repoName, gitSubPath] = gitMatch;
      const service = url.searchParams.get('service');

      if (gitSubPath === '/info/refs' && service) {
        handleInfoRefs(req, res, owner, repoName, service);
        return;
      }
      if (gitSubPath === '/git-upload-pack') {
        await handleUploadPack(req, res, owner, repoName);
        return;
      }
      if (gitSubPath === '/git-receive-pack') {
        await handleReceivePack(req, res, owner, repoName);
        return;
      }
    }

    // 6. Not Found fallback
    const requestId = Math.random().toString(36).substring(2, 15);
    res.writeHead(404, {
      'content-type': JSON_TYPE,
      'X-GitHub-Request-Id': requestId,
    });
    res.end(JSON.stringify({ message: 'Not Found' }) + '\n');
  });
}
