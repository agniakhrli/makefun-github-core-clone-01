// Model Context Protocol (MCP) streamable HTTP handler.

import { IncomingMessage, ServerResponse } from 'node:http';
import { globalStore } from './store.ts';
import { getViewerLogin } from './wire.ts';

const TOKEN = process.env.MAKEFUN_SHOP_TOKEN || 'test-token';

export async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const requestId = Math.random().toString(36).substring(2, 15);
  res.setHeader('X-GitHub-Request-Id', requestId);
  res.setHeader('Mcp-Session-Id', 'session-123');

  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.writeHead(401, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Unauthorized' }, id: null }) + '\n');
    return;
  }

  let body: any = {};
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    }
    const text = Buffer.concat(chunks).toString('utf8');
    if (text) body = JSON.parse(text);
  } catch {
    res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null }) + '\n');
    return;
  }

  const method = body.method;
  const id = body.id !== undefined ? body.id : null;
  const params = body.params || {};

  if (method === 'initialize') {
    sendJsonRpc(res, 200, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'github-core-clone-01', version: '1.0.0' }
    }, id);
    return;
  }

  if (method === 'notifications/initialized') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end('\n');
    return;
  }

  if (method === 'tools/list') {
    sendJsonRpc(res, 200, {
      tools: [
        {
          name: 'create_repo',
          description: 'Create a repository',
          inputSchema: { type: 'object', properties: { owner: { type: 'string' }, name: { type: 'string' }, description: { type: 'string' } }, required: ['name'] }
        },
        {
          name: 'get_repo',
          description: 'Get a repository',
          inputSchema: { type: 'object', properties: { owner: { type: 'string' }, name: { type: 'string' } }, required: ['name'] }
        },
        {
          name: 'create_issue',
          description: 'Create an issue',
          inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' } }, required: ['repo', 'title'] }
        },
        {
          name: 'list_issues',
          description: 'List issues',
          inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' } }, required: ['repo'] }
        },
        {
          name: 'create_pull_request',
          description: 'Create a pull request',
          inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' }, head: { type: 'string' }, base: { type: 'string' } }, required: ['repo', 'title'] }
        },
        {
          name: 'merge_pull_request',
          description: 'Merge a pull request',
          inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, pull_number: { type: 'number' } } }
        }
      ]
    }, id);
    return;
  }

  if (method === 'tools/call') {
    const toolName = params?.name;
    const args = params?.arguments || {};
    const viewer = getViewerLogin();

    try {
      let result: any;
      if (toolName === 'create_repo') {
        result = globalStore.createRepo(args.owner || viewer, args.name, args.description || '');
      } else if (toolName === 'get_repo') {
        result = globalStore.getRepo(args.owner || viewer, args.name);
      } else if (toolName === 'create_issue') {
        result = globalStore.createIssue(args.owner || viewer, args.repo, args.title, args.body || '', viewer);
      } else if (toolName === 'list_issues') {
        result = globalStore.listIssues(args.owner || viewer, args.repo);
      } else if (toolName === 'create_pull_request') {
        result = globalStore.createPull(args.owner || viewer, args.repo, args.title || 'PR', args.body || '', args.head || 'main', args.base || 'main', viewer);
      } else if (toolName === 'merge_pull_request') {
        result = globalStore.mergePull(args.owner || viewer, args.repo, args.pull_number, args.commit_message);
      } else {
        throw new Error(`Unknown tool: ${toolName}`);
      }

      sendJsonRpc(res, 200, {
        content: [{ type: 'text', text: JSON.stringify(result) }]
      }, id);
    } catch (err: any) {
      sendJsonRpc(res, 200, {
        isError: true,
        content: [{ type: 'text', text: err.message }]
      }, id);
    }
    return;
  }

  res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32601, message: 'Method not found' }, id: null }) + '\n');
}

function sendJsonRpc(res: ServerResponse, status: number, result: any, id: any): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ jsonrpc: '2.0', result, id }) + '\n');
}
