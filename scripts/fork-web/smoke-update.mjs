// Preload for the installed CLI smoke check. Serve the just-built release as
// latest without publishing it, so the real update command must report no change.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const directory = process.env.ARTIFACT_DIR;
const pointer = readFileSync(join(directory, 'latest.json'));
const latest = JSON.parse(pointer);
const base = `https://github.com/${latest.repository}/releases/download`;
const fetch = globalThis.fetch;
globalThis.fetch = (input, options) => {
  const url = input instanceof Request ? input.url : String(input);
  if (url === `${base}/fork-web/latest.json`) return Promise.resolve(new Response(pointer));
  if (url === `${base}/${latest.tag}/manifest.json`) return Promise.resolve(new Response(readFileSync(join(directory, 'manifest.json'))));
  if (url.startsWith(base)) throw new Error('The current build unexpectedly requested an update archive');
  if (url.startsWith('https://')) throw new Error('The fork update command used an unexpected external source');
  return fetch(input, options);
};
