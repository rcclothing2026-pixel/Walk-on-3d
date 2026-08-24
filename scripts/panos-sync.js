#!/usr/bin/env node
/**
 * Syncs generated panoramas into the panos repository.
 *
 * The renditions in panos/<slug>/ are rebuildable, so the main repo ignores
 * them — but they still need versioning and somewhere to be uploaded from.
 * That is what the separate panos repository is for: one commit per pipeline
 * run, nothing else ever mixed in.
 *
 * Nothing here is clever: files are compared by size and mtime, copied when
 * they differ, and anything on the far side that this side no longer has
 * (renditions of removed nodes, macOS droppings) is reported. The manifest
 * travels with them, because the viewer reads it to decide upgrades.
 *
 * Usage:
 *   npm run panos-sync                       copy what differs, report the rest
 *   npm run panos-sync -- --check            report only, change nothing
 *   npm run panos-sync -- --commit "message" copy, then git-commit the target
 *
 * The target directory comes from WALK_PANOS_REPO, or sits beside this repo
 * under its default name.
 */

import { access, copyFile, mkdir, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = path.join(ROOT, 'panos');

/** Files that are never content, wherever they turn up. */
const JUNK = new Set(['.DS_Store', '._.DS_Store']);
const isJunk = (name) => JUNK.has(name) || name.startsWith('._');

main().catch((err) => {
  console.error(`panos-sync failed: ${err.message}`);
  process.exitCode = 1;
});

async function main() {
  const argv = process.argv.slice(2);
  const check = argv.includes('--check');
  const commitIndex = argv.indexOf('--commit');
  const commitMessage = commitIndex >= 0 ? argv[commitIndex + 1] : null;

  const targetRoot = process.env.WALK_PANOS_REPO
    ? path.resolve(process.env.WALK_PANOS_REPO)
    : path.resolve(ROOT, '..', 'Walk-on-3d-panos');

  if (!(await exists(SOURCE))) {
    console.error(`Nothing to sync — ${path.relative(ROOT, SOURCE)} does not exist.`);
    console.error('Run `npm run process` first.');
    process.exitCode = 1;
    return;
  }

  if (!(await exists(targetRoot))) {
    console.error(
      `The panos repository was not found at ${targetRoot}.\n` +
        'Set WALK_PANOS_REPO to its location, or clone it beside this repo.',
    );
    process.exitCode = 1;
    return;
  }

  const plan = await compare(SOURCE, targetRoot);

  if (!plan.copied.length && !plan.deleted.length && !plan.conflicts.length) {
    console.log('Panos repository is up to date.');
    return;
  }

  for (const file of plan.copied) console.log(`  ${check ? 'would copy' : 'copy '} ${file}`);
  for (const file of plan.deleted) console.log(`  ${check ? 'would remove' : 'remove'} ${file}`);
  for (const file of plan.conflicts) console.log(`  conflict (source missing): ${file}`);

  if (check) {
    console.log(
      `\n${plan.copied.length + plan.deleted.length} change(s) pending. Run without --check to apply.`,
    );
    return;
  }

  for (const rel of plan.copied) {
    const from = path.join(SOURCE, rel);
    const to = path.join(targetRoot, rel);
    await mkdir(path.dirname(to), { recursive: true });
    await copyFile(from, to);
  }
  for (const rel of [...plan.deleted, ...plan.conflicts]) {
    await rm(path.join(targetRoot, rel), { force: true });
  }

  const applied = plan.copied.length + plan.deleted.length + plan.conflicts.length;
  console.log(`${applied} change(s) written to ${targetRoot}.`);

  if (commitMessage) await commitTarget(targetRoot, commitMessage);
}

/** Walks both trees, pairing every file the source owns. */
async function compare(sourceRoot, targetRoot) {
  const sourceFiles = await walk(sourceRoot);
  const targetFiles = new Set(await walk(targetRoot));

  const copied = [];
  const deleted = [];
  const conflicts = [];

  for (const rel of sourceFiles) {
    targetFiles.delete(rel);

    const from = `${sourceRoot}/${rel}`;
    const to = `${targetRoot}/${rel}`;

    const a = await stat(from).catch(() => null);
    const b = await stat(to).catch(() => null);

    // Size plus a coarse mtime comparison: these are megabyte images where
    // hashing everything would cost more than the copy itself.
    if (!b || a.size !== b.size || Math.abs(a.mtimeMs - b.mtimeMs) > 1000) {
      copied.push(rel);
    }
  }

  for (const rel of targetFiles) deleted.push(rel);

  return { copied, deleted, conflicts };
}

async function walk(root, prefix = '') {
  const entries = await readdir(root, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (isJunk(entry.name)) continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;

    if (entry.isDirectory()) {
      files.push(...(await walk(path.join(root, entry.name), rel)));
    } else {
      files.push(rel);
    }
  }

  return files.sort();
}

async function commitTarget(repo, message) {
  const { execFile } = await import('node:child_process');
  const git = (args) =>
    new Promise((resolve, reject) => {
      execFile('git', args, { cwd: repo }, (err, stdout, stderr) => {
        if (err) reject(new Error(`${stdout}${stderr}`.trim() || err.message));
        else resolve(`${stdout}${stderr}`.trim());
      });
    });

  await git(['add', '-A']);

  try {
    await git(['commit', '-m', message]);
    console.log(`Committed: ${message}`);
  } catch (err) {
    // "nothing to commit" after add -A just means the copy produced no diff.
    if (!String(err.message).includes('nothing to commit')) throw err;
    console.log('Nothing to commit.');
  }
}

async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}
