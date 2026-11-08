#!/usr/bin/env node
// Usage: node scripts/build-index.mjs [--base <git-ref>] [--check]   (default base: HEAD)
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pluginsDir = 'plugins';
const indexFile = 'index.json';

// Same rules as PluginSchema in trackarr.
const pluginIdPattern = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const semverPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

function parseArgs(argv) {
  const args = { base: 'HEAD', check: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--base' && argv[i + 1]) args.base = argv[++i];
    else if (argv[i] === '--check') args.check = true;
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  return args;
}

function git(args) {
  return execFileSync('git', args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
}

function readAtRef(ref, relPath) {
  try {
    return git(['show', `${ref}:${relPath}`]);
  } catch {
    return null;
  }
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function compareSemver(a, b) {
  const [, aMajor, aMinor, aPatch, aPre] = a.match(semverPattern);
  const [, bMajor, bMinor, bPatch, bPre] = b.match(semverPattern);
  for (const [x, y] of [[aMajor, bMajor], [aMinor, bMinor], [aPatch, bPatch]]) {
    const diff = BigInt(x) - BigInt(y);
    if (diff !== 0n) return diff > 0n ? 1 : -1;
  }
  if (aPre === bPre) return 0;
  if (aPre === undefined) return 1;
  if (bPre === undefined) return -1;
  const aIds = aPre.split('.');
  const bIds = bPre.split('.');
  for (let i = 0; i < Math.min(aIds.length, bIds.length); i++) {
    const aNum = /^\d+$/.test(aIds[i]);
    const bNum = /^\d+$/.test(bIds[i]);
    if (aNum && bNum) {
      const diff = BigInt(aIds[i]) - BigInt(bIds[i]);
      if (diff !== 0n) return diff > 0n ? 1 : -1;
    } else if (aNum !== bNum) {
      return aNum ? -1 : 1;
    } else if (aIds[i] !== bIds[i]) {
      return aIds[i] < bIds[i] ? -1 : 1;
    }
  }
  return Math.sign(aIds.length - bIds.length);
}

function parsePlugin(content) {
  const doc = parse(content.toString('utf8'));
  return doc && typeof doc === 'object' ? doc : {};
}

function readChangelog(relPath, changelog, errors) {
  if (changelog === undefined) return [];
  if (!Array.isArray(changelog)) {
    errors.push(`${relPath}: 'changelog' must be a list.`);
    return [];
  }
  return changelog.map((entry, i) => {
    const fields = ['version', 'date', 'notes'];
    if (!entry || typeof entry !== 'object' || fields.some((f) => typeof entry[f] !== 'string')) {
      errors.push(`${relPath}: changelog entry ${i + 1} must have string 'version', 'date' and 'notes'.`);
      return null;
    }
    return { version: entry.version, date: entry.date, notes: entry.notes };
  });
}

function buildEntry(relPath, content, base, errors, pathsById) {
  let doc;
  try {
    doc = parsePlugin(content);
  } catch (error) {
    errors.push(`${relPath}: invalid YAML: ${error.message.split('\n')[0]}`);
    return null;
  }

  const fileId = path.basename(relPath, '.yaml');
  const { pluginId: id, version, schemaVersion } = doc;
  const before = errors.length;
  if (typeof id === 'string') pathsById.set(id, [...(pathsById.get(id) ?? []), relPath]);

  if (typeof id !== 'string' || !pluginIdPattern.test(id)) {
    errors.push(`${relPath}: 'pluginId' must be lowercase letters, digits and single hyphens.`);
  } else if (id !== fileId) {
    errors.push(`${relPath}: file name '${fileId}' differs from pluginId '${id}'.`);
  }
  if (typeof version !== 'string' || !semverPattern.test(version)) {
    errors.push(`${relPath}: 'version' must be a semantic version such as 1.2.0.`);
  }
  if (!Number.isInteger(schemaVersion) || schemaVersion < 1) {
    errors.push(`${relPath}: 'schemaVersion' must be an integer of at least 1.`);
  }
  const changelog = readChangelog(relPath, doc.changelog, errors);
  if (errors.length > before) return null;

  const baseContent = readAtRef(base, relPath);
  if (baseContent && !baseContent.equals(content)) {
    let baseVersion;
    try {
      baseVersion = parsePlugin(baseContent).version;
    } catch {
      // An unparsable base has no version to compare against.
    }
    if (typeof baseVersion === 'string' && semverPattern.test(baseVersion) && compareSemver(version, baseVersion) <= 0) {
      errors.push(`${relPath}: changed since ${base} but version ${version} is not greater than ${baseVersion}.`);
    }
  }

  return { id, version, schemaVersion, path: relPath, sha256: sha256(content), changelog };
}

function main() {
  const { base, check } = parseArgs(process.argv.slice(2));
  try {
    git(['rev-parse', '--verify', '--quiet', `${base}^{commit}`]);
  } catch {
    throw new Error(`Base ref '${base}' is not a commit.`);
  }

  const errors = [];
  const entries = [];
  const pathsById = new Map();
  const files = readdirSync(path.join(root, pluginsDir), { withFileTypes: true })
    .map((dirent) => dirent.name)
    .sort();

  for (const name of files) {
    const relPath = `${pluginsDir}/${name}`;
    if (!name.endsWith('.yaml')) {
      errors.push(`${relPath}: only .yaml files are allowed in ${pluginsDir}/.`);
      continue;
    }
    const entry = buildEntry(relPath, readFileSync(path.join(root, relPath)), base, errors, pathsById);
    if (entry) entries.push(entry);
  }

  for (const [id, paths] of pathsById) {
    if (paths.length > 1) errors.push(`Duplicate pluginId '${id}' in ${paths.join(', ')}.`);
  }

  if (errors.length > 0) {
    for (const error of errors) console.error(`ERROR ${error}`);
    console.error(`${errors.length} error(s); ${indexFile} was not written.`);
    process.exit(1);
  }

  entries.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const content = `${JSON.stringify({ plugins: entries }, null, 2)}\n`;
  if (check) {
    let committed = null;
    try {
      committed = readFileSync(path.join(root, indexFile), 'utf8');
    } catch {
      // A missing index is reported as out of date below.
    }
    if (committed !== content) {
      console.error(`ERROR ${indexFile} is out of date: run pnpm build-index and commit it with the plugin files.`);
      process.exit(1);
    }
    console.log(`${indexFile} is up to date with ${entries.length} plugin(s).`);
    return;
  }
  writeFileSync(path.join(root, indexFile), content);
  console.log(`Wrote ${indexFile} with ${entries.length} plugin(s).`);
}

try {
  main();
} catch (error) {
  console.error(`ERROR ${error.message}`);
  process.exit(1);
}
