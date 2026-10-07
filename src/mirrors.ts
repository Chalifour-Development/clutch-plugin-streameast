/**
 * Known Streameast mirrors, all serving the same listing and match pages (checked 2026-10-06
 * against https://v5.gostreameast.link/). The `www.` hosts only redirect to these `v2.` hosts;
 * streameast.is and streameast.ml answered 403 and are left out. The plugin also reads the
 * directory at runtime, so a mirror added later is tried too.
 */
export const KNOWN_MIRRORS = [
  'https://v2.streameast.ch',
  'https://v2.streameast.ga',
  'https://v2.streameast.ps',
  'https://v2.streameast.ms',
  'https://v2.streameast.fm',
  'https://v2.streameast.sg',
  'https://v2.streameast.cf',
  'https://v2.streameast.fi',
  'https://v2.streameast.ph',
  'https://v2.thestreameast.su',
  'https://v2.thestreameast.ru',
  'https://v2.thestreameast.fun',
];
