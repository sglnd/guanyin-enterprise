import {
  validateUploadFile,
  uploadKnowledgeFile,
  newUploadId,
} from "./app-knowledge-upload.js";
// Deliberately limited Markdown: only static tags; no HTML, links or remote assets.
export function wikiPreview(content) {
  const escape = (s) =>
    String(s).replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
  const inline = (s) =>
    escape(s)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  const lines = String(content || "尚未生成 Wiki").split("\n"),
    out = [];
  let code = false,
    fence = "";
  const cells = (line) =>
    line
      .trim()
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split(/(?<!\\)\|/)
      .map((cell) => cell.trim().replace(/\\\|/g, "|"));
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i],
      marker = /^\s*(```|~~~)/.exec(line);
    if (marker && (!code || marker[1] === fence)) {
      code = !code;
      fence = marker[1];
      out.push(code ? "<pre><code>" : "</code></pre>");
      continue;
    }
    if (code) {
      out.push(escape(line) + "\n");
      continue;
    }
    const separator = lines[i + 1];
    if (
      line.includes("|") &&
      separator &&
      /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(separator)
    ) {
      const headers = cells(line),
        rows = [];
      i++;
      while (lines[i + 1]?.includes("|") && lines[i + 1].trim()) {
        rows.push(cells(lines[++i]));
      }
      out.push(
        `<div class="kb-wiki-table"><table><thead><tr>${headers.map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${headers.map((_, index) => `<td>${inline(row[index] || "")}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`,
      );
      continue;
    }
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading)
      out.push(
        `<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`,
      );
    else if (/^\s*[-*]\s+/.test(line))
      out.push(
        `<p class="kb-bullet">• ${inline(line.replace(/^\s*[-*]\s+/, ""))}</p>`,
      );
    else if (/^>\s?/.test(line))
      out.push(`<blockquote>${inline(line.replace(/^>\s?/, ""))}</blockquote>`);
    else if (line.trim()) out.push(`<p>${inline(line)}</p>`);
  }
  return out.join("") + (code ? "</code></pre>" : "");
}

// Menus keep keyboard/touch support and also dismiss when the pointer leaves.
export function initKnowledgeMenus(root) {
  const timers = new WeakMap();
  const close = (menu) => {
    clearTimeout(timers.get(menu));
    menu.open = false;
  };
  root.addEventListener("pointerout", (e) => {
    const menu = e.target.closest?.("details.kb-more");
    if (menu && !menu.contains(e.relatedTarget))
      timers.set(
        menu,
        setTimeout(() => close(menu), 180),
      );
  });
  root.addEventListener("pointerover", (e) => {
    const menu = e.target.closest?.("details.kb-more");
    if (menu) clearTimeout(timers.get(menu));
  });
  root.addEventListener(
    "toggle",
    (e) => {
      if (e.target.matches?.("details.kb-more[open]"))
        root.querySelectorAll("details.kb-more[open]").forEach((m) => {
          if (m !== e.target) close(m);
        });
    },
    true,
  );
  root.addEventListener("click", (e) => {
    const menu = e.target.closest?.("details.kb-more");
    if (menu && e.target.closest("summary") && !menu.open)
      root.querySelectorAll("details.kb-more[open]").forEach((other) => {
        if (other !== menu) close(other);
      });
    if (menu && e.target.closest("button")) close(menu);
  });
  root.addEventListener("focusout", (e) => {
    const menu = e.target.closest?.("details.kb-more");
    if (menu && !menu.contains(e.relatedTarget)) close(menu);
  });
  root.ownerDocument.addEventListener("pointerdown", (e) =>
    root.querySelectorAll("details.kb-more[open]").forEach((m) => {
      if (!m.contains(e.target)) close(m);
    }),
  );
  root.ownerDocument.addEventListener(
    "keydown",
    (e) => {
      if (e.key !== "Escape") return;
      const menus = [...root.querySelectorAll("details.kb-more[open]")];
      if (menus.length) {
        e.preventDefault();
        e.stopPropagation();
        menus.forEach(close);
        menus[0].querySelector("summary")?.focus();
      }
    },
    true,
  );
}

export function initKnowledge({ request: transport, currentUser, esc, toast }) {
  const root = document.querySelector("#knowledge-view");
  initKnowledgeMenus(root);
  root.ownerDocument.addEventListener("keydown", (event) => {
    if (
      event.key !== "/" ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey ||
      root.classList.contains("hidden") ||
      root.querySelector("dialog[open]") ||
      event.target.closest?.("input,textarea,select,[contenteditable=true]")
    )
      return;
    const search = root.querySelector("#kb-doc-query");
    if (search && !search.closest(".hidden")) {
      event.preventDefault();
      search.focus();
    }
  });
  const icon = (name) => {
    const paths = {
      book: '<path d="M4 4h6a3 3 0 0 1 3 3v14a4 4 0 0 0-4-2H4z"/><path d="M20 4h-4a3 3 0 0 0-3 3v14a4 4 0 0 1 4-2h3z"/>',
      file: '<path d="M14 3H5v18h14V8z"/><path d="M14 3v6h5M8 13h8M8 17h5"/>',
      clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
      settings:
        '<path d="M4 6h16M4 12h16M4 18h16"/><circle cx="9" cy="6" r="2"/><circle cx="15" cy="12" r="2"/><circle cx="9" cy="18" r="2"/>',
      search: '<circle cx="10" cy="10" r="6"/><path d="m15 15 5 5"/>',
      layers: '<path d="m12 3 10 5-10 5L2 8zM2 12l10 5 10-5M2 16l10 5 10-5"/>',
      chat: '<path d="M4 4h16v12H9l-5 4z"/>',
      users:
        '<circle cx="9" cy="8" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3M16 5a3 3 0 0 1 0 6M19 21v-4a5 5 0 0 0-3-4"/>',
    };
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.book}</svg>`;
  };
  const time = (value) =>
    value && !Number.isNaN(new Date(value).getTime())
      ? new Date(value).toLocaleString("zh-CN", {
          timeZone: "Asia/Shanghai",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
        })
      : "—";
  const size = (value) =>
    value == null
      ? "—"
      : Number(value) < 1024
        ? `${value} B`
        : Number(value) < 1048576
          ? `${(Number(value) / 1024).toFixed(1)} KB`
          : `${(Number(value) / 1048576).toFixed(1)} MB`;
  const prepareMenus = () =>
    root.querySelectorAll("details.kb-more").forEach((menu) => {
      if (menu.querySelector(".kb-menu-items")) return;
      const items = document.createElement("div");
      items.className = "kb-menu-items";
      [...menu.children]
        .filter((x) => x.tagName !== "SUMMARY")
        .forEach((x) => items.append(x));
      menu.append(items);
    });
  let page = 1,
    total = 0,
    selected = null,
    detail = null,
    timer,
    sequence = 0,
    docPage = 1,
    docPageSize = 20,
    docQuery = "",
    docState = "",
    tab = "documents",
    uploading = false,
    libKind = "all",
    libQuery = "",
    libSort = "updated",
    libSearchTimer,
    docFormat = "",
    sessionEpoch = 0,
    identity = null,
    uploadController = null;
  const request = async (...args) => {
    const epoch = sessionEpoch;
    try {
      return await transport(...args);
    } finally {
      if (epoch !== sessionEpoch)
        throw new DOMException("登录身份已变化", "AbortError");
    }
  };
  function reset() {
    uploadController?.abort();
    uploadController = null;
    sessionEpoch++;
    sequence++;
    clearTimeout(timer);
    clearTimeout(libSearchTimer);
    selected = null;
    detail = null;
    identity = null;
    uploading = false;
    page = 1;
    total = 0;
    docPage = 1;
    docPageSize = 20;
    docQuery = "";
    docState = "";
    docFormat = "";
    tab = "documents";
    libKind = "all";
    libQuery = "";
    libSort = "updated";
    root.querySelectorAll("dialog[open]").forEach((dialog) => dialog.close());
    root.replaceChildren();
  }
  const html = (s) => esc(String(s ?? ""));
  const api = (path = "", method = "GET", body) =>
    request("/api/knowledge" + path, {
      method,
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  const run = async (fn) => {
    try {
      await fn();
    } catch (e) {
      if (e.name !== "AbortError") toast(e.message, "error");
    }
  };
  const status = {
    queued: "排队中",
    running: "处理中",
    failed: "处理失败",
    review: "待审核",
    published: "已发布",
  };
  async function load() {
    clearTimeout(timer);
    const user = currentUser();
    const nextIdentity = user
      ? JSON.stringify([
          user.id,
          user.tenantId,
          user.role,
          Boolean(user.knowledgeAdmin),
        ])
      : null;
    if (nextIdentity !== identity) {
      reset();
      identity = nextIdentity;
    }
    if (!user?.knowledgeEnabled) return;
    const seq = ++sequence;
    if (!root.children.length)
      root.innerHTML = '<div class="loading">正在加载知识库…</div>';
    try {
      if (selected) {
        const data = await api("/" + selected);
        if (seq !== sequence) return;
        detail = data;
        if (!root.querySelector("dialog[open]")) renderLibrary();
        if (
          data.library.maintain &&
          data.documents.some((d) => ["queued", "running"].includes(d.state))
        )
          timer = setTimeout(() => {
            if (!root.classList.contains("hidden")) void load();
          }, 4000);
        return;
      }
      const searchFocused =
        root.querySelector("#kb-library-query") === document.activeElement;
      const caret = root.querySelector("#kb-library-query")?.selectionStart;
      const data = await api(
        "?" +
          new URLSearchParams({
            page,
            kind: libKind,
            q: libQuery,
            sort: libSort,
          }),
      );
      if (seq !== sequence) return;
      total = data.total;
      const summary = data.summary || { all: total, personal: 0, public: 0 };
      const canPublic =
        currentUser().role === "platform_admin" || currentUser().knowledgeAdmin;
      root.innerHTML = `<div class="page-head kb-home-head"><div><div class="kb-eyebrow"><span>KNOWLEDGE ENGINE</span><small>企业知识与来源引用</small></div><h1>知识库</h1><p>让资料成为可检索、可追溯的知识。管理文档与操作手册，为空间提供业务上下文。</p></div><div class="page-actions">${currentUser().role === "platform_admin" ? `<button id="kb-settings" class="secondary">${icon("settings")} 模型设置</button>` : ""}<button id="kb-new" class="primary">＋ 新建知识库</button></div></div>
      <div class="kb-overview"><div class="kb-overview-number">${summary.all}</div><div class="kb-overview-copy"><strong>可访问的知识库 <span>3 步积累知识</span></strong><p>上传原文，生成 Wiki 草稿；审核发布后，让空间带着来源回答。</p>${canPublic ? "<small>你可以创建个人库，并维护本租户公共知识库。</small>" : ""}</div><div class="kb-flow"><span>${icon("file")} 文档整理</span><b>›</b><span>${icon("layers")} 审核与索引</span><b>›</b><span>${icon("chat")} 空间引用</span></div></div>
      <div class="kb-library-toolbar"><h2>全部知识库</h2><div class="kb-segments" role="group" aria-label="知识库类型">${[
        ["all", "全部"],
        ["personal", "个人库"],
        ["public", "公共库"],
      ]
        .map(
          ([v, label]) =>
            `<button data-lib-kind="${v}" aria-pressed="${v === libKind}">${label} (${summary[v]})</button>`,
        )
        .join(
          "",
        )}</div><label class="kb-library-search">${icon("search")}<input id="kb-library-query" type="search" placeholder="搜索知识库名称或描述…" value="${html(libQuery)}"></label><select id="kb-library-sort" aria-label="知识库排序"><option value="updated" ${libSort === "updated" ? "selected" : ""}>最近更新</option><option value="name" ${libSort === "name" ? "selected" : ""}>名称排序</option></select></div>
      <div class="kb-grid">${data.rows.map((k) => `<article class="kb-card kb-library-card ${k.kind === "public" ? "kb-public" : ""}"><div class="kb-card-top"><span class="kb-book-icon">${icon(k.kind === "public" ? "users" : "book")}</span><div><span class="kb-card-type">${k.kind === "personal" ? "个人库" : "公共库"}</span>${k.maintain ? `<details class="kb-more"><summary aria-label="${html(k.name)}的更多操作">⋮</summary><button class="secondary" data-library-edit="${k.id}">编辑资料</button></details>` : ""}</div></div><button class="kb-card-title" data-library="${k.id}"><h2>${html(k.name)}</h2></button><p class="kb-card-description">${html(k.description || (k.kind === "personal" ? "整理个人资料与实践经验，授权后供空间使用。" : "集中维护团队知识，按授权范围共享使用。"))}</p><div class="kb-card-metadata"><span>${icon("file")} ${Number(k.document_count || 0)} 篇文档</span><span>${icon("clock")} ${html(time(k.updated_at || k.created_at))}</span></div><div class="kb-card-footer"><span class="kb-health ${k.failed_count ? "warning" : ""}"><i></i>${k.failed_count ? `${k.failed_count} 篇处理失败` : k.processing_count ? `${k.processing_count} 篇处理中` : k.maintain ? "可维护" : "已获授权"}</span><button class="kb-open" data-library="${k.id}">打开知识库 →</button></div></article>`).join("") || '<div class="kb-empty"><span>▤</span><h3>暂无符合条件的知识库</h3><p>创建个人知识库，或请知识管理员授权公共资料。</p></div>'}</div>
      <div class="kb-library-pager"><span>显示第 ${total ? (page - 1) * 20 + 1 : 0} 到 ${Math.min(page * 20, total)} 项，共 ${total} 个知识库</span><div class="pager"><button id="kb-prev" class="secondary" ${page === 1 ? "disabled" : ""}>上一页</button><span>${page} / ${Math.max(1, Math.ceil(total / 20))}</span><button id="kb-next" class="secondary" ${page * 20 >= total ? "disabled" : ""}>下一页</button></div></div><div id="kb-panel"></div>`;
      prepareMenus();
      if (searchFocused) {
        const field = root.querySelector("#kb-library-query");
        field.focus();
        field.setSelectionRange(caret, caret);
      }
      root.querySelectorAll("[data-lib-kind]").forEach(
        (button) =>
          (button.onclick = () => {
            libKind = button.dataset.libKind;
            page = 1;
            void load();
          }),
      );
      root.querySelector("#kb-library-query").oninput = (e) => {
        libQuery = e.target.value;
        clearTimeout(libSearchTimer);
        libSearchTimer = setTimeout(() => {
          page = 1;
          void load();
        }, 300);
      };
      root.querySelector("#kb-library-sort").onchange = (e) => {
        libSort = e.target.value;
        page = 1;
        void load();
      };
      root
        .querySelectorAll("[data-library-edit]")
        .forEach(
          (button) =>
            (button.onclick = () =>
              libraryForm(
                data.rows.find((k) => k.id === button.dataset.libraryEdit),
              )),
        );
      root.querySelectorAll("[data-library]").forEach(
        (b) =>
          (b.onclick = () => {
            selected = b.dataset.library;
            docPage = 1;
            docQuery = "";
            docState = "";
            docFormat = "";
            tab = "documents";
            void run(load);
          }),
      );
      root.querySelector("#kb-prev").onclick = () => {
        page--;
        void run(load);
      };
      root.querySelector("#kb-next").onclick = () => {
        page++;
        void run(load);
      };
      root.querySelector("#kb-new").onclick = () => libraryForm();
      const settings = root.querySelector("#kb-settings");
      if (settings) settings.onclick = () => void run(settingsForm);
    } catch (e) {
      if (seq === sequence && e.name !== "AbortError") {
        root.innerHTML = `<div class="kb-empty"><h3>${selected ? "此知识库当前不可访问" : "暂时无法加载知识库"}</h3><p>${html(e.message)}${selected ? "。可能已撤销授权、资料已删除，或账号已切换。" : ""}</p><button class="secondary" id="kb-return-list">返回知识库列表</button></div>`;
        root.querySelector("#kb-return-list").onclick = () => {
          selected = null;
          void load();
        };
      }
    }
  }
  function panel(content, wide = false) {
    clearTimeout(timer);
    root.querySelector("#kb-panel").innerHTML =
      `<dialog class="modal ${wide ? "kb-reader" : "kb-modal"}"><div class="dialog-card"><button type="button" class="icon-close kb-close" aria-label="关闭">×</button>${content}</div></dialog>`;
    const dialog = root.querySelector("#kb-panel dialog");
    dialog.addEventListener("cancel", (e) => {
      if (
        dialog.dataset.dirty === "true" &&
        !confirm("存在未保存的修订，确认关闭？")
      )
        e.preventDefault();
    });
    dialog.querySelector(".kb-close").onclick = () => {
      if (
        dialog.dataset.dirty !== "true" ||
        confirm("存在未保存的修订，确认关闭？")
      )
        dialog.close();
    };
    dialog.addEventListener("close", () => {
      if (selected && !root.classList.contains("hidden")) void load();
    });
    dialog.showModal();
    return dialog;
  }
  function libraryForm(library) {
    const p = panel(
      `<span class="eyebrow">KNOWLEDGE BASE</span><h2>${library ? "编辑知识库" : "新建知识库"}</h2><form><label>名称<input name="name" maxlength="120" value="${html(library?.name || "")}" required></label><label>用途描述<textarea name="description" rows="3" maxlength="500" placeholder="介绍资料用途，帮助使用者选择合适的知识库。">${html(library?.description || "")}</textarea></label>${library ? `<p class="kb-muted">${library.kind === "public" ? "公共库" : "个人库"} · 库类型创建后不可更改</p>` : `<label>类型<select name="kind"><option value="personal">个人库（默认私有）</option>${currentUser().role === "platform_admin" || currentUser().knowledgeAdmin ? '<option value="public">本租户公共库</option>' : ""}</select></label>`}<div class="dialog-actions"><button type="button" class="secondary" data-cancel>取消</button><button class="primary">${library ? "保存修改" : "创建知识库"}</button></div></form>`,
    );
    p.querySelector("[data-cancel]").onclick = () => p.close();
    p.querySelector("form").onsubmit = (e) => {
      e.preventDefault();
      void run(async () => {
        const button = e.target.querySelector(".primary");
        button.disabled = true;
        try {
          const input = Object.fromEntries(new FormData(e.target));
          if (library) await api("/" + library.id, "PATCH", input);
          else selected = (await api("", "POST", input)).id;
          p.close();
          await load();
        } finally {
          button.disabled = false;
        }
      });
    };
  }
  async function settingsForm() {
    const [{ providers }, cfg] = await Promise.all([
      request("/api/admin/model-providers"),
      api("/settings"),
    ]);
    const models = providers
      .filter((p) => p.enabled && p.config.api === "openai-completions")
      .flatMap((p) =>
        (p.config.models || []).map((m) => ({
          provider: p.id,
          id: m.id,
          maxTokens: m.maxTokens,
          label: `${p.name} / ${m.name || m.id}${m.name && m.name !== m.id ? " · " + m.id : ""}`,
        })),
      );
    const options =
      '<option value="">请选择已登记模型</option>' +
      models
        .map((m, i) => `<option value="${i}">${html(m.label)}</option>`)
        .join("");
    const p =
      panel(`<span class="eyebrow">MODEL SETTINGS</span><h2>知识模型设置</h2><p class="kb-muted">直接复用模型管理中的地址、模型名称及凭据。</p><form>
      <label>Wiki 整理模型<select name="chat" required>${options}</select><small>负责将原文整理为待审核的知识草稿。</small></label>
      <label>向量模型<select name="embedding" required>${options}</select><small>须支持 embeddings 接口。模型管理尚未标记能力，请选择实际支持向量化的模型。</small></label>
      ${models.length ? "" : '<p role="alert">没有可用模型，请先在模型管理中登记并启用 OpenAI 兼容模型。</p>'}
      <fieldset class="kb-generation-policy"><legend>Wiki 生成与恢复</legend><div class="kb-chunk-inputs"><label>首次整理预算<input type="number" name="draftMaxTokens" min="1000" max="64000" step="1" value="${Number(cfg.draftMaxTokens || 16000)}" required><small>包含推理和正文，单位 token。</small></label><label>自动重试预算上限<input type="number" name="draftRetryMaxTokens" min="1000" max="64000" step="1" value="${Number(cfg.draftRetryMaxTokens || 32000)}" required><small>格式错误或截断时最多再生成一次。</small></label></div><p id="kb-generation-cap" class="kb-muted"></p><p class="kb-muted">实际预算受模型管理中 maxTokens 的更低上限约束。请按模型服务能力设置，较大预算可能增加耗时和费用。保存后用于新任务及手动重试，无需重发版或重传原文；运行中任务按启动时配置完成。</p></fieldset>
      <p class="kb-note">更换向量模型后，已有资料需要重新整理发布。知识模型调用暂不计入 DSH 用量统计。</p>
      <div class="dialog-actions"><button type="button" class="secondary" data-cancel>取消</button><button class="primary" ${models.length ? "" : "disabled"}>保存设置</button></div></form>`);
    const f = p.querySelector("form");
    for (const kind of ["chat", "embedding"]) {
      const i = models.findIndex(
        (m) =>
          m.provider === cfg[kind + "Provider"] && m.id === cfg[kind + "Model"],
      );
      f.elements[kind].value = i < 0 ? "" : String(i);
      if (i < 0 && cfg[kind + "Model"])
        f.elements[kind].insertAdjacentHTML(
          "afterend",
          '<small role="alert">原选择已不可用，请重新选择。</small>',
        );
    }
    const showCap = () => {
      const m = models[Number(f.elements.chat.value)];
      p.querySelector("#kb-generation-cap").textContent = m?.maxTokens
        ? `所选模型已登记 maxTokens：${m.maxTokens}。如需超过该值，请先核实服务能力，再到模型管理调整。`
        : "所选模型未登记 maxTokens，请按实际服务支持的输出上限设置预算。";
    };
    f.elements.chat.onchange = showCap;
    showCap();
    p.querySelector("[data-cancel]").onclick = () => p.close();
    f.onsubmit = (e) => {
      e.preventDefault();
      void run(async () => {
        const config = {
          draftMaxTokens: Number(f.elements.draftMaxTokens.value),
          draftRetryMaxTokens: Number(f.elements.draftRetryMaxTokens.value),
        };
        if (
          !Number.isInteger(config.draftMaxTokens) ||
          config.draftMaxTokens < 1000 ||
          config.draftMaxTokens > 64000 ||
          !Number.isInteger(config.draftRetryMaxTokens) ||
          config.draftRetryMaxTokens < config.draftMaxTokens ||
          config.draftRetryMaxTokens > 64000
        )
          throw Error("预算须为 1000～64000 的整数，重试预算不能小于首次预算");
        for (const kind of ["chat", "embedding"]) {
          const model = models[Number(f.elements[kind].value)];
          if (f.elements[kind].value === "" || !model)
            throw Error("请选择已登记模型");
          config[kind + "Provider"] = model.provider;
          config[kind + "Model"] = model.id;
        }
        const button = f.querySelector("button.primary");
        button.disabled = true;
        try {
          await api("/settings", "PUT", config);
          toast("模型设置已保存");
          p.close();
        } finally {
          button.disabled = false;
        }
      });
    };
  }
  function renderLibrary() {
    const { library: k, documents } = detail;
    const boundSpaces = (detail.bindings || []).map((s) => ({
      ...s,
      bound: true,
    }));
    if (!k.maintain && tab === "bindings") tab = "documents";
    root.innerHTML = `<button id="kb-back" class="kb-back">← 全部知识库</button><div class="page-head kb-library-head"><div class="kb-title"><span class="kb-book-icon">${icon("book")}</span><div><div class="kb-library-title-row"><h1>${html(k.name)}</h1><span class="kb-access-badge">${k.maintain ? "可维护" : "只读访问"}</span><span class="kb-kind-badge">${k.kind === "personal" ? "个人知识库" : "公共知识库"}</span></div><p>${documents.length} 篇资料 · 最近更新 ${html(time(documents.reduce((latest, d) => (d.updated_at && (!latest || new Date(d.updated_at) > new Date(latest)) ? d.updated_at : latest), null) || k.created_at))} · 创建人 ${html(k.owner_name || "—")}</p>${k.description ? `<p class="kb-library-description">${html(k.description)}</p>` : ""}</div></div><div class="page-actions">${k.maintain ? '<button id="kb-bind" class="secondary">空间接入</button>' : ""}${k.maintain && k.kind === "public" ? '<button id="kb-grant" class="secondary">用户授权</button>' : ""}${k.maintain ? '<button id="kb-add" class="primary">＋ 添加资料</button>' : ""}<details class="kb-more"><summary aria-label="更多操作">•••</summary><button id="kb-refresh" class="secondary">刷新资料</button>${k.maintain ? '<button id="kb-edit-library" class="secondary">编辑资料</button>' : ""}${k.maintain ? '<button id="kb-delete" class="secondary danger">删除知识库</button>' : ""}</details></div></div>
      <div class="kb-tabs" role="tablist" aria-label="知识库内容"><button role="tab" aria-selected="${tab === "documents"}" data-tab="documents">${icon("file")} 文档管理 <span>${documents.length}</span></button><button role="tab" aria-selected="${tab === "search"}" data-tab="search">${icon("search")} 检索测试</button><button role="tab" aria-selected="${tab === "index"}" data-tab="index">${icon("settings")} 索引信息</button>${k.maintain ? `<button role="tab" aria-selected="${tab === "bindings"}" data-tab="bindings">${icon("layers")} 空间接入 <span>${boundSpaces.length}</span></button>` : ""}</div>
      <section id="kb-documents" ${tab === "documents" ? "" : 'class="hidden"'}><div class="toolbar kb-toolbar"><label class="search-field"><span>⌕</span><input id="kb-doc-query" placeholder="搜索文档名称、摘要或关键词" value="${html(docQuery)}"><kbd>/</kbd></label><select id="kb-doc-state" aria-label="文档状态"><option value="">全部状态 (${documents.length})</option>${Object.entries(
        status,
      )
        .map(
          ([v, label]) =>
            `<option value="${v}" ${docState === v ? "selected" : ""}>${label} (${documents.filter((d) => d.state === v).length})</option>`,
        )
        .join(
          "",
        )}</select><select id="kb-doc-format" aria-label="文档格式"><option value="">全部格式类型</option>${["md", "txt", "pdf", "docx", "xlsx"].map((ext) => `<option value="${ext}" ${docFormat === ext ? "selected" : ""}>${ext.toUpperCase()}</option>`).join("")}</select><button id="kb-doc-refresh" class="secondary" aria-label="刷新文档">↻</button></div><div id="kb-doc-list"></div></section>
      <section id="kb-retrieval" ${tab === "search" ? "" : 'class="hidden"'}><div class="kb-panel"><h2>检索测试</h2><p>输入一个实际问题，检查已发布知识的命中片段与来源。</p><form id="kb-search"><input name="query" placeholder="例如：磁盘容量告警应该如何处理？" maxlength="500" required><button class="primary">检索</button></form></div><div id="kb-results" aria-live="polite"></div></section><section id="kb-index-info" ${tab === "index" ? "" : 'class="hidden"'}><div class="kb-panel"><h2>索引信息</h2><p>仅审核发布的 Wiki 参与检索，新原文处理期间保留旧发布版本。</p><div class="kb-index-grid"><div><span>已发布文档</span><strong>${documents.filter((d) => d.published_version || d.state === "published").length} 篇</strong></div><div><span>当前检索分块</span><strong>${documents.reduce((n, d) => n + Number(d.chunk_count || 0), 0)} 个</strong></div><div><span>分块方式</span><strong>按文档版本保存设置</strong></div><div><span>索引生成</span><strong>审核通过后发布</strong></div></div><p>向量模型由平台统一配置；更换模型后须重新整理发布资料。</p></div></section>${k.maintain ? `<section id="kb-bound-spaces" ${tab === "bindings" ? "" : 'class="hidden"'}><div class="kb-bound-heading"><div><h2>已接入空间 (${boundSpaces.length})</h2><p>查看本库的共享范围、接入状态，或取消某个空间的接入。</p></div><button type="button" id="kb-connect-new" class="primary">＋ 接入新空间</button></div><div id="kb-bound-list">${bindingRows(boundSpaces)}</div></section>` : ""}<div id="kb-panel"></div>`;
    root.querySelector("#kb-back").onclick = () => {
      selected = null;
      void run(load);
    };
    prepareMenus();
    const editLibrary = root.querySelector("#kb-edit-library");
    if (editLibrary) editLibrary.onclick = () => libraryForm(k);
    root.querySelector("#kb-refresh").onclick = () => void run(load);
    root.querySelector("#kb-doc-refresh").onclick = () => void run(load);
    root.querySelector("#kb-doc-format").onchange = (e) => {
      docFormat = e.target.value;
      docPage = 1;
      renderDocuments();
    };
    root.querySelectorAll("[data-tab]").forEach(
      (b) =>
        (b.onclick = () => {
          tab = b.dataset.tab;
          renderLibrary();
        }),
    );
    root.querySelector("#kb-doc-query").oninput = (e) => {
      docQuery = e.target.value;
      docPage = 1;
      renderDocuments();
    };
    root.querySelector("#kb-doc-state").onchange = (e) => {
      docState = e.target.value;
      docPage = 1;
      renderDocuments();
    };
    root.querySelector("#kb-search").onsubmit = (e) => {
      e.preventDefault();
      void run(async () => {
        const button = e.target.querySelector("button");
        button.disabled = true;
        const output = root.querySelector("#kb-results");
        output.textContent = "正在检索…";
        try {
          const r = await api("/" + selected + "/search", "POST", {
            query: new FormData(e.target).get("query"),
          });
          output.innerHTML =
            r.results
              .map(
                (x, i) =>
                  `<article class="kb-panel kb-hit"><div class="kb-hit-head"><strong>${i + 1}. ${html(x.title)}</strong><span class="pill">v${x.version}</span></div><p>${html(x.library_name)} · 相关度 ${Number(x.score).toFixed(3)}</p><pre>${html(x.content)}</pre><a href="/api/knowledge/${x.library_id}/documents/${x.document_id}/source?version=${x.version}">下载对应版本原文 ↗</a></article>`,
              )
              .join("") ||
            '<div class="kb-empty"><h3>暂无命中结果</h3><p>请确认资料已审核发布，或换一种提问方式。</p></div>';
        } catch (error) {
          output.textContent = error.message;
          throw error;
        } finally {
          button.disabled = false;
        }
      });
    };
    if (k.maintain) {
      root.querySelector("#kb-add").onclick = () => uploadForm();
      root.querySelector("#kb-bind").onclick = () => void run(() => bindForm());
      root.querySelector("#kb-connect-new").onclick = () =>
        void run(() => bindForm());
      wireBindings(root.querySelector("#kb-bound-list"), boundSpaces);
      root.querySelector("#kb-delete").onclick = () =>
        void run(async () => {
          if (!confirm("删除后停止检索及全部空间接入，确认删除知识库？"))
            return;
          await api("/" + selected, "DELETE");
          selected = null;
          await load();
        });
      const grant = root.querySelector("#kb-grant");
      if (grant) grant.onclick = () => void run(grantForm);
    }
    renderDocuments();
  }
  function renderDocuments() {
    const items = detail.documents.filter(
      (d) =>
        `${d.title} ${d.summary || ""} ${(d.keywords || []).join(" ")}`
          .toLowerCase()
          .includes(docQuery.trim().toLowerCase()) &&
        (!docState || d.state === docState) &&
        (!docFormat || d.title.toLowerCase().endsWith("." + docFormat)),
    );
    docPage = Math.max(
      1,
      Math.min(docPage, Math.ceil(items.length / docPageSize)),
    );
    const list = root.querySelector("#kb-doc-list");
    list.innerHTML = items.length
      ? `<div class="kb-table-wrap"><table class="kb-table"><thead><tr><th>文档名称与摘要</th><th>处理状态</th><th>分块数 / 大小</th><th>版本与索引</th><th>操作</th></tr></thead><tbody>${items
          .slice((docPage - 1) * docPageSize, docPage * docPageSize)
          .map(
            (d) =>
              `<tr><td><button class="kb-document-title" data-doc="${d.id}"><span class="kb-file-icon">${html(d.title.split(".").pop().toUpperCase().slice(0, 5))}</span><span>${html(d.title)}<small class="kb-file-meta">SHA256: ${d.sha256 ? html(d.sha256.slice(0, 10)) + "…" : "—"} · ${size(d.byte_size)}</small></span></button>${d.summary ? `<p class="kb-document-summary">${html(d.summary)}</p>` : ""}${d.keywords?.length ? `<div class="kb-document-keywords">${d.keywords.map((k) => `<span>${html(k)}</span>`).join("")}</div>` : ""}${d.error ? `<small class="kb-error">${html(d.error)}</small>` : ""}</td><td><span class="kb-status kb-status-${html(d.state)}">${html(d.state === "running" ? { parsing: "解析中", drafting: "整理 Wiki 中", indexing: "生成索引中" }[d.phase] || "处理中" : status[d.state] || d.state)}</span></td><td><span>${Number(d.chunk_count || 0)} 个分块</span><small>${size(d.byte_size)}${d.model_info?.embeddingDimensions ? " · " + d.model_info.embeddingDimensions + " 维" : ""}</small></td><td><span class="kb-version-label">v${d.current_version}</span><small class="${d.published_version || d.state === "published" ? "kb-index-ready" : ""}">${d.published_version ? "检索 v" + d.published_version : d.state === "published" ? "可检索" : "尚未发布"}</small></td><td><div class="kb-row-actions"><button class="secondary" data-doc="${d.id}">${d.state === "review" && detail.library.maintain ? "审核 Wiki" : "查看 Wiki"}</button>${detail.library.maintain ? `${d.state === "failed" ? `<button class="secondary" data-retry="${d.id}">重试</button>` : ""}<details class="kb-more"><summary aria-label="${html(d.title)}的更多操作">•••</summary><button class="secondary" data-update="${d.id}">更新原文</button><button class="secondary danger" data-delete="${d.id}">删除文档</button></details>` : ""}</div></td></tr>`,
          )
          .join(
            "",
          )}</tbody></table><div class="kb-document-pager"><span>显示第 ${(docPage - 1) * docPageSize + 1} 至 ${Math.min(docPage * docPageSize, items.length)} 项，共 ${items.length} 条结果 <span class="kb-pager-divider">|</span> 全库已发布 ${detail.documents.filter((d) => d.published_version || d.state === "published").length} 篇，待审核 ${detail.documents.filter((d) => d.state === "review").length} 篇</span><div class="pager"><label>每页条数 <select id="kb-doc-page-size" aria-label="每页文档条数">${[10, 20, 50].map((n) => `<option value="${n}" ${docPageSize === n ? "selected" : ""}>${n}</option>`).join("")}</select></label><button id="kb-doc-prev" class="secondary" ${docPage <= 1 ? "disabled" : ""}>‹</button><span>${docPage} / ${Math.max(1, Math.ceil(items.length / docPageSize))}</span><button id="kb-doc-next" class="secondary" ${docPage * docPageSize >= items.length ? "disabled" : ""}>›</button></div></div></div>`
      : `<div class="kb-empty"><span>▤</span><h3>${docQuery || docState || docFormat ? "没有符合条件的文档" : "还没有资料"}</h3><p>${docQuery || docState || docFormat ? "试试其他名称或处理状态。" : "上传原文后，系统会生成 Wiki 草稿，审核发布后即可检索。"}</p>${detail.library.maintain && !docQuery && !docState && !docFormat ? '<button id="kb-empty-add" class="primary">＋ 添加资料</button>' : ""}</div>`;
    prepareMenus();
    const pageSizeSelect = list.querySelector("#kb-doc-page-size");
    if (pageSizeSelect)
      pageSizeSelect.onchange = (e) => {
        docPageSize = Number(e.target.value);
        docPage = 1;
        renderDocuments();
      };
    const prev = list.querySelector("#kb-doc-prev"),
      next = list.querySelector("#kb-doc-next");
    if (prev)
      prev.onclick = () => {
        docPage--;
        renderDocuments();
      };
    if (next)
      next.onclick = () => {
        docPage++;
        renderDocuments();
      };
    const add = list.querySelector("#kb-empty-add");
    if (add) add.onclick = () => uploadForm();
    list
      .querySelectorAll("[data-doc]")
      .forEach(
        (b) =>
          (b.onclick = () =>
            docForm(detail.documents.find((d) => d.id === b.dataset.doc))),
      );
    list
      .querySelectorAll("[data-update]")
      .forEach((b) => (b.onclick = () => uploadForm(b.dataset.update)));
    list.querySelectorAll("[data-retry]").forEach(
      (b) =>
        (b.onclick = () =>
          void run(async () => {
            await api(
              `/${selected}/documents/${b.dataset.retry}/process`,
              "POST",
              {},
            );
            await load();
          })),
    );
    list.querySelectorAll("[data-delete]").forEach(
      (b) =>
        (b.onclick = () =>
          void run(async () => {
            if (!confirm("确认删除原文及其可检索 Wiki？")) return;
            await api(`/${selected}/documents/${b.dataset.delete}`, "DELETE");
            await load();
          })),
    );
  }
  function uploadForm(id) {
    const libraryId = selected,
      epoch = sessionEpoch;
    const p =
      panel(`<div class="kb-import-heading"><span class="kb-import-eyebrow">↑ IMPORT DOCUMENTS / 智能资料导入</span><span id="kb-model-health" class="kb-model-health" role="status">正在检查模型配置…</span><h2>${id ? "更新原文" : "添加资料"}</h2><p>${id ? "保留旧原文与检索版本，新版审核后发布。" : "保留完整原文，整理为 Wiki 草稿；审核后生成索引，供空间引用。"}</p></div>
      <form id="kb-upload" class="kb-import-form"><div class="kb-dropzone" tabindex="0" role="button" aria-label="选择或拖拽资料"><span class="kb-upload-cloud">↑</span><strong>点击选择 或 将文档拖拽到此处</strong><div class="kb-format-tags">${["DOCX", "XLSX", "PDF", "TXT", "Markdown"].map((t) => `<span>${t}</span>`).join("")}</div><small>单文件最大 10MB；PDF 需包含文本层。${id ? "原文更新仅选择一个文件。" : "支持多选，每次队列最多 20 个文件。"}</small><button type="button" class="secondary" id="kb-browse">＋ 浏览本地文件</button><input class="hidden" name="file" type="file" accept=".docx,.xlsx,.pdf,.txt,.md" ${id ? "" : "multiple"}></div>
      <div class="kb-queue-heading"><strong>待处理文件队列 <span id="kb-queue-count">0</span></strong><button type="button" class="kb-text-button" id="kb-clear-queue">清空队列</button></div><div id="kb-upload-queue" aria-live="polite"></div>
      <details class="kb-import-advanced"><summary>${icon("settings")} 高级设置 <small>默认按标题与段落边界切分</small></summary><fieldset id="kb-processing-options"><div class="kb-strategy-options"><label><input type="radio" name="strategy" value="structured" checked><span><strong>标题与段落切分</strong><small>优先沿结构边界切分，超长段落按长度处理。</small></span></label><label><input type="radio" name="strategy" value="fixed"><span><strong>固定长度切分</strong><small>按字符长度切分，可设置前后文重叠。</small></span></label></div><div class="kb-chunk-inputs"><label>分块长度<input name="chunkSize" type="number" min="200" max="2000" value="1000" required><small>200～2000 字符</small></label><label>重叠长度<input name="overlap" type="number" min="0" max="250" value="100" required><small>不超过分块长度的 25%</small></label></div><div class="kb-processing-checks"><label><input name="cleanText" type="checkbox" checked>过滤控制字符与多余空行</label><label><input name="generateMetadata" type="checkbox" checked>自动生成摘要与关键词</label></div><p>原文文件保持不变。选项应用于本次新版本，Wiki 审核发布时按此设置生成索引。开始上传后设置锁定，清空队列可重新设置。</p></fieldset></details>
      <div class="kb-model-check"><span id="kb-model-check-note">检测连接会产生少量模型调用，检查结果仅代表检测时刻。</span><button type="button" class="secondary" id="kb-model-check">检测模型连接</button></div>
      <p id="kb-upload-status" role="status">文件格式及大小在本地校验；内容可解析性由后台确认。</p><div class="kb-import-footer"><div><strong id="kb-queue-summary">未选择文件</strong><small>清空队列不会删除已入库资料。</small></div><div class="dialog-actions"><button type="button" class="secondary" data-cancel>取消</button><button type="submit" class="primary" id="kb-start-upload" disabled>${id ? "更新并整理" : "上传并智能整理"}</button></div></div></form>`);
    p.classList.add("kb-import-modal");
    const f = p.querySelector("form"),
      zone = p.querySelector(".kb-dropzone");
    f.noValidate = true;
    let entries = [],
      active = false,
      modelOkay = false,
      queueTimer,
      disposed = false;
    const alive = () => !disposed && p.open && epoch === sessionEpoch;
    const pending = () =>
      entries.filter((e) => ["pending", "failed"].includes(e.state));
    const phaseText = (d) => {
      if (d.state === "failed")
        return `${{ parsing: "解析", drafting: "Wiki 整理", indexing: "索引生成" }[d.phase] || "后台处理"}失败：${d.error || "请重试"}`;
      return (
        {
          parsing: "解析中",
          drafting: "生成 Wiki 草稿中",
          indexing: "生成索引中",
          review: "待审核",
          published: "已发布",
          changed: "文档版本已变化，请从列表查看",
        }[d.phase] ||
        {
          queued: d.stage === "publish" ? "等待索引" : "等待解析",
          running: "后台处理中",
          review: "待审核",
          published: "已发布",
        }[d.state] ||
        "已保存"
      );
    };
    const options = () => {
      const value = {
        strategy: f.elements.strategy.value,
        chunkSize: Number(f.elements.chunkSize.value),
        overlap: Number(f.elements.overlap.value),
        cleanText: f.elements.cleanText.checked,
        generateMetadata: f.elements.generateMetadata.checked,
      };
      if (
        !Number.isInteger(value.chunkSize) ||
        value.chunkSize < 200 ||
        value.chunkSize > 2000
      )
        throw Error("分块长度须为 200～2000 字符");
      if (
        !Number.isInteger(value.overlap) ||
        value.overlap < 0 ||
        value.overlap > Math.floor(value.chunkSize / 4)
      )
        throw Error("重叠长度不能超过分块长度的 25%");
      return value;
    };
    function controls() {
      const total = entries.reduce((n, e) => n + e.file.size, 0),
        saved = entries.filter((e) => e.state === "saved").length;
      p.querySelector("#kb-queue-count").textContent = String(entries.length);
      p.querySelector("#kb-queue-summary").textContent = entries.length
        ? `${entries.length} 个文件 · ${size(total)} · 已保存 ${saved} 个`
        : "未选择文件";
      p.querySelector("#kb-clear-queue").disabled = active || !entries.length;
      p.querySelector("#kb-start-upload").disabled =
        active || !modelOkay || !pending().length;
      p.querySelector("#kb-start-upload").textContent = active
        ? "正在上传…"
        : entries.some((e) => e.state === "failed")
          ? "重试未完成文件"
          : id
            ? "更新并整理"
            : "上传并智能整理";
      p.querySelector("[data-cancel]").textContent = saved ? "完成" : "取消";
      p.querySelector("[data-cancel]").disabled = active;
      p.querySelector(".kb-close").disabled = active;
      f.elements.file.disabled = active;
      p.querySelector("#kb-browse").disabled = active;
      p.querySelector("#kb-processing-options").disabled =
        active || entries.some((e) => e.options);
    }
    function renderQueue() {
      p.querySelector("#kb-upload-queue").innerHTML =
        entries
          .map(
            (e) =>
              `<article class="kb-upload-item" data-upload="${e.key}"><span class="kb-file-icon">${html(e.file.name.split(".").pop().toUpperCase().slice(0, 5))}</span><div class="kb-upload-file"><strong>${html(e.file.name)}</strong><small>${size(e.file.size)} · ${e.state === "invalid" ? "基础校验未通过" : e.state === "saved" ? "原文已入库" : e.state === "pending" ? "基础校验通过" : ""}</small><p class="kb-upload-error">${html(e.error || "")}</p><small data-job-state>${e.result ? html(e.job ? phaseText(e.job) : "等待解析") : ""}</small></div><div class="kb-upload-progress"><span data-upload-label>${{ pending: "等待上传", uploading: "正在上传", confirming: "字节已发送，确认保存中", saved: "上传完成", failed: "上传未确认", invalid: "不可上传" }[e.state]}</span><span data-upload-percent>${e.progress}%</span><progress max="100" value="${e.progress}" aria-label="${html(e.file.name)}上传进度"></progress></div><div class="kb-upload-item-actions">${e.state === "failed" ? `<button type="button" class="kb-text-button" data-retry-upload="${e.key}" ${active ? "disabled" : ""}>重试上传</button>` : ""}${e.job?.state === "failed" ? `<button type="button" class="kb-text-button" data-retry-job="${e.key}" ${active ? "disabled" : ""}>重试处理</button>` : ""}<button type="button" class="kb-text-button" data-remove-upload="${e.key}" aria-label="移除${html(e.file.name)}" ${active ? "disabled" : ""}>×</button></div></article>`,
          )
          .join("") ||
        '<div class="kb-queue-empty">选择文件后，可逐项检查格式、大小及处理状态。</div>';
      p.querySelectorAll("[data-remove-upload]").forEach(
        (b) =>
          (b.onclick = () => {
            entries = entries.filter((e) => e.key !== b.dataset.removeUpload);
            renderQueue();
          }),
      );
      p.querySelectorAll("[data-retry-upload]").forEach(
        (b) =>
          (b.onclick = () =>
            void run(() =>
              start(entries.filter((e) => e.key === b.dataset.retryUpload)),
            )),
      );
      p.querySelectorAll("[data-retry-job]").forEach(
        (b) =>
          (b.onclick = () =>
            void run(async () => {
              const entry = entries.find((e) => e.key === b.dataset.retryJob);
              b.disabled = true;
              try {
                await api(
                  `/${libraryId}/documents/${entry.result.id}/process`,
                  "POST",
                  {},
                );
                if (!alive()) return;
                entry.job = { state: "queued", stage: entry.job.stage };
                renderQueue();
                schedulePoll();
              } catch (error) {
                b.disabled = false;
                throw error;
              }
            })),
      );
      controls();
    }
    function addFiles(chosen) {
      if (active) return;
      const incoming = [...chosen];
      if (id && (incoming.length !== 1 || entries.length)) {
        toast("更新原文仅支持一个文件，请先移除队列中的文件", "error");
        return;
      }
      const fresh = incoming.filter(
        (file) =>
          !entries.some(
            (e) =>
              e.file.name === file.name &&
              e.file.size === file.size &&
              e.file.lastModified === file.lastModified,
          ),
      );
      if (entries.length + fresh.length > 20) {
        toast("每次队列最多 20 个文件，请分批选择", "error");
        return;
      }
      for (const file of fresh) {
        const error = validateUploadFile(file);
        entries.push({
          key: newUploadId(),
          file,
          state: error ? "invalid" : "pending",
          error,
          progress: 0,
        });
      }
      renderQueue();
    }
    async function refreshModels(probe = false) {
      const button = p.querySelector("#kb-model-check");
      button.disabled = true;
      p.querySelector("#kb-model-health").textContent = probe
        ? "正在检测模型连接…"
        : "正在检查模型配置…";
      try {
        const result = await api(
          `/${libraryId}/model-status`,
          probe ? "POST" : "GET",
        );
        if (!alive()) return;
        modelOkay = [result.chat, result.embedding].every(
          (x) => x && x.state !== "unavailable",
        );
        const available = [result.chat, result.embedding].every(
          (x) => x?.state === "available",
        );
        const badge = p.querySelector("#kb-model-health");
        badge.classList.toggle("available", available);
        badge.classList.toggle("unavailable", !modelOkay);
        badge.textContent = available
          ? "本次检测模型可用"
          : modelOkay
            ? "模型已配置 · 连接待检测"
            : "模型配置或连接不可用";
        p.querySelector("#kb-model-check-note").textContent =
          `整理：${result.chat?.message || "未配置"}；向量：${result.embedding?.message || "未配置"}${result.checkedAt ? " · 检测于 " + time(result.checkedAt) : "。连接检测会产生少量模型调用。"}`;
      } catch (error) {
        if (!alive()) return;
        modelOkay = false;
        p.querySelector("#kb-model-health").textContent = "无法确认模型状态";
        p.querySelector("#kb-model-check-note").textContent = error.message;
      } finally {
        if (alive()) {
          button.disabled = false;
          controls();
        }
      }
    }
    function schedulePoll() {
      clearTimeout(queueTimer);
      if (
        alive() &&
        entries.some(
          (e) =>
            e.result && (!e.job || ["queued", "running"].includes(e.job.state)),
        )
      )
        queueTimer = setTimeout(() => void pollJobs(), 3000);
    }
    async function pollJobs() {
      if (!alive()) return;
      try {
        const data = await api("/" + libraryId);
        if (!alive()) return;
        for (const entry of entries.filter((e) => e.result)) {
          const doc = data.documents.find((d) => d.id === entry.result.id);
          entry.job =
            doc && doc.current_version === entry.result.version
              ? doc
              : { state: "changed", phase: "changed" };
        }
        renderQueue();
        schedulePoll();
      } catch (error) {
        if (alive()) {
          p.querySelector("#kb-upload-status").textContent =
            "处理状态同步中断，可关闭后从文档列表查看或刷新。";
        }
      }
    }
    async function start(chosen = pending()) {
      if (active || !chosen.length) return;
      if (!modelOkay) throw Error("请先确认知识模型配置可用");
      const cfg = options();
      active = true;
      uploading = true;
      uploadController = new AbortController();
      const controller = uploadController;
      try {
        for (const entry of chosen) {
          if (!alive()) break;
          entry.options ||= { ...cfg };
          entry.state = "uploading";
          entry.error = "";
          entry.progress = 0;
          renderQueue();
          const updateProgress = (percent, label) => {
            if (!alive()) return;
            entry.progress = percent;
            const row = p.querySelector(`[data-upload="${entry.key}"]`);
            if (!row) return;
            row.querySelector("progress").value = percent;
            row.querySelector("[data-upload-percent]").textContent =
              percent + "%";
            if (label)
              row.querySelector("[data-upload-label]").textContent = label;
          };
          try {
            const result = await uploadKnowledgeFile(
              `/api/knowledge/${libraryId}/documents${id ? "?documentId=" + id : ""}`,
              {
                file: entry.file,
                requestId: entry.key,
                options: entry.options,
                signal: controller.signal,
                onProgress: (percent) => updateProgress(percent),
                onTransferred: () => {
                  entry.state = "confirming";
                  updateProgress(100, "字节已发送，确认保存中");
                },
              },
            );
            if (!alive()) break;
            entry.result = result;
            entry.state = "saved";
            entry.progress = 100;
            entry.job = null;
            schedulePoll();
          } catch (error) {
            if (error.name === "AbortError" || !alive()) break;
            entry.state = "failed";
            entry.error = error.message;
            if ([401, 403].includes(error.status)) {
              modelOkay = false;
              break;
            }
          }
          renderQueue();
        }
      } finally {
        active = false;
        if (epoch === sessionEpoch) {
          uploading = false;
          if (uploadController === controller) uploadController = null;
        }
        if (alive()) {
          renderQueue();
          p.querySelector("#kb-upload-status").textContent =
            `已保存 ${entries.filter((e) => e.state === "saved").length} 个文件；上传失败可逐项重试，后台处理完成后仍需审核发布。`;
          schedulePoll();
        }
      }
    }
    const pick = () => {
      if (!active) f.elements.file.click();
    };
    p.querySelector("#kb-browse").onclick = (e) => {
      e.stopPropagation();
      pick();
    };
    zone.onclick = (e) => {
      if (e.target !== f.elements.file) pick();
    };
    zone.onkeydown = (e) => {
      if (e.target === zone && ["Enter", " "].includes(e.key)) {
        e.preventDefault();
        pick();
      }
    };
    f.elements.file.onchange = (e) => {
      addFiles(e.target.files);
      e.target.value = "";
    };
    zone.ondragover = (e) => {
      e.preventDefault();
      if (!active) zone.classList.add("dragging");
    };
    zone.ondragleave = () => zone.classList.remove("dragging");
    zone.ondrop = (e) => {
      e.preventDefault();
      zone.classList.remove("dragging");
      addFiles(e.dataTransfer.files);
    };
    p.querySelector("#kb-clear-queue").onclick = () => {
      if (!active) {
        entries = [];
        clearTimeout(queueTimer);
        renderQueue();
      }
    };
    f.elements.chunkSize.oninput = () =>
      (f.elements.overlap.max = String(
        Math.floor(Number(f.elements.chunkSize.value) / 4),
      ));
    p.querySelector("#kb-model-check").onclick = () => void refreshModels(true);
    p.querySelector("[data-cancel]").onclick = () => p.close();
    f.onsubmit = (e) => {
      e.preventDefault();
      void run(() => start());
    };
    p.addEventListener("cancel", (e) => {
      if (active) e.preventDefault();
    });
    p.addEventListener("close", () => {
      disposed = true;
      clearTimeout(queueTimer);
      if (active) uploadController?.abort();
    });
    renderQueue();
    void refreshModels();
  }
  function docForm(d) {
    const editable = detail.library.maintain && d.state === "review",
      hasMetadata = Boolean(
        d.summary || d.processing_options?.generateMetadata,
      ),
      libraryId = selected;
    let tags = [...(d.keywords || [])],
      busy = false;
    const opts = d.processing_options?.strategy
      ? d.processing_options
      : d.model_info?.processingOptions;
    const attempts = d.model_info?.draftDiagnostics?.attempts || [];
    const p = panel(
      `<div class="kb-review-shell"><header class="kb-review-header"><div class="kb-review-document"><span class="kb-review-eyebrow">DOCUMENT / WIKI</span><h2 id="kb-review-title" title="${html(d.title)}">${html(d.title)}</h2><span class="kb-status kb-status-${html(d.state)}">${status[d.state] || html(d.state)}</span><span class="kb-kind-badge">原文 v${d.current_version}</span></div><div class="kb-review-controls"><div class="kb-layout-switch" aria-label="审核布局"><button type="button" data-review-layout="split" aria-pressed="true">文档信息</button><button type="button" data-review-layout="editor" aria-pressed="false">${editable ? "纯净编辑" : "纯净阅读"}</button></div><button type="button" class="secondary" id="kb-review-fullscreen">全屏预览</button></div></header>
      <div class="kb-review-columns"><main class="kb-review-main"><form id="kb-review-form"><div class="kb-review-editor-heading"><div><h3>${editable ? "修订 Wiki 内容" : "查看 Wiki 内容"}</h3><p>${editable ? "请结合完整原文，核对摘要、关键词及正文后发布。" : "当前为只读版本，可下载原文核对整理内容。"}</p></div>${editable ? '<button type="button" class="secondary" id="kb-preview-toggle">预览最终视图</button>' : ""}</div>
      <section class="kb-review-summary"><div class="kb-field-heading"><label for="kb-review-summary-text">文档摘要 <small>summary</small></label><span id="kb-summary-count">${(d.summary || "").length} 字</span></div>${hasMetadata ? `<textarea id="kb-review-summary-text" name="summary" rows="4" maxlength="500" ${editable ? "" : "readonly"}>${html(d.summary || "")}</textarea>` : '<p class="kb-no-metadata">此版本未生成摘要，正文和原文可正常查阅。</p>'}</section>
      <section class="kb-review-tags"><div class="kb-field-heading"><label for="kb-tag-input">关键词与知识标签 <small>keywords</small></label><span id="kb-tag-count"></span></div>${hasMetadata ? '<input type="hidden" name="keywords">' : ""}<div class="kb-tag-editor"><div id="kb-tag-chips"></div>${hasMetadata && editable ? '<input id="kb-tag-input" maxlength="30" placeholder="输入标签后按 Enter 添加" aria-label="新增关键词"><button type="button" class="kb-text-button" id="kb-add-tag">＋ 添加标签</button>' : ""}</div><p id="kb-tag-error" class="kb-error" role="status"></p><small>用于资料筛选与知识检索辅助，请与 Wiki 一同核对。</small></section>
      <section class="kb-review-wiki"><div class="kb-field-heading"><label for="kb-wiki-content">Wiki 结构化正文 <small>MARKDOWN</small></label></div><div id="kb-wiki-preview" class="kb-wiki ${editable ? "hidden" : ""}">${wikiPreview(d.draft)}</div><textarea id="kb-wiki-content" name="content" class="${editable ? "" : "hidden"}" rows="24" ${editable ? "" : "readonly"}>${html(d.draft || "尚未生成 Wiki，处理完成后可在此查看。")}</textarea></section></form></main>
      <aside class="kb-review-aside"><section class="kb-review-info-card"><h3>${icon("layers")} 生成记录与排错</h3><dl><dt>切分策略</dt><dd>${opts ? `${opts.strategy === "structured" ? "标题与段落" : "固定长度"} · ${opts.chunkSize} 字符 · 重叠 ${opts.overlap}` : "历史版本默认切分"}</dd><dt>生成模型</dt><dd>${html(d.model_info?.chatModel || "未记录")}</dd><dt>最近更新</dt><dd>${html(time(d.updated_at))}</dd></dl>${detail.library.maintain && attempts.length ? `<details class="kb-generation-diagnostics"><summary>${attempts.length} 次生成记录</summary>${attempts.map((a, i) => `<p>第 ${i + 1} 次 · 预算 ${html(a.maxOutputTokens)} token<br>结束原因：${html(a.finishReason)}${a.problem ? " / " + html(a.problem) : ""}<br>生成用量：${html(a.completionTokens ?? "未返回")} · 推理用量：${html(a.reasoningTokens ?? "未返回")}</p>`).join("")}<small>length 为输出截断，可由管理员调整模型设置后重试。</small></details>` : ""}</section>
      <section class="kb-review-info-card kb-source-download"><div><h3>原文下载</h3><p>核对整理结果，再发布供空间使用。</p></div><a class="secondary" href="/api/knowledge/${libraryId}/documents/${d.id}/source?version=${d.current_version}">↓ 下载原文 v${d.current_version}</a>${d.published_version && d.published_version !== d.current_version ? `<a href="/api/knowledge/${libraryId}/documents/${d.id}/source?version=${d.published_version}">下载检索版本 v${d.published_version}</a>` : ""}</section>
      </aside></div>
      <footer class="kb-review-footer"><div><span class="kb-review-dot"></span><span id="kb-save-state" role="status">${editable ? "尚未修改" : "当前版本只读"}</span></div><div class="dialog-actions">${editable ? '<button type="submit" form="kb-review-form" name="save" class="secondary">保存为草稿</button><button type="submit" form="kb-review-form" name="publish" class="primary">✓ 审核通过并发布 Wiki</button>' : '<button type="button" id="kb-review-done" class="secondary">完成</button>'}</div></footer></div>`,
      true,
    );
    p.setAttribute("aria-labelledby", "kb-review-title");
    p.classList.add("kb-review-dialog");
    p.querySelector(".kb-review-controls").append(p.querySelector(".kb-close"));
    const form = p.querySelector("form"),
      markDirty = () => {
        p.dataset.dirty = "true";
        p.querySelector("#kb-save-state").textContent = "存在未保存的修订";
      };
    const renderTags = () => {
      p.querySelector("#kb-tag-count").textContent = `${tags.length} / 10 个`;
      p.querySelector("#kb-tag-chips").innerHTML =
        tags
          .map(
            (tag, i) =>
              `<span class="kb-keyword-chip">${html(tag)}${hasMetadata && editable ? `<button type="button" data-remove-tag="${i}" aria-label="移除关键词${html(tag)}">×</button>` : ""}</span>`,
          )
          .join("") || '<span class="kb-muted">暂无关键词</span>';
      if (form.elements.keywords)
        form.elements.keywords.value = tags.join("，");
      p.querySelectorAll("[data-remove-tag]").forEach(
        (button) =>
          (button.onclick = () => {
            tags.splice(Number(button.dataset.removeTag), 1);
            renderTags();
            markDirty();
          }),
      );
    };
    const addTag = () => {
      const field = p.querySelector("#kb-tag-input");
      if (!field || !field.value.trim()) return true;
      const newTags = [
        ...new Set([
          ...tags,
          ...field.value
            .split(/[,，]/)
            .map((x) => x.trim())
            .filter(Boolean),
        ]),
      ];
      if (newTags.length > 10 || newTags.some((t) => t.length > 30)) {
        p.querySelector("#kb-tag-error").textContent =
          "最多 10 个关键词，每个最多 30 字";
        return false;
      }
      tags = newTags;
      field.value = "";
      p.querySelector("#kb-tag-error").textContent = "";
      renderTags();
      markDirty();
      return true;
    };
    renderTags();
    const tagInput = p.querySelector("#kb-tag-input");
    if (tagInput) {
      tagInput.onkeydown = (e) => {
        if (e.key === "Enter" || e.key === "," || e.key === "，") {
          e.preventDefault();
          addTag();
        }
      };
      p.querySelector("#kb-add-tag").onclick = addTag;
    }
    p.querySelectorAll("[data-review-layout]").forEach(
      (button) =>
        (button.onclick = () => {
          const editor = button.dataset.reviewLayout === "editor";
          p.classList.toggle("kb-editor-only", editor);
          p.querySelectorAll("[data-review-layout]").forEach((b) =>
            b.setAttribute("aria-pressed", String(b === button)),
          );
        }),
    );
    p.querySelector("#kb-review-fullscreen").onclick = (e) => {
      const expanded = p.classList.toggle("kb-reader-fullscreen");
      e.target.textContent = expanded ? "退出全屏" : "全屏预览";
      e.target.setAttribute("aria-pressed", String(expanded));
    };
    p.addEventListener("cancel", (e) => {
      if (busy) e.preventDefault();
    });
    if (!editable) {
      p.querySelector("#kb-review-done").onclick = () => p.close();
      return;
    }
    p.querySelector("#kb-preview-toggle").onclick = (e) => {
      const preview = p.querySelector("#kb-wiki-preview"),
        showing = preview.classList.contains("hidden");
      preview.innerHTML = wikiPreview(form.elements.content.value);
      preview.classList.toggle("hidden", !showing);
      form.elements.content.classList.toggle("hidden", showing);
      e.target.textContent = showing ? "继续编辑" : "预览最终视图";
    };
    form.elements.content.oninput = markDirty;
    if (form.elements.summary)
      form.elements.summary.oninput = () => {
        p.querySelector("#kb-summary-count").textContent =
          form.elements.summary.value.length + " 字";
        markDirty();
      };
    form.onsubmit = (e) => {
      e.preventDefault();
      if (busy) return;
      const publish = e.submitter?.name === "publish";
      void run(async () => {
        if (!addTag()) return;
        if (hasMetadata && !tags.length) throw Error("请至少保留一个关键词");
        busy = true;
        const controls = [...p.querySelectorAll("button,input,textarea")].map(
          (control) => [control, control.disabled],
        );
        controls.forEach(([c]) => (c.disabled = true));
        try {
          const result = await api(
            `/${libraryId}/documents/${d.id}/draft`,
            "PUT",
            {
              version: d.current_version,
              editRevision: d.edit_revision,
              content: form.elements.content.value,
              ...(hasMetadata
                ? { summary: form.elements.summary.value, keywords: tags }
                : {}),
            },
          );
          d.edit_revision = result.edit_revision;
          p.dataset.dirty = "false";
          p.querySelector("#kb-save-state").textContent = "草稿已保存";
          if (publish) {
            await api(`/${libraryId}/documents/${d.id}/process`, "POST", {
              publish: true,
              editRevision: d.edit_revision,
            });
            toast("已提交发布，正在生成索引");
            p.close();
          } else toast("草稿已保存");
        } finally {
          busy = false;
          controls.forEach(
            ([control, disabled]) => (control.disabled = disabled),
          );
        }
      });
    };
  }
  async function grantForm() {
    const { users } = await api("/" + selected + "/users");
    const names = new Map(
      users.map((u) => [u.id, u.display_name + "（" + u.username + "）"]),
    );
    const p = panel(
      `<h2>公共库授权</h2><p>授权同租户有效用户。维护者可编辑、审核和管理本库授权。</p><form><label>用户<select name="userId" required>${users.map((u) => `<option value="${u.id}">${html(names.get(u.id))}</option>`).join("")}</select></label><label><input name="maintain" type="checkbox">允许维护及审核</label><button name="grant" class="primary">授权</button><button name="revoke" class="danger">撤销</button></form><p>已有授权：${detail.grants.map((g) => html(names.get(g.user_id) || "已停用用户") + (g.maintain ? "（维护）" : "（阅读）")).join("、") || "无"}</p>`,
    );
    p.querySelector("form").onsubmit = (e) => {
      e.preventDefault();
      void run(async () => {
        await api("/" + selected + "/grants", "PUT", {
          userId: e.target.elements.userId.value,
          maintain: e.target.elements.maintain.checked,
          remove: e.submitter?.name === "revoke",
        });
        toast("授权已更新，下一次访问按最新权限检查");
        p.close();
      });
    };
  }
  const bindingLabel = (s) =>
    !s?.bound
      ? "未接入"
      : s.needsConfirmation
        ? "待重新确认"
        : s.bindingReason
          ? "接入失效"
          : "已接入";
  const spaceRole = (role) =>
    ({ owner: "负责人", operator: "运维者", member: "普通成员" })[role] ||
    "未分配空间角色";
  function bindingRows(spaces) {
    return spaces.length
      ? spaces
          .map(
            (s) =>
              `<article class="kb-bound-row"><span class="kb-bound-icon">${icon("layers")}</span><div><strong>${html(s.name)}</strong><p><span class="kb-binding-pill ${s.bindingReason ? "warning" : "ready"}">${bindingLabel(s)}</span> · ${Number(s.memberCount || 0)} 位成员 · 接入于 ${html(time(s.boundAt))}</p>${s.bindingReason ? `<small class="kb-error">${html(s.bindingReason)}</small>` : ""}</div><div class="kb-bound-actions"><button type="button" class="secondary" data-binding-manage="${html(s.id)}" ${s.canConfigure ? "" : "disabled"}>${s.canConfigure ? "查看成员" : "无空间配置权限"}</button><button type="button" class="secondary danger" data-binding-remove="${html(s.id)}" ${s.canUnbind ? "" : "disabled"}>取消接入</button></div></article>`,
          )
          .join("")
      : '<div class="kb-empty"><h3>尚未接入空间</h3><p>接入后，空间可检索本库已发布的知识。</p></div>';
  }
  function wireBindings(container, spaces) {
    container
      .querySelectorAll("[data-binding-manage]")
      .forEach(
        (b) =>
          (b.onclick = () => void run(() => bindForm(b.dataset.bindingManage))),
      );
    container.querySelectorAll("[data-binding-remove]").forEach(
      (b) =>
        (b.onclick = () =>
          void run(async () => {
            const libraryId = selected,
              s = spaces.find((x) => x.id === b.dataset.bindingRemove);
            if (
              !s?.canUnbind ||
              !confirm(
                `确认取消「${s.name}」对本知识库的接入？后续知识检索将停止使用本库，历史回答仍会保留。`,
              )
            )
              return;
            b.disabled = true;
            try {
              await api("/" + libraryId + "/bindings", "PUT", {
                spaceId: s.id,
                remove: true,
              });
              toast("已取消空间接入");
              await load();
            } finally {
              if (b.isConnected) b.disabled = false;
            }
          })),
    );
  }
  async function bindForm(initialSpace = "") {
    const libraryId = selected,
      epoch = sessionEpoch,
      kind = detail.library.kind;
    const { spaces: instances } = await api("/" + libraryId + "/spaces");
    if (selected !== libraryId || epoch !== sessionEpoch) return;
    const p = panel(
      `<div class="kb-binding-layout"><section class="kb-binding-main"><header class="kb-binding-header"><span class="kb-binding-header-icon">${icon("layers")}</span><div><h2>空间接入配置 <span id="kb-binding-status" class="kb-binding-pill">未选择空间</span></h2><p>将本知识库接入工作空间，供空间成员在对话中检索已发布知识。</p></div></header><form id="kb-binding-form"><div class="kb-binding-body"><label>目标空间 <span class="kb-required">*</span><select name="spaceId" required><option value="">请选择目标空间</option>${instances.map((s) => `<option value="${html(s.id)}" ${!s.canConfigure || (s.bound && !s.bindingReason) ? "disabled" : ""}>${html(s.name)}${!s.canConfigure ? "（无空间配置权限）" : s.bound ? "（" + bindingLabel(s) + "）" : ""}</option>`).join("")}</select></label><p class="kb-binding-permission">接入需要本库维护权限和空间负责人／运维者权限。平台管理员可配置本租户空间；知识管理员不自动获得空间配置权限。</p>${instances.some((s) => s.bound) ? `<button type="button" class="kb-text-button" id="kb-go-bindings">已接入 ${instances.filter((s) => s.bound).length} 个空间，查看与管理 →</button>` : ""}<section class="kb-member-preview"><div class="kb-member-preview-heading"><h3>空间成员范围预览</h3><button type="button" id="kb-scope-refresh" class="secondary" disabled>↻ 刷新范围</button></div><p id="kb-scope-status" role="status" aria-live="polite">${instances.some((s) => s.canConfigure) ? "请选择空间，加载成员范围后确认接入。" : "当前没有可配置的空间。请联系平台管理员调整空间角色；个人库仍须由所有者确认共享。"}</p><div id="kb-members"></div></section><section class="kb-binding-notice"><h3>知识共享说明</h3><ul><li>接入后，空间成员可通过问答使用本库已发布知识；平台管理员支持代入访问。</li><li>取消接入会停止后续检索，已生成的历史回答和工作副本不能自动收回。</li><li>当前不支持外部访客或临时分享链接授权，停用账号仍纳入成员范围核对。</li></ul></section><p id="kb-binding-error" class="kb-error" role="alert"></p></div><footer class="kb-binding-footer"><small>已接入空间可在知识库“空间接入”页签管理。</small><div class="dialog-actions"><button type="submit" name="remove" class="secondary danger" disabled>取消接入</button><button type="submit" name="bind" class="primary" disabled>确认共享并接入</button></div></footer></form></section><aside id="kb-member-details" class="kb-member-details hidden" aria-labelledby="kb-member-title"><header><div><h3 id="kb-member-title">空间成员范围 <span id="kb-member-total"></span></h3><p>查看实际空间角色及接入后的知识访问范围。</p></div><button type="button" id="kb-members-close" class="icon-close" aria-label="返回接入配置">×</button></header><div class="kb-members-tools"><input id="kb-member-search" placeholder="搜索姓名或账号" aria-label="搜索空间成员"><div id="kb-member-filters"></div></div><div id="kb-member-list"></div><footer><span id="kb-member-result-count"></span><div><button type="button" id="kb-member-prev" class="secondary" aria-label="上一页成员">‹</button><span id="kb-member-page"></span><button type="button" id="kb-member-next" class="secondary" aria-label="下一页成员">›</button></div><button type="button" id="kb-members-done" class="primary">完成查看并返回</button></footer></aside></div>`,
    );
    p.classList.add("kb-binding-modal");
    p.setAttribute("aria-label", "空间接入配置");
    p.querySelector(".kb-binding-header").append(p.querySelector(".kb-close"));
    const f = p.querySelector("form"),
      select = f.elements.spaceId,
      status = p.querySelector("#kb-scope-status"),
      refresh = p.querySelector("#kb-scope-refresh"),
      bind = f.querySelector("[name=bind]"),
      remove = f.querySelector("[name=remove]"),
      errorBox = p.querySelector("#kb-binding-error");
    let scope = null,
      scopeRequest = 0,
      loading = false,
      saving = false,
      memberQuery = "",
      memberFilter = "all",
      memberPage = 1;
    const alive = () =>
      p.open && epoch === sessionEpoch && selected === libraryId;
    const target = () => instances.find((s) => s.id === select.value);
    const currentBinding = () =>
      scope?.bindings.find((x) => x.id === libraryId);
    const missingAccess = () =>
      kind === "public" && scope?.members.some((m) => m.canRead === false);
    const controls = () => {
      const s = target(),
        ready = scope?.space === select.value && !loading && !saving,
        b = currentBinding();
      const active = ready && b && !b.reason;
      bind.disabled = !ready || Boolean(active) || missingAccess();
      bind.textContent = saving
        ? "正在保存…"
        : loading
          ? "正在加载成员…"
          : active
            ? "已接入，无需重复接入"
            : b?.reason
              ? "重新确认并接入"
              : "确认共享并接入";
      remove.disabled = saving || !s?.canUnbind;
      select.disabled = saving;
      refresh.disabled = saving || loading || !s?.canConfigure;
      p.querySelector(".kb-close").disabled = saving;
      p.querySelector("#kb-binding-status").textContent = s
        ? bindingLabel(s)
        : "未选择空间";
      p.querySelector("#kb-binding-status").classList.toggle(
        "ready",
        Boolean(s?.bound && !s.bindingReason),
      );
      p.querySelector("#kb-binding-status").classList.toggle(
        "warning",
        Boolean(s?.bindingReason),
      );
    };
    const showDetails = (show) => {
      p.classList.toggle("kb-binding-expanded", show);
      p.querySelector("#kb-member-details").classList.toggle("hidden", !show);
      if (show) p.querySelector("#kb-member-search").focus();
      else p.querySelector("#kb-member-open")?.focus();
    };
    const renderMembers = () => {
      const members = scope?.members || [],
        counts = {
          all: members.length,
          owner: members.filter((m) => m.access_role === "owner").length,
          operator: members.filter((m) => m.access_role === "operator").length,
          member: members.filter((m) => m.access_role === "member").length,
          disabled: members.filter((m) => m.enabled === false).length,
        };
      p.querySelector("#kb-member-total").textContent = members.length + " 人";
      p.querySelector("#kb-member-filters").innerHTML = Object.entries({
        all: "全部",
        owner: "负责人",
        operator: "运维者",
        member: "普通成员",
        disabled: "已停用",
      })
        .map(
          ([key, label]) =>
            `<button type="button" data-member-filter="${key}" aria-pressed="${memberFilter === key}">${label} ${counts[key]}</button>`,
        )
        .join("");
      p.querySelectorAll("[data-member-filter]").forEach(
        (b) =>
          (b.onclick = () => {
            memberFilter = b.dataset.memberFilter;
            memberPage = 1;
            renderMembers();
          }),
      );
      const rows = members.filter(
        (m) =>
          (memberFilter === "all" ||
            (memberFilter === "disabled"
              ? m.enabled === false
              : m.access_role === memberFilter)) &&
          `${m.display_name} ${m.username}`
            .toLowerCase()
            .includes(memberQuery.toLowerCase()),
      );
      memberPage = Math.max(
        1,
        Math.min(memberPage, Math.ceil(rows.length / 20)),
      );
      p.querySelector("#kb-member-list").innerHTML =
        rows
          .slice((memberPage - 1) * 20, memberPage * 20)
          .map(
            (m) =>
              `<article class="kb-member-card"><span class="kb-member-avatar">${html(Array.from(m.display_name || m.username || "?")[0])}</span><div><strong>${html(m.display_name || m.username)}</strong><code>${html(m.username)}</code><p><span>${spaceRole(m.access_role)}</span>${m.platform_role === "platform_admin" ? " · 平台管理员" : m.knowledge_admin ? " · 知识管理员" : ""}${m.enabled === false ? " · 账号已停用" : ""}</p></div><span class="kb-binding-pill ${m.canRead === false ? "warning" : m.enabled === false ? "" : "ready"}">${m.canRead === false ? "尚未授权" : m.enabled === false ? "账号已停用" : currentBinding() && !currentBinding().reason ? "可使用" : "接入后可使用"}</span></article>`,
          )
          .join("") || '<div class="kb-empty">没有匹配的成员</div>';
      p.querySelector("#kb-member-result-count").textContent =
        `共 ${members.length} 人，筛选匹配 ${rows.length} 人`;
      p.querySelector("#kb-member-page").textContent =
        `${memberPage} / ${Math.max(1, Math.ceil(rows.length / 20))}`;
      p.querySelector("#kb-member-prev").disabled = memberPage <= 1;
      p.querySelector("#kb-member-next").disabled =
        memberPage * 20 >= rows.length;
    };
    const renderPreview = () => {
      const members = scope.members,
        missing = members.filter((m) => m.canRead === false).length;
      p.querySelector("#kb-members").innerHTML =
        `<div class="kb-member-preview-card"><div class="kb-avatar-stack">${members
          .slice(0, 6)
          .map(
            (m) =>
              `<span title="${html(m.display_name || m.username)}">${html(Array.from(m.display_name || m.username || "?")[0])}</span>`,
          )
          .join(
            "",
          )}<strong>${members.length} 位成员</strong></div><p>包含 ${members.filter((m) => ["owner", "operator"].includes(m.access_role)).length} 位负责人／运维者，${members.filter((m) => m.access_role === "member").length} 位普通成员${members.some((m) => m.enabled === false) ? `，${members.filter((m) => m.enabled === false).length} 位已停用账号` : ""}。</p><button type="button" id="kb-member-open">查看完整成员名单与权限范围 (${members.length}) →</button>${kind === "public" && missing ? `<p class="kb-error">${missing} 位成员尚未获本库访问授权，请先在“用户授权”中补齐后刷新范围。</p>` : ""}</div>`;
      p.querySelector("#kb-member-open").onclick = () => {
        renderMembers();
        showDetails(true);
      };
    };
    const loadScope = async () => {
      const seq = ++scopeRequest,
        spaceId = select.value;
      scope = null;
      loading = Boolean(spaceId);
      showDetails(false);
      memberPage = 1;
      memberFilter = "all";
      memberQuery = "";
      p.querySelector("#kb-member-search").value = "";
      p.querySelector("#kb-members").replaceChildren();
      errorBox.textContent = "";
      status.classList.remove("kb-error");
      status.textContent = spaceId
        ? "正在加载空间成员范围，请稍候…"
        : "请选择目标空间。";
      controls();
      if (!spaceId) return;
      if (!target()?.canConfigure) {
        loading = false;
        status.textContent =
          "当前账号无该空间配置权限；已有接入仍可由本库维护者取消。";
        controls();
        return;
      }
      try {
        const r = await api(
          "/scope?spaceId=" +
            encodeURIComponent(spaceId) +
            "&libraryId=" +
            encodeURIComponent(libraryId),
        );
        if (!alive() || seq !== scopeRequest || select.value !== spaceId)
          return;
        if (
          r.space !== spaceId ||
          !Array.isArray(r.members) ||
          !Array.isArray(r.bindings) ||
          r.epoch == null
        )
          throw Error("成员范围返回不完整，请重试");
        scope = r;
        const b = currentBinding(),
          s = target();
        s.bound = Boolean(b);
        s.bindingReason = b?.reason || "";
        s.needsConfirmation = Boolean(b?.reason && kind === "personal");
        s.canUnbind = Boolean(b);
        status.textContent =
          b && !b.reason
            ? "本库已接入此空间，无需重复操作。"
            : b?.reason ||
              `已加载 ${r.members.length} 位成员，请核对后确认共享。`;
        renderPreview();
        renderMembers();
      } catch (error) {
        if (!alive() || seq !== scopeRequest || error.name === "AbortError")
          return;
        scope = null;
        status.classList.add("kb-error");
        status.textContent = `成员范围加载失败：${error.message}。可点击“刷新范围”重试。`;
      } finally {
        if (alive() && seq === scopeRequest) {
          loading = false;
          controls();
        }
      }
    };
    const manageLink = p.querySelector("#kb-go-bindings");
    if (manageLink)
      manageLink.onclick = () => {
        tab = "bindings";
        p.close();
      };
    select.onchange = () => void loadScope();
    refresh.onclick = () => void loadScope();
    p.querySelector("#kb-member-search").oninput = (e) => {
      memberQuery = e.target.value;
      memberPage = 1;
      renderMembers();
    };
    p.querySelector("#kb-member-prev").onclick = () => {
      memberPage--;
      renderMembers();
    };
    p.querySelector("#kb-member-next").onclick = () => {
      memberPage++;
      renderMembers();
    };
    for (const id of ["#kb-members-close", "#kb-members-done"])
      p.querySelector(id).onclick = () => showDetails(false);
    p.addEventListener("close", () => {
      scopeRequest++;
      scope = null;
    });
    p.addEventListener("cancel", (e) => {
      if (saving) e.preventDefault();
      else if (p.classList.contains("kb-binding-expanded")) {
        e.preventDefault();
        showDetails(false);
      }
    });
    f.onsubmit = (e) => {
      e.preventDefault();
      if (!alive() || saving) return;
      const unbind = e.submitter?.name === "remove",
        s = target();
      if (unbind) {
        if (!s?.canUnbind) return;
        if (
          !confirm(`确认取消「${s.name}」对本知识库的接入？历史回答仍会保留。`)
        )
          return;
      } else {
        if (!scope || scope.space !== select.value || loading) {
          status.textContent = loading
            ? "正在加载空间成员范围，请稍候…"
            : "请先选择空间并刷新成员范围。";
          return;
        }
        if (missingAccess() || (currentBinding() && !currentBinding().reason))
          return;
        if (
          !confirm(
            "确认将本知识库共享给列出的空间成员，并了解管理员代入访问及历史内容保留情况？",
          )
        )
          return;
      }
      const confirmedScope = scope;
      saving = true;
      controls();
      errorBox.textContent = "";
      void (async () => {
        try {
          const r = await api(
            "/" + libraryId + "/bindings",
            "PUT",
            unbind
              ? { spaceId: s.id, remove: true }
              : {
                  spaceId: confirmedScope.space,
                  epoch: confirmedScope.epoch,
                  confirm: true,
                },
          );
          if (!alive()) return;
          toast(
            unbind
              ? "已取消空间接入"
              : r.alreadyBound
                ? "此空间已接入，无需重复操作"
                : r.syncStatus === "ready"
                  ? "空间配置已同步"
                  : "接入已保存，空间唤醒或后续同步时生效",
          );
          p.close();
        } catch (error) {
          if (!alive() || error.name === "AbortError") return;
          if (error.message.includes("成员范围已变化")) {
            await loadScope();
            if (alive() && scope)
              status.textContent =
                "空间成员已变化，已重新加载，请重新核对并确认共享。";
          } else errorBox.textContent = `接入操作失败：${error.message}`;
        } finally {
          saving = false;
          if (alive()) controls();
        }
      })();
    };
    if (initialSpace && instances.some((s) => s.id === initialSpace)) {
      select.value = initialSpace;
      void loadScope();
    }
  }
  load.reset = reset;
  return load;
}
