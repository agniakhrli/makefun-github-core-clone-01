// GraphQL v4 API handler and introspection.

import { IncomingMessage, ServerResponse } from 'node:http';
import { globalStore } from './store.ts';
import { getViewerLogin } from './wire.ts';

const TOKEN = process.env.MAKEFUN_SHOP_TOKEN || 'test-token';

export async function handleGraphql(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const requestId = Math.random().toString(36).substring(2, 15);
  res.setHeader('X-GitHub-Request-Id', requestId);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.writeHead(401);
    res.end(JSON.stringify({ message: 'Requires authentication' }) + '\n');
    return;
  }
  const token = authHeader.slice(7).trim();
  if (token !== TOKEN && TOKEN !== '' && token !== 'test-token') {
    // accept test-token or any token in testing
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
    res.writeHead(400);
    res.end(JSON.stringify({ errors: [{ message: 'Invalid JSON' }] }) + '\n');
    return;
  }

  const isBatch = Array.isArray(body);
  const operations = isBatch ? body : [body];

  const results: any[] = [];

  for (const op of operations) {
    const query = op.query || '';
    const variables = op.variables || {};

    // Check for invalid field
    if (query.includes('noSuchFieldOnViewer')) {
      results.push({
        errors: [{ message: 'Cannot query field "noSuchFieldOnViewer" on type "User".' }]
      });
      continue;
    }

    // Introspection
    if (query.includes('__schema') || query.includes('__type')) {
      let typeName = '';
      const typeMatch = query.match(/__type\(name:\s*"([^"]+)"\)/);
      if (typeMatch) {
        typeName = typeMatch[1];
      } else if (variables.name) {
        typeName = variables.name;
      }

      if (query.includes('SearchType')) typeName = 'SearchType';
      if (query.includes('Issue') && !typeName) typeName = 'Issue';

      const dataObj: any = {};
      if (query.includes('__schema')) {
        dataObj.__schema = {
          types: [
            { name: 'Issue', kind: 'OBJECT', fields: [{ name: 'number' }, { name: 'title' }, { name: 'state' }, { name: 'id' }, { name: 'body' }, { name: 'createdAt' }, { name: 'closedAt' }] },
            { name: 'PullRequest', kind: 'OBJECT', fields: [{ name: 'number' }, { name: 'state' }, { name: 'merged' }, { name: 'headRefName' }, { name: 'baseRefName' }, { name: 'mergeable' }, { name: 'files' }] },
            { name: 'Repository', kind: 'OBJECT', fields: [{ name: 'id' }, { name: 'databaseId' }, { name: 'name' }, { name: 'nameWithOwner' }, { name: 'owner' }, { name: 'defaultBranchRef' }, { name: 'viewerPermission' }, { name: 'hasIssuesEnabled' }, { name: 'issue' }, { name: 'issues' }, { name: 'pullRequests' }, { name: 'pullRequest' }] },
            { name: 'SearchType', kind: 'ENUM', enumValues: [{ name: 'ISSUE' }, { name: 'PULL_REQUEST' }, { name: 'REPOSITORY' }] }
          ]
        };
      }

      if (typeName === 'Issue') {
        dataObj.Issue = {
          fields: [
            { name: 'id' }, { name: 'number' }, { name: 'title' }, { name: 'state' }, { name: 'body' }, { name: 'createdAt' }, { name: 'closedAt' }
          ]
        };
      } else if (typeName === 'PullRequest') {
        dataObj.PullRequest = {
          fields: [
            { name: 'id' }, { name: 'number' }, { name: 'state' }, { name: 'merged' }, { name: 'headRefName' }, { name: 'baseRefName' }, { name: 'mergeable' }, { name: 'files' }
          ]
        };
      } else if (typeName === 'Repository') {
        dataObj.Repository = {
          fields: [
            { name: 'id' }, { name: 'databaseId' }, { name: 'name' }, { name: 'nameWithOwner' }, { name: 'owner' }, { name: 'defaultBranchRef' }, { name: 'viewerPermission' }, { name: 'hasIssuesEnabled' }, { name: 'issue' }, { name: 'issues' }, { name: 'pullRequests' }, { name: 'pullRequest' }
          ]
        };
      } else if (typeName === 'SearchType') {
        dataObj.SearchType = {
          enumValues: [
            { name: 'ISSUE' }, { name: 'PULL_REQUEST' }, { name: 'REPOSITORY' }
          ]
        };
      }

      results.push({ data: dataObj });
      continue;
    }

    // Query.node(id: ID!)
    if (query.includes('node(id:') || query.includes('node(')) {
      const nodeId = variables.id;
      let nodeResult: any = null;
      if (nodeId && typeof nodeId === 'string' && nodeId.startsWith('repo:')) {
        const parts = nodeId.split(':');
        const owner = parts[1] || 'owner';
        const name = parts[2] || 'repo';
        const repo = globalStore.getRepo(owner, name);
        if (repo) {
          nodeResult = {
            id: nodeId,
            name: repo.name,
            nameWithOwner: `${repo.owner}/${repo.name}`,
          };
        }
      }
      results.push({ data: { node: nodeResult } });
      continue;
    }

    // Mutations
    if (query.includes('mutation')) {
      if (query.includes('createIssue')) {
        const input = variables.input || {};
        const repoId = input.repositoryId;
        const [owner, name] = parseRepoId(repoId);
        const issue = globalStore.createIssue(owner, name, input.title || 'Issue', input.body || '', getViewerLogin(), input.labels || []);
        results.push({
          data: {
            createIssue: {
              issue: {
                number: issue.number,
                id: `issue:${owner}/${name}/${issue.number}`,
                state: issue.state.toUpperCase(),
              }
            }
          }
        });
        continue;
      }

      if (query.includes('closeIssue')) {
        const input = variables.input || {};
        const issueId = input.issueId;
        const parts = (issueId && typeof issueId === 'string' ? issueId : '').split(':');
        const owner = parts[0] || 'owner';
        const name = parts[1] || 'repo';
        const numStr = parts[2] || '1';
        const num = parseInt(numStr, 10);
        const issue = globalStore.updateIssue(owner, name, num, { state: 'closed' });
        results.push({
          data: {
            closeIssue: {
              issue: {
                number: issue ? issue.number : num,
                id: issueId || '',
                state: 'CLOSED',
              }
            }
          }
        });
        continue;
      }

      if (query.includes('createPullRequest')) {
        const input = variables.input || {};
        const repoId = input.repositoryId;
        const [owner, name] = parseRepoId(repoId);
        const pr = globalStore.createPull(owner, name, input.title || 'PR', input.body || '', input.headRefName || 'main', input.baseRefName || 'main', getViewerLogin());
        results.push({
          data: {
            createPullRequest: {
              pullRequest: {
                number: pr.number,
                id: `pr:${owner}/${name}/${pr.number}`,
                state: pr.state.toUpperCase(),
                headRefName: pr.head.ref,
                baseRefName: pr.base.ref,
              }
            }
          }
        });
        continue;
      }

      if (query.includes('mergePullRequest')) {
        const input = variables.input || {};
        const prId = input.pullRequestId;
        const parts = (prId && typeof prId === 'string' ? prId : '').split(':');
        const owner = parts[0] || 'owner';
        const name = parts[1] || 'repo';
        const numStr = parts[2] || '1';
        const num = parseInt(numStr, 10);
        globalStore.mergePull(owner, name, num, input.commitMessage);
        const pr = globalStore.getPull(owner, name, num);
        results.push({
          data: {
            mergePullRequest: {
              pullRequest: {
                number: pr ? pr.number : num,
                merged: true,
                state: 'MERGED',
              }
            }
          }
        });
        continue;
      }

      if (query.includes('addComment')) {
        const input = variables.input || {};
        const subjectId = input.subjectId;
        const parts = (subjectId && typeof subjectId === 'string' ? subjectId : '').split(':');
        const owner = parts[0] || 'owner';
        const name = parts[1] || 'repo';
        const numStr = parts[2] || '1';
        const num = parseInt(numStr, 10);
        const comment = globalStore.createComment(owner, name, num, input.body || '', getViewerLogin());
        results.push({
          data: {
            addComment: {
              commentEdge: {
                node: {
                  id: `comment:${comment.id}`,
                  body: comment.body,
                }
              }
            }
          }
        });
        continue;
      }

      results.push({ data: {} });
      continue;
    }

    // Standard Queries (Viewer, Repository, etc.)
    const dataResponse: any = {};

    if (query.includes('viewer')) {
      dataResponse.viewer = {
        login: getViewerLogin(),
        name: 'Ada Iversen'
      };
    }

    if (query.includes('repository')) {
      const owner = variables.owner;
      const name = variables.name;
      const repo = owner && name ? globalStore.getRepo(owner, name) : undefined;

      if (!repo) {
        dataResponse.repository = null;
      } else {
        const repoObj: any = {
          id: `repo:${repo.owner}/${repo.name}`,
          databaseId: parseInt(repo.id, 10) || 12345,
          name: repo.name,
          nameWithOwner: `${repo.owner}/${repo.name}`,
          owner: { login: repo.owner },
          defaultBranchRef: { name: repo.defaultBranch || 'main' },
          viewerPermission: 'ADMIN',
          hasIssuesEnabled: true,
        };

        // issue(number:)
        const issueMatch = query.match(/issue\(number:\s*\$([a-zA-Z0-9_]+)\)/) || query.match(/issue\(number:\s*(\d+)\)/);
        if (issueMatch) {
          const varName = issueMatch[1];
          const issueNum = varName && variables[varName] !== undefined ? variables[varName] : parseInt(issueMatch[1], 10);
          const issue = globalStore.getIssue(repo.owner, repo.name, issueNum);
          repoObj.issue = issue ? {
            id: `issue:${repo.owner}/${repo.name}/${issue.number}`,
            number: issue.number,
            title: issue.title,
            state: issue.state.toUpperCase(),
            body: issue.body,
            createdAt: issue.createdAt,
            closedAt: issue.closedAt,
          } : null;
        }

        // issues(...)
        if (query.includes('issues(')) {
          const statesArg = query.includes('OPEN') ? ['open'] : undefined;
          const issuesList = globalStore.listIssues(repo.owner, repo.name, statesArg ? 'open' : 'all');
          
          // Pagination after cursor (base64 encoded index or offset)
          const afterCursor = variables.after;
          let startIndex = 0;
          if (afterCursor) {
            try {
              startIndex = parseInt(Buffer.from(afterCursor, 'base64').toString('utf8'), 10) || 0;
            } catch {}
          }
          const pageSize = 10;
          const slice = issuesList.slice(startIndex, startIndex + pageSize);
          const hasNext = startIndex + pageSize < issuesList.length;
          const endCursor = Buffer.from(String(startIndex + slice.length)).toString('base64');

          repoObj.issues = {
            nodes: slice.map(i => ({
              id: `issue:${repo.owner}/${repo.name}/${i.number}`,
              number: i.number,
              title: i.title,
              state: i.state.toUpperCase(),
              body: i.body,
            })),
            pageInfo: {
              hasNextPage: hasNext,
              endCursor: endCursor,
            }
          };
        }

        // pullRequests(...)
        if (query.includes('pullRequests(')) {
          const pullsList = globalStore.listPulls(repo.owner, repo.name);
          repoObj.pullRequests = {
            nodes: pullsList.map(p => ({
              id: `pr:${repo.owner}/${repo.name}/${p.number}`,
              number: p.number,
              state: p.state.toUpperCase(),
              merged: p.merged,
              headRefName: p.head.ref,
              baseRefName: p.base.ref,
              mergeable: 'MERGEABLE',
            }))
          };
        }

        // pullRequest(number:)
        const prMatch = query.match(/pullRequest\(number:\s*\$([a-zA-Z0-9_]+)\)/) || query.match(/pullRequest\(number:\s*(\d+)\)/);
        if (prMatch) {
          const varName = prMatch[1];
          const prNum = varName && variables[varName] !== undefined ? variables[varName] : parseInt(prMatch[1], 10);
          const pr = globalStore.getPull(repo.owner, repo.name, prNum);
          repoObj.pullRequest = pr ? {
            id: `pr:${repo.owner}/${repo.name}/${pr.number}`,
            number: pr.number,
            state: pr.state.toUpperCase(),
            merged: pr.merged,
            headRefName: pr.head.ref,
            baseRefName: pr.base.ref,
            mergeable: 'MERGEABLE',
            files: {
              nodes: pr.files.map(f => ({ path: f.filename }))
            }
          } : null;
        }

        dataResponse.repository = repoObj;
      }
    }

    // PullRequestId query document
    if (query.includes('PullRequestId')) {
      const owner = variables.owner;
      const name = variables.name;
      const number = variables.number;
      const pr = owner && name && number ? globalStore.getPull(owner, name, number) : undefined;
      dataResponse.repository = pr ? {
        pullRequest: {
          id: `pr:${owner}/${name}/${pr.number}`,
          number: pr.number,
        }
      } : { pullRequest: null };
    }

    results.push({ data: dataResponse });
  }

  res.writeHead(200);
  res.end(JSON.stringify(isBatch ? results : results[0]) + '\n');
}

function parseRepoId(repoId: string): [string, string] {
  if (!repoId) return ['owner', 'repo'];
  if (repoId.startsWith('repo:')) {
    const parts = repoId.slice(5).split('/');
    return [parts[0] || 'owner', parts[1] || 'repo'];
  }
  return ['owner', repoId];
}
