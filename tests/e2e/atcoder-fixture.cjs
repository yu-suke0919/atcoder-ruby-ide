// Stands in for AtCoder in UI tests: tests put pages here, everything else answers like a
// task page that needs login (AtCoder returns "Permission denied." without a statement).
const http = require('node:http');

async function startAtCoder() {
  const pages = new Map();
  const requests = [];
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    requests.push(pathname);
    const html = pages.get(pathname);
    res.writeHead(html === undefined ? 404 : 200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html ?? '<div class="alert alert-danger">Permission denied.</div>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { pages, requests, server, origin: `http://127.0.0.1:${server.address().port}` };
}

const escape = text => text.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function taskListPage(contest, title, tasks) {
  const rows = tasks.map(task => `<tr><td><a href="/contests/${contest}/tasks/${task.id}">${escape(task.label)}</a></td><td><a href="/contests/${contest}/tasks/${task.id}">${escape(task.title)}</a></td></tr>`).join('');
  return `<html><body><a class="contest-title" href="/contests/${contest}">${escape(title)}</a><table><tbody>${rows}</tbody></table></body></html>`;
}

function taskPage({ samples = [], timeLimit = '2 sec', memoryLimit = '1024 MiB' } = {}) {
  // Headings carry the Copy button that AtCoder's script adds once the page has loaded.
  const copy = '<span class="btn btn-default btn-sm btn-copy">Copy</span>';
  const sections = samples.map(([input, output], index) => `<section><h3>入力例 ${index + 1}${copy}</h3><pre>${escape(input)}</pre></section><section><h3>出力例 ${index + 1}${copy}</h3><pre>${escape(output)}</pre></section>`).join('');
  return `<html><body><p>実行時間制限: ${timeLimit} / メモリ制限: ${memoryLimit}</p><div id="task-statement"><span class="lang-ja"><section><h3>問題文</h3><p>テスト用の問題です。</p></section>${sections}</span></div></body></html>`;
}

module.exports = { startAtCoder, taskListPage, taskPage };
