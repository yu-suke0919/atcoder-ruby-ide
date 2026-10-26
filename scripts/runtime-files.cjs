const { readdir, readFile } = require('node:fs/promises');
const { createHash } = require('node:crypto');
const path = require('node:path');
const assert = require('node:assert/strict');

async function createManifest(directory) {
  const files = {};
  async function walk(relative = '') {
    for (const entry of await readdir(path.join(directory, relative), { withFileTypes: true })) {
      const name = path.posix.join(relative, entry.name);
      if (entry.isDirectory()) await walk(name);
      else if (entry.isFile()) {
        const data = await readFile(path.join(directory, name));
        files[name] = { bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') };
      } else {
        throw new Error(`Unexpected non-regular file in runtime directory: ${name}`);
      }
    }
  }
  await walk();
  return files;
}
async function verifyRuntime(directory, expected) {
  assert.deepEqual(await createManifest(directory), expected, 'Ruby payload differs from the prepared runtime');
}
module.exports = { createManifest, verifyRuntime };
