const { createHash } = require('node:crypto');
const { createWriteStream } = require('node:fs');
const { access, mkdir, readFile, rename, rm } = require('node:fs/promises');
const { pipeline } = require('node:stream/promises');
const { Readable } = require('node:stream');
const path = require('node:path');

async function downloadVerified({ url, archive, sha256 }, cache) {
  await mkdir(cache, { recursive: true });
  const file = path.join(cache, archive);
  const cached = await access(file).then(() => true, () => false);
  if (!cached) {
    const response = await fetch(url, { signal: AbortSignal.timeout(180000) });
    if (!response.ok) throw new Error(`${archive} のダウンロードに失敗しました: HTTP ${response.status}`);
    const partial = `${file}.part`;
    try {
      await pipeline(Readable.fromWeb(response.body), createWriteStream(partial));
      await rename(partial, file);
    } finally { await rm(partial, { force: true }); }
  }
  const hash = createHash('sha256').update(await readFile(file)).digest('hex');
  if (hash !== sha256) throw new Error(`SHA-256 が一致しません。キャッシュを確認してください: ${file}`);
  return file;
}
module.exports = { downloadVerified };
