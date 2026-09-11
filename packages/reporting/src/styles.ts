/** Inlined verbatim into the report. No font, no stylesheet, no image is ever fetched. */
export const reportStyles = `
:root {
  color-scheme: light dark;
  --bg: #f6f7f9; --panel: #ffffff; --ink: #16191d; --muted: #5b6472; --line: #d8dde5;
  --passed: #0f7b46; --failed: #b3261e; --inconclusive: #8a5a00; --error: #7a1f8f; --pending: #56606e;
  --accent: #1f4fd8; --code-bg: #f0f2f6;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #101318; --panel: #171b22; --ink: #e6e9ee; --muted: #9aa4b2; --line: #2a313c;
    --passed: #4ec98a; --failed: #ff8a80; --inconclusive: #ffc75a; --error: #d89cff; --pending: #9aa4b2;
    --accent: #7aa2ff; --code-bg: #1d222b;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--bg); color: var(--ink);
  font: 15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
}
main { max-width: 1080px; margin: 0 auto; padding: 24px 16px 72px; }
h1 { font-size: 22px; margin: 0 0 4px; }
h2 { font-size: 17px; margin: 0 0 4px; }
h3 { font-size: 14px; margin: 0 0 6px; }
p { margin: 6px 0; }
a { color: var(--accent); }
code, pre, .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12.5px; }
pre {
  background: var(--code-bg); border: 1px solid var(--line); border-radius: 6px;
  padding: 10px 12px; overflow-x: auto; white-space: pre-wrap; word-break: break-word; margin: 6px 0;
}
.panel {
  background: var(--panel); border: 1px solid var(--line); border-radius: 10px;
  padding: 16px; margin: 0 0 18px;
}
.lede { color: var(--muted); font-size: 13px; margin: 0 0 12px; }
.verdict { display: flex; flex-wrap: wrap; gap: 16px; align-items: baseline; }
.badge {
  display: inline-block; border-radius: 999px; padding: 2px 10px; font-size: 12px;
  font-weight: 600; border: 1px solid currentColor;
}
.s-passed { color: var(--passed); } .s-failed { color: var(--failed); }
.s-inconclusive { color: var(--inconclusive); } .s-error { color: var(--error); }
.s-cancelled { color: var(--error); } .s-pending { color: var(--pending); }
.badge.method { color: var(--muted); font-weight: 500; }
.big { font-size: 26px; font-weight: 700; }
.meta { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 8px 20px; margin-top: 12px; }
.meta div { font-size: 13px; }
.meta span { color: var(--muted); display: block; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; }
.tiles { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 12px; }
.tile { border: 1px solid var(--line); border-radius: 8px; padding: 8px 14px; min-width: 104px; }
.tile b { display: block; font-size: 20px; }
.tile span { color: var(--muted); font-size: 12px; }
table { border-collapse: collapse; width: 100%; font-size: 13px; }
th, td { border-bottom: 1px solid var(--line); padding: 6px 8px; text-align: left; vertical-align: top; }
th { color: var(--muted); font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; }
.scroll { overflow-x: auto; }
.item { border: 1px solid var(--line); border-radius: 8px; padding: 12px; margin: 10px 0; }
.item header { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 6px; }
.kv { margin: 8px 0 0; }
.kv dt { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .04em; margin-top: 8px; }
.kv dd { margin: 2px 0 0; }
.note {
  border-left: 3px solid var(--inconclusive); background: color-mix(in srgb, var(--inconclusive) 10%, transparent);
  padding: 6px 10px; margin: 8px 0 0; font-size: 12.5px; border-radius: 0 6px 6px 0;
}
.note.deterministic { border-left-color: var(--passed); background: color-mix(in srgb, var(--passed) 10%, transparent); }
.d-error { border-left-color: var(--failed); background: color-mix(in srgb, var(--failed) 10%, transparent); }
.d-warning { border-left-color: var(--inconclusive); }
.d-info { border-left-color: var(--muted); background: color-mix(in srgb, var(--muted) 10%, transparent); }
.cat { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); }
tr.c-error td, tr.c-verification td { background: color-mix(in srgb, var(--line) 30%, transparent); }
nav { font-size: 13px; margin: 0 0 18px; display: flex; flex-wrap: wrap; gap: 12px; }
footer { color: var(--muted); font-size: 12.5px; border-top: 1px solid var(--line); padding-top: 14px; }
.missing { color: var(--failed); font-weight: 600; }
.wrap { word-break: break-word; }
@media (max-width: 520px) { main { padding: 16px 12px 48px; } .big { font-size: 21px; } }
`
