// In-memory store for repositories, issues, pull requests, comments, labels, and git storage.

import { createHash } from 'node:crypto';
import { Rng, scenarioSeedFor, getTrialNow, getViewerLogin } from './wire.ts';

export interface Repo {
  id: string;
  owner: string;
  name: string;
  private: boolean;
  description: string;
  defaultBranch: string;
  createdAt: string;
}

export interface Issue {
  id: number;
  number: number;
  repoOwner: string;
  repoName: string;
  title: string;
  body: string;
  state: 'open' | 'closed';
  user: { login: string; id: number };
  labels: string[];
  createdAt: string;
  closedAt: string | null;
}

export interface Comment {
  id: number;
  issueNumber: number;
  body: string;
  user: { login: string; id: number };
  createdAt: string;
}

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string;
}

export interface PullRequest {
  id: number;
  number: number;
  repoOwner: string;
  repoName: string;
  title: string;
  body: string;
  state: 'open' | 'closed';
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
  user: { login: string; id: number };
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  files: Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }>;
}

export interface GitObject {
  type: 'commit' | 'tree' | 'blob' | 'tag';
  data: Buffer;
  sha: string;
}

export class MemoryStore {
  private rng = new Rng(scenarioSeedFor('store'));
  private repos = new Map<string, Repo>(); // key: `${owner}/${name}`
  private issues = new Map<string, Issue[]>(); // key: `${owner}/${name}`
  private issueComments = new Map<string, Comment[]>(); // key: `${owner}/${name}/${issueNumber}`
  private labels = new Map<string, Label[]>(); // key: `${owner}/${name}`
  private pulls = new Map<string, PullRequest[]>(); // key: `${owner}/${name}`
  private refs = new Map<string, Map<string, string>>(); // key: `${owner}/${name}` -> refName -> sha
  private objects = new Map<string, Map<string, GitObject>>(); // key: `${owner}/${name}` -> sha -> GitObject
  private issueCounters = new Map<string, number>(); // key: `${owner}/${name}`
  private prCounters = new Map<string, number>(); // key: `${owner}/${name}`

  constructor() {}

  // Repo methods
  public getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(`${owner.toLowerCase()}/${name.toLowerCase()}`);
  }

  public listRepos(owner?: string): Repo[] {
    const list = Array.from(this.repos.values());
    if (owner) {
      return list.filter(r => r.owner.toLowerCase() === owner.toLowerCase());
    }
    return list;
  }

  public createRepo(owner: string, name: string, description: string = '', privateRepo: boolean = false, defaultBranch: string = 'main'): Repo {
    const key = `${owner.toLowerCase()}/${name.toLowerCase()}`;
    const repo: Repo = {
      id: (this.rng.nextInt(900_000_000) + 100_000_000).toString(),
      owner,
      name,
      private: privateRepo,
      description,
      defaultBranch,
      createdAt: getTrialNow().toISOString(),
    };
    this.repos.set(key, repo);
    if (!this.refs.has(key)) this.refs.set(key, new Map());
    if (!this.objects.has(key)) this.objects.set(key, new Map());
    if (!this.issues.has(key)) this.issues.set(key, []);
    if (!this.labels.has(key)) {
      this.labels.set(key, [
        { id: this.rng.nextInt(1_000_000_000) + 1, name: 'bug', color: 'd73a4a', description: 'Something isn\'t working' },
        { id: this.rng.nextInt(1_000_000_000) + 1, name: 'enhancement', color: 'a2eeef', description: 'New feature or request' }
      ]);
    }
    if (!this.pulls.has(key)) this.pulls.set(key, []);
    this.issueCounters.set(key, 0);
    this.prCounters.set(key, 0);
    return repo;
  }

  public deleteRepo(owner: string, name: string): boolean {
    const key = `${owner.toLowerCase()}/${name.toLowerCase()}`;
    this.repos.delete(key);
    this.refs.delete(key);
    this.objects.delete(key);
    this.issues.delete(key);
    this.issueComments.delete(key);
    this.labels.delete(key);
    this.pulls.delete(key);
    this.issueCounters.delete(key);
    this.prCounters.delete(key);
    return true;
  }

  // Issue methods
  public listIssues(owner: string, name: string, state?: string, labels?: string[], sort?: string, direction?: string): Issue[] {
    const key = `${owner.toLowerCase()}/${name.toLowerCase()}`;
    let list = this.issues.get(key) || [];
    if (state && state !== 'all') {
      list = list.filter(i => i.state === state);
    }
    if (labels && labels.length > 0) {
      list = list.filter(i => labels.every(l => i.labels.includes(l)));
    }
    if (sort === 'created') {
      list = [...list].sort((a, b) => {
        const cmp = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
        if (cmp !== 0) {
          return direction === 'desc' ? -cmp : cmp;
        }
        return direction === 'desc' ? b.number - a.number : a.number - b.number;
      });
    }
    return list;
  }

  public getIssue(owner: string, name: string, number: number): Issue | undefined {
    const key = `${owner.toLowerCase()}/${name.toLowerCase()}`;
    const list = this.issues.get(key) || [];
    return list.find(i => i.number === number);
  }

  public createIssue(owner: string, name: string, title: string, body: string, userLogin: string, labels: string[] = []): Issue {
    const key = `${owner.toLowerCase()}/${name.toLowerCase()}`;
    let list = this.issues.get(key);
    if (!list) {
      list = [];
      this.issues.set(key, list);
    }
    const count = (this.issueCounters.get(key) || 0) + 1;
    this.issueCounters.set(key, count);

    const issue: Issue = {
      id: this.rng.nextInt(1_000_000_000) + 1,
      number: count,
      repoOwner: owner,
      repoName: name,
      title,
      body,
      state: 'open',
      user: { login: userLogin || getViewerLogin(), id: 1 },
      labels,
      createdAt: getTrialNow().toISOString(),
      closedAt: null,
    };
    list.push(issue);
    return issue;
  }

  public updateIssue(owner: string, name: string, number: number, update: { title?: string; body?: string; state?: 'open' | 'closed'; labels?: string[] }): Issue | undefined {
    const issue = this.getIssue(owner, name, number);
    if (!issue) return undefined;
    if (update.title !== undefined) issue.title = update.title;
    if (update.body !== undefined) issue.body = update.body;
    if (update.state !== undefined) {
      issue.state = update.state;
      issue.closedAt = update.state === 'closed' ? getTrialNow().toISOString() : null;
    }
    if (update.labels !== undefined) issue.labels = update.labels;
    return issue;
  }

  // Comments
  public listComments(owner: string, name: string, issueNumber: number): Comment[] {
    const key = `${owner.toLowerCase()}/${name.toLowerCase()}/${issueNumber}`;
    return this.issueComments.get(key) || [];
  }

  public createComment(owner: string, name: string, issueNumber: number, body: string, userLogin: string): Comment {
    const key = `${owner.toLowerCase()}/${name.toLowerCase()}/${issueNumber}`;
    let list = this.issueComments.get(key);
    if (!list) {
      list = [];
      this.issueComments.set(key, list);
    }
    const comment: Comment = {
      id: this.rng.nextInt(1_000_000_000) + 1,
      issueNumber,
      body,
      user: { login: userLogin || getViewerLogin(), id: 1 },
      createdAt: getTrialNow().toISOString(),
    };
    list.push(comment);
    return comment;
  }

  // Labels
  public listLabels(owner: string, name: string): Label[] {
    const key = `${owner.toLowerCase()}/${name.toLowerCase()}`;
    return this.labels.get(key) || [];
  }

  public createLabel(owner: string, name: string, labelName: string, color: string, description: string): Label {
    const key = `${owner.toLowerCase()}/${name.toLowerCase()}`;
    let list = this.labels.get(key);
    if (!list) {
      list = [];
      this.labels.set(key, list);
    }
    const label: Label = {
      id: this.rng.nextInt(1_000_000_000) + 1,
      name: labelName,
      color: color || 'ededed',
      description: description || '',
    };
    list.push(label);
    return label;
  }

  // Pull Requests
  public listPulls(owner: string, name: string, state?: string): PullRequest[] {
    const key = `${owner.toLowerCase()}/${name.toLowerCase()}`;
    let list = this.pulls.get(key) || [];
    if (state && state !== 'all') {
      list = list.filter(p => p.state === state);
    }
    return list;
  }

  public getPull(owner: string, name: string, number: number): PullRequest | undefined {
    const key = `${owner.toLowerCase()}/${name.toLowerCase()}`;
    const list = this.pulls.get(key) || [];
    return list.find(p => p.number === number);
  }

  public createPull(owner: string, name: string, title: string, body: string, head: string, base: string, userLogin: string): PullRequest {
    const key = `${owner.toLowerCase()}/${name.toLowerCase()}`;
    let list = this.pulls.get(key);
    if (!list) {
      list = [];
      this.pulls.set(key, list);
    }
    const count = (this.prCounters.get(key) || 0) + 1;
    this.prCounters.set(key, count);

    const refsMap = this.refs.get(key);
    const headSha = refsMap?.get(`refs/heads/${head}`) || refsMap?.get(head) || '0'.repeat(40);
    const baseSha = refsMap?.get(`refs/heads/${base}`) || refsMap?.get(base) || '0'.repeat(40);

    const pr: PullRequest = {
      id: this.rng.nextInt(1_000_000_000) + 1,
      number: count,
      repoOwner: owner,
      repoName: name,
      title,
      body,
      state: 'open',
      head: { ref: head, sha: headSha },
      base: { ref: base, sha: baseSha },
      user: { login: userLogin || getViewerLogin(), id: 1 },
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      files: [{ filename: 'README.md', status: 'modified', additions: 1, deletions: 1, changes: 2 }],
    };
    list.push(pr);
    return pr;
  }

  public updatePull(owner: string, name: string, number: number, update: { title?: string; body?: string; state?: 'open' | 'closed' }): PullRequest | undefined {
    const pr = this.getPull(owner, name, number);
    if (!pr) return undefined;
    if (update.title !== undefined) pr.title = update.title;
    if (update.body !== undefined) pr.body = update.body;
    if (update.state !== undefined) {
      pr.state = update.state;
    }
    return pr;
  }

  public mergePull(owner: string, name: string, number: number, message?: string): { merged: boolean; sha: string; message: string } | undefined {
    const pr = this.getPull(owner, name, number);
    if (!pr || pr.state !== 'open' || pr.merged) return undefined;
    const key = `${owner.toLowerCase()}/${name.toLowerCase()}`;
    const refsMap = this.refs.get(key);
    const sha = pr.head.sha;

    pr.merged = true;
    pr.state = 'closed';
    pr.mergedAt = getTrialNow().toISOString();
    pr.mergeCommitSha = sha;

    if (refsMap) {
      const baseRef = `refs/heads/${pr.base.ref}`;
      refsMap.set(baseRef, sha);
      refsMap.set('HEAD', sha);
    }

    return { merged: true, sha, message: message || `Merged PR #${number}` };
  }

  // Git Object & Ref methods
  public getRef(owner: string, name: string, ref: string): string | undefined {
    const key = `${owner.toLowerCase()}/${name.toLowerCase()}`;
    const refsMap = this.refs.get(key);
    if (!refsMap) return undefined;
    return refsMap.get(ref);
  }

  public setRef(owner: string, name: string, ref: string, sha: string): void {
    const key = `${owner.toLowerCase()}/${name.toLowerCase()}`;
    let refsMap = this.refs.get(key);
    if (!refsMap) {
      refsMap = new Map();
      this.refs.set(key, refsMap);
    }
    refsMap.set(ref, sha);
  }

  public listRefs(owner: string, name: string): Map<string, string> {
    const key = `${owner.toLowerCase()}/${name.toLowerCase()}`;
    return this.refs.get(key) || new Map();
  }

  public getObject(owner: string, name: string, sha: string): GitObject | undefined {
    const key = `${owner.toLowerCase()}/${name.toLowerCase()}`;
    const objsMap = this.objects.get(key);
    if (!objsMap) return undefined;
    return objsMap.get(sha);
  }

  public listObjects(owner: string, name: string): GitObject[] {
    const key = `${owner.toLowerCase()}/${name.toLowerCase()}`;
    const objsMap = this.objects.get(key);
    if (!objsMap) return [];
    return Array.from(objsMap.values());
  }

  public storeObject(owner: string, name: string, type: 'commit' | 'tree' | 'blob' | 'tag', data: Buffer): string {
    const key = `${owner.toLowerCase()}/${name.toLowerCase()}`;
    let objsMap = this.objects.get(key);
    if (!objsMap) {
      objsMap = new Map();
      this.objects.set(key, objsMap);
    }
    const header = Buffer.from(`${type} ${data.length}\0`);
    const storeBuffer = Buffer.concat([header, data]);
    const sha = createHash('sha1').update(storeBuffer).digest('hex');
    objsMap.set(sha, { type, data, sha });
    return sha;
  }
}

export const globalStore = new MemoryStore();
