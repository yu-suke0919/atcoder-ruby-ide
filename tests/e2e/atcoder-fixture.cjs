// Stands in for AtCoder in UI tests: tests put pages here, everything else answers like a
// task page that needs login (AtCoder returns "Permission denied." without a statement).
const http = require('node:http');

async function startAtCoder() {
  const pages = new Map();
  // Milliseconds to wait before answering a path, for pages that arrive late.
  const delays = new Map();
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    requests.push(pathname);
    if (delays.has(pathname)) await new Promise(resolve => setTimeout(resolve, delays.get(pathname)));
    const html = pages.get(pathname);
    res.writeHead(html === undefined ? 404 : 200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html ?? '<div class="alert alert-danger">Permission denied.</div>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { pages, delays, requests, server, origin: `http://127.0.0.1:${server.address().port}` };
}

const escape = text => text.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function taskListPage(contest, title, tasks) {
  const rows = tasks.map(task => `<tr><td><a href="/contests/${contest}/tasks/${task.id}">${escape(task.label)}</a></td><td><a href="/contests/${contest}/tasks/${task.id}">${escape(task.title)}</a></td></tr>`).join('');
  return `<html><body><a class="contest-title" href="/contests/${contest}">${escape(title)}</a><table><tbody>${rows}</tbody></table></body></html>`;
}

// `input` is the input format with variables as <var>, as AtCoder writes it before KaTeX draws it.
function taskPage({ samples = [], timeLimit = '2 sec', memoryLimit = '1024 MiB', input = null, constraints = [] } = {}) {
  // Headings carry the Copy button that AtCoder's script adds once the page has loaded.
  const copy = '<span class="btn btn-default btn-sm btn-copy">Copy</span>';
  const sections = samples.map(([input, output], index) => `<section><h3>入力例 ${index + 1}${copy}</h3><pre>${escape(input)}</pre></section><section><h3>出力例 ${index + 1}${copy}</h3><pre>${escape(output)}</pre></section>`).join('');
  const format = input === null ? '' : `<section><h3>制約</h3><ul>${constraints.map(item => `<li>${item}</li>`).join('')}</ul></section><section><h3>入力</h3><p>入力は以下の形式で標準入力から与えられる。</p><pre>${input}</pre></section>`;
  return `<html><body><p>実行時間制限: ${timeLimit} / メモリ制限: ${memoryLimit}</p><div id="task-statement"><span class="lang-ja"><section><h3>問題文</h3><p>テスト用の問題です。</p></section>${format}${sections}</span></div></body></html>`;
}

// The user's submission list with the markup AtCoder uses (tests/fixtures/submissions/ has real ones).
function submissionsPage(contest, submissions) {
  const rows = submissions.map(({ id, task, result, judging = false }) => {
    const label = result === 'AC' ? 'label-success' : judging && !/[A-Z]{2}/.test(result.replace('WJ', '')) ? 'label-default' : 'label-warning';
    const status = judging
      ? `<td colspan="3" class="text-center waiting-judge" data-id="${id}"><span class="label ${label}">${result}</span></td>`
      : `<td class="text-center"><span class="label ${label}">${result}</span></td><td class="text-right">10 ms</td><td class="text-right">3000 KiB</td>`;
    return `<tr><td class="no-break"><time class="fixtime-second">2026-11-07 15:49:58</time></td><td><a href="/contests/${contest}/tasks/${task}">${task}</a></td><td><a href="/users/test_user">test_user</a></td><td>Ruby 3.4 (ruby 3.4.5)</td><td class="text-right submission-score" data-id="${id}">0</td><td class="text-right">100 Byte</td>${status}<td class="text-center"><a href="/contests/${contest}/submissions/${id}" class="submission-details-link">詳細</a></td></tr>`;
  }).join('');
  return `<html><body><table class="table"><tbody>${rows}</tbody></table></body></html>`;
}

// A contest's top page with the parts the app reads (tests/fixtures/contest-top/ has real ones):
// the user menu says "(Contestant)" once registered, and the page's script holds the times.
function contestTopPage(contest, { contestant = true, start, end }) {
  return `<html><head><script>var userScreenName = "test_user";</script><script>var contestScreenName = "${contest}"; var startTime = moment("${start}"); var endTime = moment("${end}");</script></head><body><nav class="navbar"><ul class="nav navbar-nav navbar-right"><li class="dropdown"><a class="dropdown-toggle" href="#"><span class="glyphicon glyphicon-cog"></span> test_user (${contestant ? 'Contestant' : 'Guest'}) <span class="caret"></span></a></li></ul></nav><a class="contest-title" href="/contests/${contest}">テスト ${escape(contest)}</a></body></html>`;
}

module.exports = { startAtCoder, taskListPage, taskPage, submissionsPage, contestTopPage };
