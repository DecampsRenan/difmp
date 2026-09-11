import type { Project, Variant, Workspace } from "./types.js";

export const escapeHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

const formatDate = (iso: string): string => iso.slice(0, 10);

const STYLES = `
:root { color-scheme: light; --bg:#f6f7f9; --card:#ffffff; --ink:#1b1f24; --muted:#5b6472;
        --line:#e3e6ea; --accent:#2f5bd7; --danger:#b42318; }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--ink);
       font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; }
.topbar { display:flex; align-items:center; justify-content:space-between; gap:12px;
          padding:12px 20px; background:var(--card); border-bottom:1px solid var(--line); }
.brand { font-weight:650; letter-spacing:-0.01em; }
.topbar .who { color:var(--muted); font-size:13px; }
main { max-width:720px; margin:0 auto; padding:24px 16px 56px; }
h1 { font-size:22px; margin:8px 0 4px; }
.workspace-line { color:var(--muted); margin:0 0 20px; }
.card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:16px; margin-bottom:20px; }
label { display:block; font-weight:600; font-size:13px; margin-bottom:6px; }
input[type=text],input[type=email],input[type=password] { width:100%; padding:9px 11px;
  border:1px solid var(--line); border-radius:7px; font-size:15px; background:#fff; color:inherit; }
.row { display:flex; gap:10px; align-items:flex-end; flex-wrap:wrap; }
.row > .field { flex:1 1 240px; }
button { padding:9px 14px; border-radius:7px; border:1px solid transparent; background:var(--accent);
         color:#fff; font-size:14px; font-weight:600; cursor:pointer; }
button.secondary { background:#fff; color:var(--ink); border-color:var(--line); }
button[disabled] { opacity:.6; cursor:progress; }
ul#project-list { list-style:none; margin:0; padding:0; }
ul#project-list li { display:flex; justify-content:space-between; gap:12px; padding:11px 2px;
  border-bottom:1px solid var(--line); }
ul#project-list li:last-child { border-bottom:0; }
table#project-list { width:100%; border-collapse:collapse; }
table#project-list caption { text-align:left; font-weight:600; padding-bottom:8px; }
table#project-list th, table#project-list td { text-align:left; padding:9px 4px; border-bottom:1px solid var(--line); }
.project-date { color:var(--muted); font-size:13px; }
[role=alert] { color:var(--danger); background:#fdf3f2; border:1px solid #f3c9c4;
  border-radius:7px; padding:9px 11px; margin:12px 0 0; }
.empty { color:var(--muted); margin:6px 0 0; }
dialog, .dialog { background:var(--card); border:1px solid var(--line); border-radius:10px;
  padding:16px; margin-top:12px; }
.dialog h2 { font-size:16px; margin:0 0 12px; }
.login { max-width:380px; margin:64px auto; }
[hidden] { display:none !important; }
`;

const CLIENT_SCRIPT = `
(function () {
  var form = document.getElementById('new-project-form');
  var input = document.getElementById('project-name');
  var list = document.getElementById('project-list');
  var errorBox = document.getElementById('form-error');
  var empty = document.getElementById('empty-state');
  var toggle = document.getElementById('new-project-toggle');
  var dialog = document.getElementById('new-project-dialog');
  var cancel = document.getElementById('new-project-cancel');

  function openDialog(open) {
    if (!dialog || !toggle) return;
    if (open) { dialog.removeAttribute('hidden'); toggle.setAttribute('aria-expanded', 'true'); if (input) input.focus(); }
    else { dialog.setAttribute('hidden', ''); toggle.setAttribute('aria-expanded', 'false'); }
  }
  if (toggle && dialog) {
    toggle.addEventListener('click', function () { openDialog(dialog.hasAttribute('hidden')); });
  }
  if (cancel) { cancel.addEventListener('click', function () { openDialog(false); }); }

  function showError(message) {
    if (!errorBox) return;
    errorBox.textContent = message;
    errorBox.removeAttribute('hidden');
  }
  function clearError() {
    if (!errorBox) return;
    errorBox.textContent = '';
    errorBox.setAttribute('hidden', '');
  }
  function day(iso) { return typeof iso === 'string' ? iso.slice(0, 10) : ''; }

  function append(project) {
    if (!list || !project) return;
    if (empty) empty.setAttribute('hidden', '');
    if (list.getAttribute('data-layout') === 'table') {
      var tbody = document.getElementById('project-rows');
      if (!tbody) return;
      var tr = document.createElement('tr');
      tr.setAttribute('data-project-id', String(project.id));
      var nameCell = document.createElement('td');
      nameCell.className = 'project-name';
      nameCell.textContent = String(project.name);
      var dateCell = document.createElement('td');
      dateCell.className = 'project-date';
      dateCell.textContent = day(project.createdAt);
      tr.appendChild(nameCell);
      tr.appendChild(dateCell);
      tbody.appendChild(tr);
    } else {
      var li = document.createElement('li');
      li.setAttribute('data-project-id', String(project.id));
      var name = document.createElement('span');
      name.className = 'project-name';
      name.textContent = String(project.name);
      var date = document.createElement('span');
      date.className = 'project-date';
      date.textContent = day(project.createdAt);
      li.appendChild(name);
      li.appendChild(date);
      list.appendChild(li);
    }
  }

  if (!form) return;
  form.addEventListener('submit', function (event) {
    event.preventDefault();
    clearError();
    var name = input ? String(input.value).trim() : '';
    if (!name) { showError('Please enter a project name.'); return; }
    var submit = form.querySelector('button[type=submit]');
    if (submit) submit.disabled = true;
    fetch('/api/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: name })
    }).then(function (res) {
      return res.json().catch(function () { return null; }).then(function (body) {
        return { ok: res.ok, status: res.status, body: body };
      });
    }).then(function (result) {
      if (!result.ok) {
        var detail = result.body && result.body.error && result.body.error.message
          ? result.body.error.message : 'Unexpected server error.';
        showError('Could not create project (HTTP ' + result.status + '): ' + detail);
        return;
      }
      append(result.body);
      if (input) input.value = '';
      openDialog(false);
    }).catch(function () {
      showError('Could not create project: network error.');
    }).then(function () {
      if (submit) submit.disabled = false;
    });
  });
})();
`;

const page = (title: string, body: string): string =>
  `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${STYLES}</style>
</head>
<body>
${body}
</body>
</html>
`;

export const renderLoginPage = (options: { error?: string | undefined }): string =>
  page(
    "Sign in · Projects",
    `<main class="login">
  <h1>Sign in to Projects</h1>
  <form class="card" method="post" action="/login">
    <div class="field">
      <label for="email">Email</label>
      <input id="email" name="email" type="email" autocomplete="username" required>
    </div>
    <div class="field" style="margin-top:12px">
      <label for="password">Password</label>
      <input id="password" name="password" type="password" autocomplete="current-password" required>
    </div>
    <div style="margin-top:16px">
      <button type="submit">Sign in</button>
    </div>
    ${
      options.error === undefined
        ? ""
        : `<p role="alert" id="login-error">${escapeHtml(options.error)}</p>`
    }
  </form>
</main>`,
  );

interface HomeModel {
  readonly workspace: Workspace;
  readonly email: string;
  readonly projects: readonly Project[];
  readonly variant: Variant;
}

const topbar = (email: string): string =>
  `<div class="topbar">
  <span class="brand">Projects</span>
  <span class="who">Signed in as ${escapeHtml(email)} · <a href="/logout">Sign out</a></span>
</div>`;

const renderDefaultHome = (model: HomeModel): string => {
  const items = model.projects
    .map(
      (p) =>
        `      <li data-project-id="${escapeHtml(p.id)}"><span class="project-name">${escapeHtml(
          p.name,
        )}</span><span class="project-date">${escapeHtml(formatDate(p.createdAt))}</span></li>`,
    )
    .join("\n");

  return page(
    `${model.workspace.name} · Projects`,
    `${topbar(model.email)}
<main>
  <h1>Projects</h1>
  <p class="workspace-line">Workspace: <strong id="workspace-name">${escapeHtml(
    model.workspace.name,
  )}</strong></p>

  <section class="card" aria-labelledby="new-project-heading">
    <h2 id="new-project-heading" style="font-size:15px;margin:0 0 12px">New project</h2>
    <form id="new-project-form" class="row">
      <div class="field">
        <label for="project-name">Project name</label>
        <input id="project-name" name="name" type="text" autocomplete="off" required>
      </div>
      <button type="submit">Create project</button>
    </form>
    <p id="form-error" role="alert" hidden></p>
  </section>

  <section class="card" aria-labelledby="project-list-heading">
    <h2 id="project-list-heading" style="font-size:15px;margin:0 0 8px">Your projects</h2>
    <ul id="project-list" role="list" aria-label="Projects" data-layout="list">
${items}
    </ul>
    <p class="empty" id="empty-state"${model.projects.length === 0 ? "" : " hidden"}>No projects yet.</p>
  </section>
</main>
<script>${CLIENT_SCRIPT}</script>`,
  );
};

const renderAltHome = (model: HomeModel): string => {
  const rows = model.projects
    .map(
      (p) =>
        `        <tr data-project-id="${escapeHtml(p.id)}"><td class="project-name">${escapeHtml(
          p.name,
        )}</td><td class="project-date">${escapeHtml(formatDate(p.createdAt))}</td></tr>`,
    )
    .join("\n");

  return page(
    `${model.workspace.name} · Projects`,
    `${topbar(model.email)}
<main>
  <h1>Projects</h1>
  <p class="workspace-line">Workspace: <strong id="workspace-name">${escapeHtml(
    model.workspace.name,
  )}</strong></p>

  <button type="button" id="new-project-toggle" aria-expanded="false" aria-controls="new-project-dialog">New project</button>

  <div class="dialog" id="new-project-dialog" role="dialog" aria-labelledby="new-project-dialog-title" hidden>
    <h2 id="new-project-dialog-title">Create a new project</h2>
    <form id="new-project-form">
      <div class="field">
        <label for="project-name">Name of the project</label>
        <input id="project-name" name="name" type="text" autocomplete="off" required>
      </div>
      <div class="row" style="margin-top:14px">
        <button type="submit">Add project</button>
        <button type="button" class="secondary" id="new-project-cancel">Cancel</button>
      </div>
    </form>
  </div>
  <p id="form-error" role="alert" hidden></p>

  <div class="card" style="margin-top:20px">
    <table id="project-list" aria-label="Projects" data-layout="table">
      <caption>Your projects</caption>
      <thead>
        <tr><th scope="col">Project</th><th scope="col">Created</th></tr>
      </thead>
      <tbody id="project-rows">
${rows}
      </tbody>
    </table>
    <p class="empty" id="empty-state"${model.projects.length === 0 ? "" : " hidden"}>No projects yet.</p>
  </div>
</main>
<script>${CLIENT_SCRIPT}</script>`,
  );
};

export const renderHomePage = (model: HomeModel): string =>
  model.variant === "alt-layout" ? renderAltHome(model) : renderDefaultHome(model);
