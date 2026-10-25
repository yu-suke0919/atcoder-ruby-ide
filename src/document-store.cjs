const { readFile, writeFile } = require('node:fs/promises');

class DocumentStore {
  constructor({ chooseOpen, chooseSave } = {}) {
    this.chooseOpen = chooseOpen;
    this.chooseSave = chooseSave;
    this.filePath = null;
  }

  reset() { this.filePath = null; }

  async open() {
    const filePath = await this.chooseOpen();
    if (!filePath) return { canceled: true };
    const code = (await readFile(filePath, 'utf8')).replace(/^\uFEFF/, '');
    this.filePath = filePath;
    return { canceled: false, filePath, code };
  }

  async save(code, { saveAs = false } = {}) {
    if (typeof code !== 'string') throw new Error('保存するコードは文字列で指定してください。');
    const filePath = !saveAs && this.filePath ? this.filePath : await this.chooseSave(this.filePath);
    if (!filePath) return { canceled: true };
    await writeFile(filePath, code, 'utf8');
    this.filePath = filePath;
    return { canceled: false, filePath };
  }
}

module.exports = { DocumentStore };
