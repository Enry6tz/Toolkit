import { lstat, realpath, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Only the generated directory beside this package's manifest may be removed.
const root = await realpath(dirname(dirname(fileURLToPath(import.meta.url))));
const dist = join(root, 'dist');
try {
  const entry = await lstat(dist);
  if (!entry.isDirectory() || entry.isSymbolicLink() || await realpath(dist) !== dist) {
    throw new Error('Refusing to clean a redirected or non-directory dist path.');
  }
  await rm(dist, { recursive: true });
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
