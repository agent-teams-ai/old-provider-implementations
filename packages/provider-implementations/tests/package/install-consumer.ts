import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

export async function retainCheckedArchive(archive: string, directory?: string) {
  const bytes = await readFile(archive);
  let retainedArchive: string | undefined;
  if (directory) {
    await mkdir(resolve(directory), { recursive: true });
    retainedArchive = join(resolve(directory), basename(archive));
    await copyFile(archive, retainedArchive, constants.COPYFILE_EXCL);
  }
  return { archiveSha256: createHash('sha256').update(bytes).digest('hex'),
    archiveIntegrity: 'sha512-' + createHash('sha512').update(bytes).digest('base64'), retainedArchive };
}

export function runConsumer(args: readonly string[], cwd: string): string {
  try { return execFileSync('pnpm', args, { cwd, encoding: 'utf8', stdio: 'pipe', timeout: 55000 }); }
  catch (error) {
    const diagnostic = error as Error & { stdout?: string; stderr?: string };
    console.error(diagnostic.stdout ?? '', diagnostic.stderr ?? '');
    throw new Error(diagnostic.message, { cause: error });
  }
}

/** Actual workspace archives, never historical contract bytes or a source alias. */
export async function installPackedConsumer(root: string, sandbox: string) {
  const workspace = resolve(root, '../..');
  const roots = [root, join(workspace, 'packages/provider-session-contracts')];
  const archives = new Map<string, string>();
  for (const [index, packageRoot] of roots.entries()) {
    const destination = join(sandbox, `pack-${index}`);
    await mkdir(destination, { recursive: true });
    runConsumer(['pack', '--pack-destination', destination], packageRoot);
    const names = (await readdir(destination)).filter(name => name.endsWith('.tgz'));
    assert.equal(names.length, 1);
    const archive = join(destination, names[0]!);
    const manifest = JSON.parse(execFileSync('tar', ['-xOf', archive, 'package/package.json'], { encoding: 'utf8' })) as { name: string };
    archives.set(manifest.name, archive);
  }
  const archive = archives.get('@agent-teams/provider-implementations'); assert.ok(archive);
  const canonical = archives.get('@agent-teams/provider-session-contracts'); assert.ok(canonical);
  const packedManifest = JSON.parse(execFileSync('tar', ['-xOf', archive, 'package/package.json'], { encoding: 'utf8' })) as { dependencies: Record<string, string> };
  await writeFile(join(sandbox, 'package.json'), JSON.stringify({
    private: true, type: 'module', packageManager: 'pnpm@11.18.0',
    dependencies: { '@agent-teams/provider-implementations': `file:${archive}`, ...packedManifest.dependencies, '@agent-teams/provider-session-contracts': `file:${canonical}` },
    devDependencies: { typescript: '7.0.2', '@types/node': '24.13.3' },
  }, null, 2));
  // These are explicit isolated test archive bindings, not production delivery or registry claims.
  await writeFile(join(sandbox, 'pnpm-workspace.yaml'), `engineStrict: true\nstrictPeerDependencies: true\noverrides:\n  '@agent-teams/provider-session-contracts': 'file:${canonical}'\n`);
  runConsumer(['install', '--prefer-offline', '--ignore-scripts'], sandbox);
  const installed = JSON.parse(await readFile(join(sandbox, 'node_modules/@agent-teams/provider-session-contracts/package.json'), 'utf8')) as { name: string; exports: Record<string, unknown> };
  assert.equal(installed.name, '@agent-teams/provider-session-contracts'); assert.ok(installed.exports['.']);
  const lock = await readFile(join(sandbox, 'pnpm-lock.yaml'), 'utf8');
  for (const forbidden of ['@agent-teams/agent-execution', '@agent-teams/filesystem-custody', 'pg@', 'claude-runtime', 'link:']) {assert.ok(!lock.includes(forbidden), `forbidden consumer closure: ${forbidden}`);}
  return { archive, packageDir: join(sandbox, 'node_modules/@agent-teams/provider-implementations') };
}
