/**
 * Read the page's own data module in Node.
 *
 * `src/epd-data.js` is a classic script: it runs on load and leaves
 * `window.EpdData` behind, which is what the script-tag edition of this demo
 * needs it to be. Both tools want the same SQL builders, and a second copy of
 * them in Node would be a second thing to keep in step, so the file is run here
 * with an object standing in for `window`.
 *
 * That matters most in `verify.mjs`: the statement it expects the page to have
 * sent is built by the page's own builder, so the check is that the browser
 * sent what the builder wrote, not that two hand written strings match.
 */

import { readFile } from 'node:fs/promises';

/**
 * Load `EpdData` as the browser would see it.
 *
 * @returns {Promise<object>} the module
 */
export async function loadEpdData() {
  const code = await readFile(new URL('../src/epd-data.js', import.meta.url), 'utf8');
  const stand_in = {};
  /* The file's own wrapper takes `window` as a parameter, so handing it an
     object is all it needs; nothing in it touches the DOM. */
  new Function('window', code)(stand_in);
  if (!stand_in.EpdData) throw new Error('src/epd-data.js did not leave EpdData behind');
  return stand_in.EpdData;
}
