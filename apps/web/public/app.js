const $ = (id) => document.getElementById(id);

function setDot(ok) {
  $('dot').className = 'dot' + (ok ? ' ok' : '');
}

function loadConfig() {
  return fetch('/api/config').then((r) => r.json());
}

function renderEvents(sessionId) {
  fetch('/api/events/' + sessionId)
    .then((r) => r.json())
    .then((events) => {
      const log = $('events');
      $('evcount').textContent = events.length + ' events';
      log.innerHTML = events
        .map((e) => {
          const ids = [e.sessionId, e.turnId, e.stepId].filter(Boolean).join('/');
          return '<span class="e">' + e.type + '</span> <span class="s">' + ids + '</span>';
        })
        .join('\n');
      log.scrollTop = log.scrollHeight;
    })
    .catch(() => {
      $('events').textContent = '事件读取失败';
    });
}

function renderResult(data) {
  const cls = data.outcome === 'success' ? 'success' : data.outcome === 'failed' ? 'failed' : 'unknown';
  const html =
    '<div class="out"><span class="badge ' + cls + '">' + data.outcome + '</span>' +
    '<div class="summary">' + (data.summary ? escapeHtml(data.summary) : '') + '</div>' +
    '<div class="metrics">turns ' + data.turnCount + ' · tokens ' + data.totalTokens +
    ' · cost $' + Number(data.totalCostUsd).toFixed(6) + ' · session ' + data.sessionId + '</div></div>';
  const panel = $('result');
  panel.innerHTML = html;
  panel.classList.remove('hidden');
  renderEvents(data.sessionId);
  loadHistory();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

function loadHistory() {
  fetch('/api/runs?limit=20')
    .then((r) => r.json())
    .then((runs) => {
      const ul = $('history');
      ul.innerHTML = runs.length
        ? runs.map((r) =>
            '<li data-session="' + r.sessionId + '"><div class="h-in">' + escapeHtml(r.input) + '</div>' +
            '<div class="h-meta"><span>' + (r.outcome ?? 'n/a') + '</span><span>' + new Date(r.updatedAt).toLocaleString() + '</span></div></li>',
          ).join('')
        : '<li class="dim">暂无运行记录</li>';
    })
    .catch(() => {});
}

async function run() {
  const input = $('input').value.trim();
  if (!input) return;
  const btn = $('run');
  btn.disabled = true;
  btn.textContent = '运行中…';
  $('events').textContent = '等待执行…';
  try {
    const res = await fetch('/api/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input, userId: $('user').value || undefined }),
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || res.statusText);
    }
    renderResult(data);
  } catch (error) {
    const panel = $('result');
    panel.innerHTML = '<div class="out"><span class="badge failed">error</span><div class="summary">' + escapeHtml(error.message) + '</div></div>';
    panel.classList.remove('hidden');
  } finally {
    btn.disabled = false;
    btn.textContent = '运行';
  }
}

document.addEventListener('DOMContentLoaded', () => {
  $('run').addEventListener('click', run);
  $('input').addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') run();
  });
  document.addEventListener('click', (e) => {
    const li = e.target && e.target.closest ? e.target.closest('[data-session]') : null;
    if (li) renderEvents(li.getAttribute('data-session'));
  });
  loadConfig().then((cfg) => {
    const ok = cfg.providers.length > 0;
    setDot(ok);
    $('cfgline').textContent = cfg.home + (ok ? ' · ' + cfg.providers.join(', ') : ' · 未配置 provider');
    if (!ok) {
      $('cfgline').textContent = cfg.home + ' · 未配置 provider：先运行 pnpm mazi config';
    }
  });
  loadHistory();
});
