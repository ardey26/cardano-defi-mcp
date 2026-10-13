/**
 * Installs a gateway upstream from its committed lockfile (taxonomy/locks/<id>/),
 * so every package that runs — not just the top-level pin — is the one a
 * reviewer approved. `npm ci` with install scripts disabled, into a directory
 * keyed by the lockfile's hash; the bin is then run with this node, not npx.
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { parseNpxArgs } from './eligibility.js';
import { childEnv } from './upstream.js';

const run = promisify(execFile);
const INSTALL_TIMEOUT_MS = 120_000;

export interface ConnectSpec {
  command: string;
  args: string[];
}

function packageName(spec: string): string {
  return spec.slice(0, spec.lastIndexOf('@'));
}

/** The JS file behind a bin name, from the installed packages' own package.json `bin` fields. */
function resolveBin(modules: string, packages: string[], bin: string | undefined): string {
  for (const spec of packages) {
    const name = packageName(spec);
    const manifest = JSON.parse(readFileSync(join(modules, name, 'package.json'), 'utf8')) as { bin?: string | Record<string, string> };
    const wanted = bin ?? name.split('/').pop()!;
    if (typeof manifest.bin === 'string' && (bin === undefined || wanted === name.split('/').pop())) {
      return join(modules, name, manifest.bin);
    }
    if (manifest.bin && typeof manifest.bin === 'object') {
      const entries = Object.entries(manifest.bin);
      const hit = manifest.bin[wanted] ?? (bin === undefined && entries.length === 1 ? entries[0][1] : undefined);
      if (hit) return join(modules, name, hit);
    }
  }
  throw new Error(`no bin ${bin ?? '(default)'} in ${packages.join(', ')}`);
}

export async function installUpstream(id: string, connect: ConnectSpec, root: string, cacheDir: string): Promise<ConnectSpec> {
  const parsed = parseNpxArgs(connect.args);
  if (!parsed) throw new Error(`${id}: connect args are not an accepted npx command`);
  const lockDir = join(root, 'locks', id);
  const lockFile = join(lockDir, 'package-lock.json');
  if (!existsSync(lockFile)) throw new Error(`${id}: no lockfile at locks/${id}/package-lock.json`);

  const hash = createHash('sha256').update(readFileSync(lockFile)).digest('hex').slice(0, 16);
  const target = join(cacheDir, 'installs', `${id}-${hash}`);
  const modules = join(target, 'node_modules');
  if (!existsSync(modules)) {
    // Install beside the target and rename, so a crash never leaves a half-installed tree in use.
    const staging = `${target}.staging-${process.pid}-${Date.now()}`;
    mkdirSync(staging, { recursive: true });
    cpSync(join(lockDir, 'package.json'), join(staging, 'package.json'));
    cpSync(lockFile, join(staging, 'package-lock.json'));
    try {
      await run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund', '--omit=dev'], {
        cwd: staging,
        env: childEnv(cacheDir),
        timeout: INSTALL_TIMEOUT_MS,
      });
      mkdirSync(dirname(target), { recursive: true });
      if (!existsSync(modules)) renameSync(staging, target);
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  }
  return { command: process.execPath, args: [resolveBin(modules, parsed.packages, parsed.bin)] };
}
