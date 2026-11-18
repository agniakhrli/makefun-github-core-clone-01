// Git smart HTTP protocol handling (upload-pack v2, receive-pack v0, packfile parsing/generation, pkt-line handling).

import { IncomingMessage, ServerResponse } from 'node:http';
import { inflateSync, deflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { globalStore } from './store.ts';

export function encodePktLine(text: string): Buffer {
  const buf = Buffer.from(text);
  const len = buf.length + 4;
  const hex = len.toString(16).padStart(4, '0');
  return Buffer.concat([Buffer.from(hex), buf]);
}

export function encodeFlushPkt(): Buffer {
  return Buffer.from('0000');
}

export function encodeDelimiterPkt(): Buffer {
  return Buffer.from('0001');
}

export function encodePktLines(lines: string[]): Buffer {
  return Buffer.concat([...lines.map(l => encodePktLine(l)), encodeFlushPkt()]);
}

export async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

export function handleInfoRefs(req: IncomingMessage, res: ServerResponse, owner: string, repoName: string, service: string): void {
  const repo = globalStore.getRepo(owner, repoName);
  if (!repo) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Repository not found');
    return;
  }

  const refs = globalStore.listRefs(owner, repoName);

  if (service === 'git-upload-pack') {
    const protocolHeader = req.headers['git-protocol'] || '';
    if (protocolHeader.includes('version=2')) {
      const pktLines = [
        'version 2\n',
        'agent=git/2.40.0\n',
        'object-format=sha1\n',
        'ofs-delta\n',
        'shallow\n',
        'ls-refs\n',
        'fetch\n'
      ];
      const body = Buffer.concat([...pktLines.map(l => encodePktLine(l)), encodeFlushPkt()]);
      res.writeHead(200, {
        'content-type': 'application/x-git-upload-pack-advertisement',
        'cache-control': 'no-cache',
      });
      res.end(Buffer.concat([encodePktLine(`# service=${service}\n`), encodeFlushPkt(), body]));
      return;
    }

    const lines: string[] = [];
    lines.push(`# service=${service}`);
    lines.push('');
    
    if (refs.size === 0) {
      lines.push(`${'0'.repeat(40)} capabilities^{}\0multi_ack side-band-64k symref=HEAD:refs/heads/main object-format=sha1 agent=git/2.40.0`);
    } else {
      let first = true;
      for (const [refName, sha] of refs.entries()) {
        if (first) {
          lines.push(`${sha} ${refName}\0multi_ack side-band-64k symref=HEAD:refs/heads/main object-format=sha1 agent=git/2.40.0`);
          first = false;
        } else {
          lines.push(`${sha} ${refName}`);
        }
      }
    }

    const body = Buffer.concat([...lines.map(l => encodePktLine(l)), encodeFlushPkt()]);
    res.writeHead(200, {
      'content-type': 'application/x-git-upload-pack-advertisement',
      'cache-control': 'no-cache',
    });
    res.end(body);
    return;
  }

  if (service === 'git-receive-pack') {
    const lines: string[] = [];
    lines.push(`# service=${service}`);
    lines.push('');

    if (refs.size === 0) {
      lines.push(`${'0'.repeat(40)} capabilities^{}\0report-status report-status-v2 delete-refs side-band-64k object-format=sha1 agent=git/2.40.0`);
    } else {
      let first = true;
      for (const [refName, sha] of refs.entries()) {
        if (first) {
          lines.push(`${sha} ${refName}\0report-status report-status-v2 delete-refs side-band-64k object-format=sha1 agent=git/2.40.0`);
          first = false;
        } else {
          lines.push(`${sha} ${refName}`);
        }
      }
    }

    const body = Buffer.concat([...lines.map(l => encodePktLine(l)), encodeFlushPkt()]);
    res.writeHead(200, {
      'content-type': 'application/x-git-receive-pack-advertisement',
      'cache-control': 'no-cache',
    });
    res.end(body);
    return;
  }

  res.writeHead(400, { 'content-type': 'text/plain' });
  res.end('Invalid service');
}

function getPeeledOid(owner: string, repoName: string, oid: string): string | undefined {
  const obj = globalStore.getObject(owner, repoName, oid);
  if (!obj || obj.type !== 'tag') return undefined;
  const content = obj.data.toString('utf8');
  const match = content.match(/^object\s+([0-9a-f]{40})/m);
  if (match) {
    const targetOid = match[1];
    return getPeeledOid(owner, repoName, targetOid) || targetOid;
  }
  return undefined;
}

export async function handleUploadPack(req: IncomingMessage, res: ServerResponse, owner: string, repoName: string): Promise<void> {
  const body = await readBody(req);
  const repo = globalStore.getRepo(owner, repoName);
  if (!repo) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Repo not found');
    return;
  }

  const protocolHeader = req.headers['git-protocol'] || '';
  const isV2 = protocolHeader.includes('version=2') || body.toString('utf8').includes('command=');

  if (isV2) {
    let offset = 0;
    const lines: string[] = [];
    while (offset < body.length) {
      if (offset + 4 > body.length) break;
      const lenHex = body.toString('ascii', offset, offset + 4);
      if (lenHex === '0000') {
        offset += 4;
        lines.push('flush');
        continue;
      }
      if (lenHex === '0001') {
        offset += 4;
        lines.push('delim');
        continue;
      }
      const len = parseInt(lenHex, 16);
      if (isNaN(len) || len <= 4) {
        offset += 4;
        continue;
      }
      const line = body.toString('utf8', offset + 4, offset + len);
      offset += len;
      lines.push(line);
    }

    const commandLine = lines.find(l => l.startsWith('command='));
    const command = commandLine ? commandLine.slice('command='.length).trim() : '';

    if (command === 'ls-refs') {
      const wantSymrefs = lines.includes('symrefs\n') || lines.includes('symrefs');
      const wantPeel = lines.includes('peel\n') || lines.includes('peel');
      const prefixes = lines.filter(l => l.startsWith('ref-prefix ')).map(l => l.slice('ref-prefix '.length).trim());

      const refs = globalStore.listRefs(owner, repoName);
      const defaultBranch = repo.defaultBranch || 'main';
      const mainSha = refs.get(`refs/heads/${defaultBranch}`) || refs.get('refs/heads/main') || (refs.size > 0 ? refs.values().next().value : '0'.repeat(40));
      
      const allRefs = new Map(refs);
      if (!allRefs.has('HEAD')) {
        allRefs.set('HEAD', mainSha);
      }

      const pkts: Buffer[] = [];
      for (const [refName, sha] of allRefs.entries()) {
        if (prefixes.length > 0 && !prefixes.some(p => refName.startsWith(p))) {
          continue;
        }
        let line = `${sha} ${refName}`;
        if (refName === 'HEAD' && wantSymrefs) {
          line += ` symref-target:refs/heads/${defaultBranch}`;
        }
        if (wantPeel && refName.startsWith('refs/tags/')) {
          const peeled = getPeeledOid(owner, repoName, sha);
          if (peeled) {
            line += ` peeled:${peeled}`;
          }
        }
        line += '\n';
        pkts.push(encodePktLine(line));
      }
      pkts.push(encodeFlushPkt());

      res.writeHead(200, {
        'content-type': 'application/x-git-upload-pack-result',
        'cache-control': 'no-cache',
      });
      res.end(Buffer.concat(pkts));
      return;
    }

    if (command === 'fetch') {
      const packData = buildPackfileForRepo(owner, repoName);
      const pkts: Buffer[] = [];
      pkts.push(encodePktLine('acknowledgments\n'));
      pkts.push(encodePktLine('NAK\n'));
      pkts.push(encodeFlushPkt());

      pkts.push(encodePktLine('packfile\n'));
      pkts.push(encodeDelimiterPkt());
      let offsetPack = 0;
      while (offsetPack < packData.length) {
        const chunk = packData.subarray(offsetPack, offsetPack + 65519);
        offsetPack += chunk.length;
        const payload = Buffer.concat([Buffer.from([1]), chunk]);
        const pktLen = payload.length + 4;
        const hex = pktLen.toString(16).padStart(4, '0');
        pkts.push(Buffer.concat([Buffer.from(hex, 'ascii'), payload]));
      }
      pkts.push(encodeFlushPkt());
      pkts.push(Buffer.from('0002'));

      res.writeHead(200, {
        'content-type': 'application/x-git-upload-pack-result',
        'cache-control': 'no-cache',
      });
      res.end(Buffer.concat(pkts));
      return;
    }
  }

  const packData = buildPackfileForRepo(owner, repoName);

  res.writeHead(200, {
    'content-type': 'application/x-git-upload-pack-result',
    'cache-control': 'no-cache',
  });

  const pkts: Buffer[] = [];
  const nakPayload = Buffer.concat([Buffer.from([1]), Buffer.from('NAK\n')]);
  const nakLen = nakPayload.length + 4;
  pkts.push(Buffer.concat([Buffer.from(nakLen.toString(16).padStart(4, '0'), 'ascii'), nakPayload]));

  let offset = 0;
  while (offset < packData.length) {
    const chunk = packData.subarray(offset, offset + 65519);
    offset += chunk.length;
    const payload = Buffer.concat([Buffer.from([1]), chunk]);
    const pktLen = payload.length + 4;
    const hex = pktLen.toString(16).padStart(4, '0');
    pkts.push(Buffer.concat([Buffer.from(hex, 'ascii'), payload]));
  }
  pkts.push(encodeFlushPkt());

  res.end(Buffer.concat(pkts));
}

export async function handleReceivePack(req: IncomingMessage, res: ServerResponse, owner: string, repoName: string): Promise<void> {
  const body = await readBody(req);
  const repo = globalStore.getRepo(owner, repoName);
  if (!repo) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Repo not found');
    return;
  }

  let offset = 0;
  const commands: Array<{ oldOid: string; newOid: string; refName: string }> = [];
  let useSideband = false;

  while (offset < body.length) {
    if (offset + 4 > body.length) break;
    const lenHex = body.toString('ascii', offset, offset + 4);
    if (lenHex === '0000') {
      offset += 4;
      break;
    }
    const len = parseInt(lenHex, 16);
    if (isNaN(len) || len <= 4) {
      offset += 4;
      continue;
    }
    const line = body.toString('utf8', offset + 4, offset + len).trim();
    offset += len;

    const nullIdx = line.indexOf('\0');
    const cleanLine = nullIdx >= 0 ? line.slice(0, nullIdx) : line;
    if (nullIdx >= 0) {
      const caps = line.slice(nullIdx + 1);
      if (caps.includes('side-band-64k')) {
        useSideband = true;
      }
    }

    const parts = cleanLine.split(' ');
    if (parts.length === 3) {
      const [oldOid, newOid, refName] = parts;
      commands.push({ oldOid, newOid, refName });
    }
  }

  const packfileBytes = body.subarray(offset);
  const refs = globalStore.listRefs(owner, repoName);
  const results: string[] = [];
  let success = true;

  for (const cmd of commands) {
    const currentSha = refs.get(cmd.refName) || '0'.repeat(40);
    if (cmd.oldOid !== '0'.repeat(40) && currentSha !== '0'.repeat(40) && cmd.oldOid !== currentSha) {
      results.push(`ng ${cmd.refName} non-fast-forward`);
      success = false;
      continue;
    }

    if (cmd.newOid === '0'.repeat(40)) {
      refs.delete(cmd.refName);
      results.push(`ok ${cmd.refName}`);
    } else {
      globalStore.setRef(owner, repoName, cmd.refName, cmd.newOid);
      if (cmd.refName.startsWith('refs/heads/')) {
        globalStore.setRef(owner, repoName, 'HEAD', cmd.newOid);
      }
      results.push(`ok ${cmd.refName}`);
    }
  }

  if (packfileBytes.length > 32) {
    parseAndStorePackfile(owner, repoName, packfileBytes);
  }

  const reportLines = [
    `unpack ${success ? 'ok' : 'failed'}\n`,
    ...results.map(r => `${r}\n`),
  ];
  const reportBody = encodeReportLines(reportLines, useSideband);

  res.writeHead(200, {
    'content-type': 'application/x-git-receive-pack-result',
    'cache-control': 'no-cache',
  });
  res.end(reportBody);
}

function encodeReportLines(lines: string[], useSideband: boolean): Buffer {
  const pkts: Buffer[] = [];
  for (const line of lines) {
    const text = line.endsWith('\n') ? line : `${line}\n`;
    const textBuf = Buffer.from(text, 'utf8');
    const payload = useSideband ? Buffer.concat([Buffer.from([1]), textBuf]) : textBuf;
    const pktLen = payload.length + 4;
    const hex = pktLen.toString(16).padStart(4, '0');
    pkts.push(Buffer.concat([Buffer.from(hex, 'ascii'), payload]));
  }
  pkts.push(encodeFlushPkt());
  return Buffer.concat(pkts);
}

function writePackObjectHeader(type: string, size: number): Buffer {
  const code = type === 'commit' ? 1 : type === 'tree' ? 2 : type === 'blob' ? 3 : 4;
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

function buildPackfileForRepo(owner: string, repoName: string): Buffer {
  const objects = globalStore.listObjects(owner, repoName);
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);

  for (const obj of objects) {
    const data = obj.data;
    parts.push(writePackObjectHeader(obj.type, data.length));
    parts.push(deflateSync(data));
  }

  const body = Buffer.concat(parts);
  const checksum = createHash('sha1').update(body).digest();
  return Buffer.concat([body, checksum]);
}

function parseAndStorePackfile(owner: string, repoName: string, buf: Buffer): void {
  try {
    if (buf.length < 32) return;
    const magic = buf.toString('ascii', 0, 4);
    if (magic !== 'PACK') return;
    const numObjects = buf.readUInt32BE(8);
    let pos = 12;

    for (let i = 0; i < numObjects; i++) {
      if (pos >= buf.length - 20) break;
      const byte = buf[pos];
      const type = (byte >> 4) & 7;
      let size = byte & 15;
      let shift = 4;
      pos++;
      let b = byte;
      while ((b & 0x80) !== 0) {
        if (pos >= buf.length) break;
        b = buf[pos++];
        size += (b & 0x7f) << shift;
        shift += 7;
      }

      if (type === 6) {
        if (pos >= buf.length) break;
        let eb = buf[pos++];
        while ((eb & 0x80) !== 0) {
          if (pos >= buf.length) break;
          eb = buf[pos++];
        }
      } else if (type === 7) {
        pos += 20;
      }

      if (pos >= buf.length) break;

      try {
        const res = inflateSync(buf.subarray(pos), { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
        const written = res.engine.bytesWritten;
        pos += written;

        if (type >= 1 && type <= 4) {
          const typeStr = type === 1 ? 'commit' : type === 2 ? 'tree' : type === 3 ? 'blob' : 'tag';
          globalStore.storeObject(owner, repoName, typeStr, res.buffer);
        } else if (type === 6 || type === 7) {
          globalStore.storeObject(owner, repoName, 'blob', res.buffer);
        }
      } catch {
        break;
      }
    }
  } catch {}
}
