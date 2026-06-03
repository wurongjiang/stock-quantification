import { cp, copyFile, mkdir, readdir, rm } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const distDir = resolve(rootDir, 'dist');

function assertInsideRoot(path) {
  if (path !== rootDir && !path.startsWith(`${rootDir}${sep}`)) {
    throw new Error(`Refusing to write outside project root: ${path}`);
  }
}

assertInsideRoot(distDir);

await rm(distDir, { recursive: true, force: true });
await mkdir(distDir, { recursive: true });

const entries = await readdir(rootDir, { withFileTypes: true });
const htmlFiles = entries.filter((entry) => entry.isFile() && entry.name.endsWith('.html'));

for (const file of htmlFiles) {
  await copyFile(join(rootDir, file.name), join(distDir, file.name));
}

for (const dirName of ['src', 'lib']) {
  await cp(join(rootDir, dirName), join(distDir, dirName), {
    recursive: true,
    force: true,
  });
}

console.log(`Netlify build copied ${htmlFiles.length} HTML files plus src/ and lib/ into dist/.`);
