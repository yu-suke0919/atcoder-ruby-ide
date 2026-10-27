async function editorText(page) {
  return page.evaluate(async () => {
    const { EditorView } = await import('./vendor/editor/codemirror.mjs');
    return EditorView.findFromDOM(document.getElementById('code-editor')).state.doc.toString();
  });
}
module.exports = { editorText };
