import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

export function npmVersionFor(version) {
  const match = /^([1-9]\d{3})\.(\d{2})\.(\d{2})\.([1-9]\d*)$/.exec(version);
  if (!match || match[0] !== version) throw new Error('Release version must be YYYY.MM.DD.X, with X starting at 1.');
  const [, year, month, day, sequence] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (date.getUTCFullYear() !== Number(year) || date.getUTCMonth() + 1 !== Number(month) || date.getUTCDate() !== Number(day)) {
    throw new Error('Release version must contain a real calendar date.');
  }
  return `${year}.${Number(month)}.${Number(day)}-${sequence}`;
}

export function checkReleaseVersion(root = process.cwd(), tag) {
  const version = readFileSync(resolve(root, 'VERSION'), 'utf8').trim();
  const npmVersion = npmVersionFor(version);
  const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
  const lock = JSON.parse(readFileSync(resolve(root, 'package-lock.json'), 'utf8'));
  if (pkg.version !== npmVersion || lock.version !== npmVersion || lock.packages?.['']?.version !== npmVersion) {
    throw new Error(`Package and lockfile versions must all be ${npmVersion} for release ${version}.`);
  }
  const compose = readFileSync(resolve(root, 'docker-compose.yml'), 'utf8');
  if (!compose.split(/\r?\n/).some(line => line.trim() === `image: sol-diagnostics:${version}`)) {
    throw new Error(`Compose image must be sol-diagnostics:${version}.`);
  }
  if (tag !== undefined && tag !== `v${version}`) throw new Error(`Release tag must be v${version}.`);
  return version;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    console.log(`Release version verified: ${checkReleaseVersion(process.cwd(), process.argv[2])}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
