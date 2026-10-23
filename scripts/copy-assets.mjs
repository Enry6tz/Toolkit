import { cp, mkdir } from 'node:fs/promises';

const source = new URL('../src/react/assets/', import.meta.url);
const destination = new URL('../dist/react/assets/', import.meta.url);

await mkdir(destination, { recursive: true });
await cp(source, destination, { recursive: true });
