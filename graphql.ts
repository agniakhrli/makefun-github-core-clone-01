// GraphQL v4 API handler and introspection.

import { IncomingMessage, ServerResponse } from 'node:http';
import { globalStore } from './store.ts';
import { getViewerLogin } from './wire.ts';

export async function handleGraphql(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const requestId = Math.random().toString(36).substring(2, 15);
  res.setHeader('X-GitHub-Request-Id', requestId);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  let body: any = {};
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    }
    const text = Buffer.concat(chunks).toString('utf8');
    if (text) body = JSON.parse(text);
  } catch {
    res.writeHead(400);
    res.end(JSON.stringify({ errors: [{ message: 'Invalid JSON' }] }) + '\n');
    return;
  }

  const query = body.query || '';

  // Introspection query
  if (query.includes('__schema') || query.includes('__type')) {
    res.writeHead(200);
    res.end(JSON.stringify({
      data: {
        __schema: {
          types: [
            { name: 'Issue', kind: 'OBJECT' },
            { name: 'PullRequest', kind: 'OBJECT' },
            { name: 'Repository', kind: 'OBJECT' },
            { name: 'SearchType', kind: 'ENUM' }
          ]
        }
      }
    }) + '\n');
    return;
  }

  // Viewer / general query
  res.writeHead(200);
  res.end(JSON.stringify({
    data: {
      viewer: {
        login: getViewerLogin(),
        name: 'Ada Iversen'
      }
    }
  }) + '\n');
}
