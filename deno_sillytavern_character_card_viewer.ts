#!/usr/bin/env -S deno run -A
import { CharacterCard } from "npm:@lenml/char-card-reader";
import * as path from "node:path";
import * as fs from "node:fs/promises";

const targetDir = path.resolve(Deno.args[0] || ".");
const PORT = 5050;

interface CardSummary {
  relPath: string;
  folder: string;
  name: string;
  creator: string;
  tags: string[];
  hasLorebook: boolean;
  altGreetingsCount: number;
}

const cardCache = new Map<string, { mtime: number; data: any; summary: CardSummary }>();

async function* walk(dir: string): AsyncGenerator<string> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full);
    } else if (/\.(png|webp|jpe?g|json)$/i.test(entry.name)) {
      yield full;
    }
  }
}

async function parseCard(filePath: string) {
  const stat = await fs.stat(filePath);
  const cached = cardCache.get(filePath);
  if (cached && cached.mtime === stat.mtimeMs) {
    return cached;
  }

  const buf = await fs.readFile(filePath);
  let card: any;

  if (filePath.toLowerCase().endsWith(".json")) {
    const raw = JSON.parse(new TextDecoder().decode(buf));
    card = CharacterCard.from_json(raw);
  } else {
    card = await CharacterCard.from_file(buf);
  }

  const v2 = card.toSpecV2();
  const d = v2.data || {};
  const relPath = path.relative(targetDir, filePath);
  const folder = path.dirname(relPath) === "." ? "/" : path.dirname(relPath).replace(/\\/g, "/");

  const altGreetings = Array.isArray(d.alternate_greetings) ? d.alternate_greetings : [];
  const lorebook = d.character_book || null;

  const summary: CardSummary = {
    relPath,
    folder,
    name: d.name || card.name || path.basename(filePath),
    creator: d.creator || "Unknown",
    tags: Array.isArray(d.tags) ? d.tags : [],
    hasLorebook: Boolean(lorebook && lorebook.entries?.length > 0),
    altGreetingsCount: altGreetings.length,
  };

  const parsed = {
    mtime: stat.mtimeMs,
    summary,
    data: {
      ...v2,
      resolvedAvatar: `/api/image?path=${encodeURIComponent(relPath)}`,
      filePath: relPath,
    },
  };

  cardCache.set(filePath, parsed);
  return parsed;
}

async function scanAll() {
  for await (const file of walk(targetDir)) {
    try {
      await parseCard(file);
    } catch {
      // Ignore files without character card metadata
    }
  }
}

// Initial index
await scanAll();

Deno.serve({ port: PORT }, async (req) => {
  const url = new URL(req.url);

  if (url.pathname === "/api/cards") {
    await scanAll(); // incremental rescan
    const cards = Array.from(cardCache.values()).map((c) => c.summary);
    return Response.json(cards);
  }

  if (url.pathname === "/api/card") {
    const reqPath = url.searchParams.get("path");
    if (!reqPath) return new Response("Missing path", { status: 400 });
    const full = path.resolve(targetDir, reqPath);
    if (!full.startsWith(targetDir)) return new Response("Forbidden", { status: 403 });

    try {
      const card = await parseCard(full);
      return Response.json(card.data);
    } catch (e) {
      return new Response(String(e), { status: 500 });
    }
  }

  if (url.pathname === "/api/image") {
    const reqPath = url.searchParams.get("path");
    if (!reqPath) return new Response("Missing path", { status: 400 });
    const full = path.resolve(targetDir, reqPath);
    if (!full.startsWith(targetDir)) return new Response("Forbidden", { status: 403 });

    try {
      const data = await fs.readFile(full);
      const ext = path.extname(full).toLowerCase();
      const mime = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";
      return new Response(data, { headers: { "Content-Type": mime } });
    } catch {
      return new Response("Not found", { status: 404 });
    }
  }

  // Serve UI
  if (url.pathname === "/") {
    return new Response(INDEX_HTML, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-cache, no-store, must-revalidate",
        "Pragma": "no-cache",
        "Expires": "0",
      },
    });
  }

  return new Response("Not found", { status: 404 });
});

console.log(`\nCharacter Card Viewer listening on http://localhost:${PORT}`);
console.log(`Root directory: ${targetDir}\n`);

const INDEX_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>SillyTavern Card Viewer</title>
  <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
  <style>
    :root {
      --bg: #0f1117;
      --sidebar: #161821;
      --card-bg: #1c1f2e;
      --accent: #6366f1;
      --border: #282c3f;
      --text: #e2e8f0;
      --text-muted: #94a3b8;
      --viewer-font-size: 14px;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: var(--bg); color: var(--text); font-family: system-ui, -apple-system, sans-serif; display: flex; height: 100vh; overflow: hidden; }

    #sidebar { width: 0; min-width: 0; background: var(--sidebar); border-right: 1px solid var(--border); display: flex; flex-direction: column; overflow: hidden; transition: width 0.2s ease; }
    .side-header { padding: 16px; border-bottom: 1px solid var(--border); flex-shrink: 0; }
    .side-header-row { display: flex; align-items: center; justify-content: space-between; }
    .btn-close { background: none; border: none; color: var(--text-muted); font-size: 16px; cursor: pointer; padding: 4px 8px; border-radius: 4px; }
    .btn-close:hover { color: var(--text); background: var(--card-bg); }
    .search-box { width: 100%; background: var(--card-bg); border: 1px solid var(--border); color: var(--text); padding: 8px 12px; border-radius: 6px; margin-top: 8px; }
    .tree-toolbar { display: flex; gap: 8px; margin-top: 8px; }
    .tree-toolbar button { flex: 1; background: var(--card-bg); border: 1px solid var(--border); color: var(--text-muted); padding: 5px 8px; border-radius: 4px; cursor: pointer; font-size: 11px; }
    .tree-toolbar button:hover { border-color: var(--accent); color: var(--text); }
    .font-control { display: flex; align-items: center; gap: 8px; margin-top: 10px; }
    .font-control label { font-size: 12px; color: var(--text-muted); white-space: nowrap; }
    .font-control input[type=range] { flex: 1; accent-color: var(--accent); }
    .font-control .size-val { font-size: 12px; color: var(--text); width: 32px; text-align: right; }
    #card-list { flex: 1; overflow-y: auto; padding: 8px; display: flex; flex-direction: column; gap: 2px; }

    .tree-folder { display: flex; flex-direction: column; }
    .tree-folder-header { display: flex; align-items: center; gap: 6px; padding: 6px 8px; border-radius: 4px; cursor: pointer; user-select: none; }
    .tree-folder-header:hover { background: var(--card-bg); }
    .tree-toggle { width: 14px; display: inline-block; text-align: center; color: var(--text-muted); font-size: 10px; transition: transform 0.15s; flex-shrink: 0; }
    .tree-toggle.expanded { transform: rotate(90deg); }
    .tree-folder-icon { font-size: 14px; flex-shrink: 0; }
    .tree-folder-name { font-size: 13px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .tree-folder-count { font-size: 11px; color: var(--text-muted); background: rgba(99,102,241,0.12); padding: 0 6px; border-radius: 8px; margin-left: auto; }
    .tree-folder-children { padding-left: 14px; margin-left: 8px; border-left: 1px solid var(--border); display: flex; flex-direction: column; gap: 2px; }
    .tree-folder-spacer { height: 2px; }

    .card-item { display: flex; gap: 12px; padding: 8px; border-radius: 6px; cursor: pointer; border: 1px solid transparent; background: transparent; transition: background 0.15s; }
    .card-item:hover { background: var(--card-bg); }
    .card-item.active { background: var(--card-bg); border-color: var(--accent); }
    .thumb { width: 46px; height: 46px; border-radius: 4px; object-fit: cover; background: #000; flex-shrink: 0; }
    .card-info { overflow: hidden; min-width: 0; }
    .card-title { font-size: 14px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .card-meta { font-size: 11px; color: var(--text-muted); margin-top: 2px; }
    .badge-list { display: flex; gap: 4px; flex-wrap: wrap; margin-top: 4px; }
    .badge { font-size: 10px; background: rgba(99,102,241,0.15); color: #818cf8; padding: 1px 5px; border-radius: 3px; }
    .empty-hint { padding: 16px; color: var(--text-muted); font-size: 13px; text-align: center; }

    #resizer { width: 4px; background: transparent; cursor: col-resize; flex-shrink: 0; transition: background 0.15s; }
    #resizer:hover, #resizer.active { background: var(--accent); }

    #viewer { flex: 1; overflow-y: auto; padding: 24px; display: flex; flex-direction: column; gap: 20px; font-size: var(--viewer-font-size); position: relative; }

    #sidebar-toggle { position: fixed; top: 12px; left: 12px; z-index: 100; background: var(--card-bg); border: 1px solid var(--border); color: var(--text); width: 36px; height: 36px; border-radius: 6px; cursor: pointer; font-size: 16px; display: flex; align-items: center; justify-content: center; }
    #sidebar-toggle:hover { border-color: var(--accent); color: #fff; }

    .hero { display: flex; gap: 20px; background: var(--card-bg); border: 1px solid var(--border); border-radius: 8px; padding: 16px; }
    .avatar-large { width: 160px; height: 220px; border-radius: 6px; object-fit: cover; background: #000; flex-shrink: 0; border: 1px solid var(--border); }
    .hero-details { flex: 1; display: flex; flex-direction: column; gap: 8px; }
    .hero-details h1 { font-size: 24px; font-weight: 700; color: #fff; }
    .hero-meta { font-size: 13px; color: var(--text-muted); display: flex; gap: 16px; flex-wrap: wrap; }

    .tabs { display: flex; gap: 8px; border-bottom: 1px solid var(--border); padding-bottom: 8px; flex-wrap: wrap; }
    .tab-btn { background: none; border: none; color: var(--text-muted); font-size: 14px; font-weight: 600; padding: 6px 12px; border-radius: 4px; cursor: pointer; }
    .tab-btn.active { color: #fff; background: var(--accent); }

    .panel { display: flex; flex-direction: column; gap: 16px; }
    .field-card { background: var(--card-bg); border: 1px solid var(--border); border-radius: 6px; padding: 16px; }
    .field-title { font-size: 12px; font-weight: 700; text-transform: uppercase; color: var(--text-muted); margin-bottom: 8px; letter-spacing: 0.05em; display: flex; justify-content: space-between; align-items: center; }
    .content-box { font-size: var(--viewer-font-size); line-height: 1.6; word-break: break-word; }
    .content-box p { margin: 0 0 8px; }
    .content-box p:last-child { margin-bottom: 0; }
    .content-box ul, .content-box ol { margin: 0 0 8px; padding-left: 20px; }
    .content-box li { margin: 2px 0; }
    .content-box h1, .content-box h2, .content-box h3 { margin: 12px 0 8px; color: #fff; }
    .content-box h1 { font-size: 1.5em; } .content-box h2 { font-size: 1.3em; } .content-box h3 { font-size: 1.15em; }
    .content-box code { background: rgba(99,102,241,0.15); padding: 0 4px; border-radius: 3px; font-family: monospace; font-size: 0.9em; }
    .content-box pre { background: #11131a; padding: 10px; border-radius: 4px; overflow-x: auto; margin: 8px 0; }
    .content-box pre code { background: none; padding: 0; font-size: 12px; }
    .content-box blockquote { border-left: 3px solid var(--accent); padding-left: 12px; color: var(--text-muted); margin: 8px 0; }
    .content-box strong { color: #fff; }
    .content-box em { color: #cbd5e1; font-style: italic; }
    .content-box a { color: #818cf8; text-decoration: underline; }
    .content-box table { border-collapse: collapse; margin: 8px 0; }
    .content-box th, .content-box td { border: 1px solid var(--border); padding: 4px 8px; }
    .content-box hr { border: none; border-top: 1px solid var(--border); margin: 12px 0; }
    .macro { color: #a5b4fc; font-weight: 600; background: rgba(99,102,241,0.15); padding: 0 4px; border-radius: 3px; }

    .lore-entry { border-left: 3px solid var(--accent); padding-left: 12px; margin-bottom: 16px; }
    .lore-keys { font-size: 12px; color: #818cf8; margin-bottom: 4px; font-family: monospace; }
    .btn-action { background: var(--card-bg); border: 1px solid var(--border); color: var(--text); padding: 6px 12px; border-radius: 4px; cursor: pointer; font-size: 12px; }
    .btn-action:hover { border-color: var(--accent); }
  </style>
</head>
<body>
  <button id="sidebar-toggle" onclick="setSidebar(true)" title="Open sidebar">☰</button>

  <div id="sidebar">
    <div class="side-header">
      <div class="side-header-row">
        <h2 style="font-size: 16px;">Cards Explorer</h2>
        <button class="btn-close" onclick="setSidebar(false)" title="Close sidebar">✕</button>
      </div>
      <div class="font-control">
        <label>Text Size</label>
        <input type="range" id="fontSizeRange" min="10" max="24" value="14" oninput="setFontSize(this.value)">
        <span class="size-val" id="fontSizeVal">14px</span>
      </div>
      <input type="text" id="searchInput" class="search-box" placeholder="Search cards, tags, creators...">
      <div class="tree-toolbar">
        <button onclick="expandAll()">Expand All</button>
        <button onclick="collapseAll()">Collapse All</button>
      </div>
    </div>
    <div id="card-list"></div>
  </div>

  <div id="resizer"></div>

  <div id="viewer">
    <div style="margin: auto; color: var(--text-muted);">Select a character card to view details.</div>
  </div>

  <script>
    let cards = [];
    let currentCard = null;
    const expandedFolders = new Set();

    // Sidebar resize & collapse
    let sidebarWidth = 380;
    let isResizing = false;

    function setSidebar(open) {
      const sb = document.getElementById('sidebar');
      const resizer = document.getElementById('resizer');
      const toggle = document.getElementById('sidebar-toggle');
      if (open) {
        sb.style.width = sidebarWidth + 'px';
        resizer.style.display = '';
        toggle.style.display = 'none';
      } else {
        sb.style.width = '0px';
        resizer.style.display = 'none';
        toggle.style.display = '';
      }
    }

    function setFontSize(val) {
      document.documentElement.style.setProperty('--viewer-font-size', val + 'px');
      document.getElementById('fontSizeVal').textContent = val + 'px';
    }

    const resizer = document.getElementById('resizer');
    resizer.addEventListener('mousedown', (e) => {
      isResizing = true;
      resizer.classList.add('active');
      document.body.style.userSelect = 'none';
      document.body.style.cursor = 'col-resize';
    });
    document.addEventListener('mousemove', (e) => {
      if (!isResizing) return;
      const w = e.clientX;
      if (w > 250 && w < 800) {
        sidebarWidth = w;
        document.getElementById('sidebar').style.width = w + 'px';
      }
    });
    document.addEventListener('mouseup', () => {
      if (isResizing) {
        isResizing = false;
        resizer.classList.remove('active');
        document.body.style.userSelect = '';
        document.body.style.cursor = '';
      }
    });

    // Collapsed by default
    setSidebar(true);

    function splitFolder(folder) {
      if (!folder || folder === '/') return [];
      return folder.split(/[\\\\/]/).filter(Boolean);
    }

    function buildTree(cardList) {
      const root = { name: '', path: '', folders: {}, cards: [] };
      cardList.forEach(c => {
        const parts = splitFolder(c.folder);
        let node = root;
        let curPath = '';
        parts.forEach(p => {
          curPath = curPath ? curPath + '/' + p : p;
          if (!node.folders[p]) {
            node.folders[p] = { name: p, path: curPath, folders: {}, cards: [] };
          }
          node = node.folders[p];
        });
        node.cards.push(c);
      });
      return root;
    }

    function countCardsInFolder(node) {
      let count = node.cards.length;
      Object.values(node.folders).forEach(f => count += countCardsInFolder(f));
      return count;
    }

    function collectFolderPaths(node, out) {
      Object.values(node.folders).forEach(f => {
        out.push(f.path);
        collectFolderPaths(f, out);
      });
      return out;
    }

    function expandAll() {
      const tree = buildTree(cards);
      collectFolderPaths(tree, []).forEach(p => expandedFolders.add(p));
      renderList();
    }

    function collapseAll() {
      expandedFolders.clear();
      renderList();
    }

    function toggleFolder(path) {
      if (expandedFolders.has(path)) expandedFolders.delete(path);
      else expandedFolders.add(path);
      renderList();
    }

    function matchesSearch(c, search) {
      if (!search) return true;
      return c.name.toLowerCase().includes(search) ||
             c.creator.toLowerCase().includes(search) ||
             c.tags.some(t => t.toLowerCase().includes(search));
    }

    async function init() {
      const res = await fetch('/api/cards');
      cards = await res.json();
      // Collapse top-level folders by default
      // const tree = buildTree(cards);
      // Object.values(tree.folders).forEach(f => expandedFolders.add(f.path));
      renderList();
    }

    function renderList() {
      const search = document.getElementById('searchInput').value.toLowerCase().trim();
      const list = document.getElementById('card-list');
      list.innerHTML = '';

      const filteredCards = cards.filter(c => matchesSearch(c, search));
      const isSearching = search.length > 0;
      const tree = buildTree(filteredCards);

      if (filteredCards.length === 0) {
        list.innerHTML = '<div class="empty-hint">No cards found.</div>';
        return;
      }

      renderTreeNode(tree, list, isSearching);
    }

    function renderTreeNode(node, container, isSearching) {
      // Render subfolders (sorted)
      const folderNames = Object.keys(node.folders).sort((a, b) => a.localeCompare(b));
      folderNames.forEach(name => {
        const folder = node.folders[name];
        const totalCount = countCardsInFolder(folder);
        if (totalCount === 0) return;

        const isExpanded = isSearching || expandedFolders.has(folder.path);

        const folderEl = document.createElement('div');
        folderEl.className = 'tree-folder';

        const header = document.createElement('div');
        header.className = 'tree-folder-header';
        header.onclick = () => toggleFolder(folder.path);
        header.innerHTML =
          '<span class="tree-toggle' + (isExpanded ? ' expanded' : '') + '">▶</span>' +
          '<span class="tree-folder-icon">📁</span>' +
          '<span class="tree-folder-name">' + escapeHtml(name) + '</span>' +
          '<span class="tree-folder-count">' + totalCount + '</span>';
        folderEl.appendChild(header);

        if (isExpanded) {
          const children = document.createElement('div');
          children.className = 'tree-folder-children';
          renderTreeNode(folder, children, isSearching);
          folderEl.appendChild(children);
        }
        container.appendChild(folderEl);
      });

      // Render cards directly in this folder
      node.cards.slice().sort((a, b) => a.name.localeCompare(b.name)).forEach(c => {
        const item = document.createElement('div');
        item.className = 'card-item' + (currentCard?.filePath === c.relPath ? ' active' : '');
        item.onclick = () => loadCard(c.relPath);
        item.innerHTML =
          '<img class="thumb" src="/api/image?path=' + encodeURIComponent(c.relPath) + '" loading="lazy" onerror="this.src=\\'data:image/svg+xml;utf8,<svg xmlns=\\'http://www.w3.org/2000/svg\\' width=\\'46\\' height=\\'46\\'><rect width=\\'100%\\' height=\\'100%\\' fill=\\'%23222\\'/></svg>\\'">' +
          '<div class="card-info">' +
            '<div class="card-title">' + escapeHtml(c.name) + '</div>' +
            '<div class="card-meta">' + escapeHtml(c.creator) + '</div>' +
            '<div class="badge-list">' +
              (c.hasLorebook ? '<span class="badge">Lorebook</span>' : '') +
              (c.altGreetingsCount > 0 ? '<span class="badge">' + c.altGreetingsCount + ' Alt</span>' : '') +
              c.tags.slice(0, 3).map(t => '<span class="badge">' + escapeHtml(t) + '</span>').join('') +
            '</div>' +
          '</div>';
        container.appendChild(item);
      });
    }

    function escapeHtml(s) {
      return String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    async function loadCard(relPath) {
      const res = await fetch('/api/card?path=' + encodeURIComponent(relPath));
      currentCard = await res.json();
      renderList();
      renderViewer();
    }

    function renderContent(text) {
      if (!text) return '';
      // Do not escape HTML before parsing. SillyTavern cards use raw HTML/CSS
      // for styling (like background images in creator_notes), and marked will
      // pass valid HTML through while formatting the Markdown around it.
      const html = marked.parse(text);
      return html.replace(/\{\{(char|user)\}\}/gi, '<span class="macro">{{$1}}</span>');
    }

    function renderViewer() {
      const v = document.getElementById('viewer');
      const d = currentCard.data || {};
      const altGreetings = d.alternate_greetings || [];
      const loreEntries = d.character_book?.entries || [];

      v.innerHTML = \`
        <div class="hero">
          <img class="avatar-large" src="\${currentCard.resolvedAvatar}">
          <div class="hero-details">
            <h1>\${escapeHtml(d.name || 'Unnamed')}</h1>
            <div class="hero-meta">
              <span><strong>Creator:</strong> \${escapeHtml(d.creator || 'Unknown')}</span>
              <span><strong>Version:</strong> \${escapeHtml(d.character_version || '1.0')}</span>
              <span><strong>Spec:</strong> \${escapeHtml(currentCard.spec || 'V2')}</span>
              <span><strong>Path:</strong> \${escapeHtml(currentCard.filePath)}</span>
            </div>
            <div class="badge-list" style="margin-top: 8px;">
              \${(d.tags || []).map(t => \`<span class="badge">\${escapeHtml(t)}</span>\`).join('')}
            </div>
            <div style="margin-top: auto; display: flex; gap: 8px;">
              <a href="\${currentCard.resolvedAvatar}" target="_blank" class="btn-action" style="text-decoration:none;">Open Full Image</a>
              <button class="btn-action" onclick="copyJson()">Copy Raw JSON</button>
            </div>
          </div>
        </div>

        <div class="tabs">
          <button class="tab-btn active" onclick="switchTab('tab-msg')">Messages & Dialogues</button>
          <button class="tab-btn" onclick="switchTab('tab-char')">Definition & Persona</button>
          <button class="tab-btn" onclick="switchTab('tab-prompts')">Prompts & Notes</button>
          \${loreEntries.length > 0 ? \`<button class="tab-btn" onclick="switchTab('tab-lore')">Lorebook (\${loreEntries.length})</button>\` : ''}
          <button class="tab-btn" onclick="switchTab('tab-json')">Raw JSON</button>
        </div>

        <div id="tab-msg" class="panel">
          <div class="field-card">
            <div class="field-title">First Message (Default Greeting)</div>
            <div class="content-box">\${renderContent(d.first_mes)}</div>
          </div>
          \${altGreetings.map((g, i) => \`
            <div class="field-card">
              <div class="field-title">Alternate Greeting #\${i + 1}</div>
              <div class="content-box">\${renderContent(g)}</div>
            </div>
          \`).join('')}
          <div class="field-card">
            <div class="field-title">Example Dialogues (mes_example)</div>
            <div class="content-box">\${renderContent(d.mes_example)}</div>
          </div>
        </div>

        <div id="tab-char" class="panel" style="display:none;">
          <div class="field-card">
            <div class="field-title">Description</div>
            <div class="content-box">\${renderContent(d.description)}</div>
          </div>
          <div class="field-card">
            <div class="field-title">Personality</div>
            <div class="content-box">\${renderContent(d.personality)}</div>
          </div>
          <div class="field-card">
            <div class="field-title">Scenario</div>
            <div class="content-box">\${renderContent(d.scenario)}</div>
          </div>
        </div>

        <div id="tab-prompts" class="panel" style="display:none;">
          <div class="field-card">
            <div class="field-title">System Prompt</div>
            <div class="content-box">\${renderContent(d.system_prompt)}</div>
          </div>
          <div class="field-card">
            <div class="field-title">Post-History Instructions</div>
            <div class="content-box">\${renderContent(d.post_history_instructions)}</div>
          </div>
          <div class="field-card">
            <div class="field-title">Creator's Notes</div>
            <div class="content-box">\${renderContent(d.creator_notes)}</div>
          </div>
        </div>

        \${loreEntries.length > 0 ? \`
        <div id="tab-lore" class="panel" style="display:none;">
          <div class="field-card">
            <div class="field-title">Lorebook: \${escapeHtml(d.character_book.name || 'Embedded Lorebook')}</div>
            \${loreEntries.map(e => \`
              <div class="lore-entry">
                <div class="lore-keys">Keys: \${(e.keys || []).join(', ')} \${e.secondary_keys?.length ? ' | Secondary: ' + e.secondary_keys.join(', ') : ''} [\${e.position || 'position: normal'}]</div>
                <div class="content-box">\${renderContent(e.content)}</div>
              </div>
            \`).join('')}
          </div>
        </div>
        \` : ''}

        <div id="tab-json" class="panel" style="display:none;">
          <div class="field-card">
            <pre class="content-box" style="font-family: monospace; font-size: 12px; max-height: 500px; overflow-y: auto; white-space: pre-wrap;">\${escapeHtml(JSON.stringify(currentCard, null, 2))}</pre>
          </div>
        </div>
      \`;
    }

    function switchTab(tabId) {
      document.querySelectorAll('.panel').forEach(p => p.style.display = 'none');
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.getElementById(tabId).style.display = 'flex';
      event.target.classList.add('active');
    }

    function copyJson() {
      navigator.clipboard.writeText(JSON.stringify(currentCard, null, 2));
      alert('Raw JSON copied to clipboard.');
    }

    document.getElementById('searchInput').addEventListener('input', renderList);

    init();
  </script>
</body>
</html>`;
