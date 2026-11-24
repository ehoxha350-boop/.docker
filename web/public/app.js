const state = { password: "", sites: [], siteId: null, view: "sites", posts: [] };
const notice = document.querySelector("#notice");
const loginPane = document.querySelector("#login-pane");
const appShell = document.querySelector("#app-shell");
const siteDialog = document.querySelector("#site-dialog");
const postDialog = document.querySelector("#post-dialog");
let noticeTimer;

function showError(message) {
  notice.textContent = message;
  notice.classList.remove("notice-success");
  notice.hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { notice.hidden = true; }, 5000);
}

async function request(path, options = {}) {
  const headers = { ...options.headers };
  if (state.password) headers.Authorization = `Bearer ${state.password}`;
  if (options.body && !headers["Content-Type"]) headers["Content-Type"] = "application/json";
  const response = await fetch(path, { ...options, headers });
  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try {
      const body = await response.json();
      if (body.detail) message = body.detail;
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
    if (response.status === 401 && state.password) signOut();
    throw new Error(message);
  }
  return response.status === 204 ? null : response.json();
}

function signOut() {
  sessionStorage.removeItem("sitecraft-admin-password");
  state.password = "";
  loginPane.hidden = false;
  appShell.hidden = true;
  document.querySelector("#admin-password").value = "";
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function actionButton(label, className, action) {
  const button = element("button", `button ${className}`, label);
  button.type = "button";
  button.addEventListener("click", action);
  return button;
}

function selectedSite() {
  return state.sites.find((site) => site.id === Number(state.siteId));
}

function setView(view) {
  state.view = view;
  document.querySelectorAll(".view").forEach((section) => {
    section.hidden = section.id !== `${view}-view`;
  });
  document.querySelectorAll(".nav-link").forEach((button) => {
    button.classList.toggle("active", button.dataset.view === view);
  });
  document.querySelector("#page-label").textContent =
    { sites: "Sites", posts: "Posts", dns: "DNS records", tracking: "Tags & pixels" }[view];
  if (view === "posts") loadPosts();
  if (view === "dns") loadDns();
  if (view === "tracking") loadTracking();
}

async function loadSites() {
  state.sites = await request("/api/sites");
  const select = document.querySelector("#site-select");
  select.replaceChildren(new Option("Select a site", ""));
  for (const site of state.sites) select.add(new Option(`${site.name} · ${site.domain}`, site.id));
  if (!state.sites.some((site) => site.id === Number(state.siteId))) {
    state.siteId = state.sites[0]?.id || null;
  }
  select.value = state.siteId ? String(state.siteId) : "";
  renderSites();
  updateSiteViews();
}

function updateSiteViews() {
  const hasSite = Boolean(selectedSite());
  document.querySelector("#site-select").disabled = !hasSite;
  document.querySelector("#add-post").disabled = !hasSite;
  document.querySelectorAll(".requires-site").forEach((node) => { node.disabled = !hasSite; });
  if (state.view === "posts") loadPosts();
  if (state.view === "dns") loadDns();
  if (state.view === "tracking") loadTracking();
}

function renderSites() {
  const grid = document.querySelector("#site-grid");
  const empty = document.querySelector("#sites-empty");
  grid.replaceChildren();
  empty.hidden = state.sites.length > 0;
  for (const site of state.sites) {
    const card = element("article", "site-card");
    const header = element("div", "site-card-header");
    const icon = element("span", "site-icon", site.name.slice(0, 1));
    const text = element("div");
    text.append(element("h2", "", site.name), element("p", "muted", site.domain));
    header.append(icon, text);
    const zone = element("p", "zone-label", site.hosted_zone_id
      ? `Route 53 zone: ${site.hosted_zone_id}` : "Route 53 zone not configured");
    const actions = element("div", "card-actions");
    actions.append(
      actionButton("Manage posts", "secondary small", () => { state.siteId = site.id; syncSiteSelect(); setView("posts"); }),
      actionButton("Edit site", "secondary small", () => openSiteDialog(site)),
      actionButton("Delete", "danger small", () => deleteSite(site)),
    );
    card.append(header, zone, actions);
    grid.append(card);
  }
}

function syncSiteSelect() {
  document.querySelector("#site-select").value = state.siteId ? String(state.siteId) : "";
}

function openSiteDialog(site) {
  document.querySelector("#site-form").reset();
  document.querySelector("#site-id").value = site ? site.id : "";
  document.querySelector("#site-dialog-title").textContent = site ? "Edit site" : "Add site";
  document.querySelector("#site-name").value = site?.name || "";
  document.querySelector("#site-domain").value = site?.domain || "";
  document.querySelector("#site-domain").disabled = Boolean(site);
  document.querySelector("#site-zone").value = site?.hosted_zone_id || "";
  siteDialog.showModal();
  document.querySelector("#site-name").focus();
}

async function deleteSite(site) {
  if (!window.confirm(`Delete ${site.name} and its posts and tracking settings? DNS records in Route 53 will not be deleted.`)) return;
  try {
    await request(`/api/sites/${site.id}`, { method: "DELETE" });
    if (state.siteId === site.id) state.siteId = null;
    await loadSites();
  } catch (error) { showError(error.message); }
}

async function loadPosts() {
  const site = selectedSite();
  const body = document.querySelector("#posts-body");
  const empty = document.querySelector("#posts-empty");
  body.replaceChildren();
  if (!site) {
    empty.hidden = false;
    document.querySelector("#posts-site-label").textContent = "Add or select a site to manage posts.";
    return;
  }
  document.querySelector("#posts-site-label").textContent = `Posts for ${site.name}`;
  try {
    state.posts = await request(`/api/sites/${site.id}/posts`);
    empty.hidden = state.posts.length > 0;
    for (const post of state.posts) {
      const row = element("tr");
      const titleCell = element("td");
      titleCell.append(element("strong", "table-title", post.title), element("span", "table-subtitle", `/${post.slug}`));
      const status = element("span", `badge ${post.status === "published" ? "badge-published" : "badge-draft"}`, post.status);
      const date = element("td", "", new Date(`${post.updated_at}Z`).toLocaleDateString());
      const actions = element("td", "table-actions");
      if (post.status === "published") {
        actions.append(actionButton("Preview", "secondary small", () => {
          window.open(`/p/${site.id}/${encodeURIComponent(post.slug)}`, "_blank", "noopener,noreferrer");
        }));
      }
      actions.append(
        actionButton("Edit", "secondary small", () => openPostDialog(post)),
        actionButton("Delete", "danger small", () => deletePost(post)),
      );
      row.append(titleCell, element("td", "", status), date, actions);
      body.append(row);
    }
  } catch (error) { showError(error.message); }
}

function openPostDialog(post) {
  if (!selectedSite()) return showError("Add or select a site before creating posts.");
  document.querySelector("#post-form").reset();
  document.querySelector("#post-id").value = post ? post.id : "";
  document.querySelector("#post-dialog-title").textContent = post ? "Edit post" : "New post";
  document.querySelector("#post-title").value = post?.title || "";
  document.querySelector("#post-slug").value = post?.slug || "";
  document.querySelector("#post-body").value = post?.body || "";
  document.querySelector("#post-status").value = post?.status || "draft";
  postDialog.showModal();
  document.querySelector("#post-title").focus();
}

async function deletePost(post) {
  if (!window.confirm(`Delete "${post.title}"?`)) return;
  try {
    await request(`/api/posts/${post.id}`, { method: "DELETE" });
    await loadPosts();
  } catch (error) { showError(error.message); }
}

async function loadDns() {
  const site = selectedSite();
  const body = document.querySelector("#dns-body");
  const empty = document.querySelector("#dns-empty");
  body.replaceChildren();
  if (!site) {
    empty.hidden = false;
    empty.querySelector("p").textContent = "Add or select a site to manage DNS.";
    return;
  }
  try {
    const records = await request(`/api/sites/${site.id}/dns`);
    empty.hidden = records.length > 0;
    for (const record of records) {
      const row = element("tr");
      const values = element("td", "dns-values", record.values.join("\n"));
      const action = element("td");
      action.append(actionButton("Delete", "danger small", async () => {
        if (!window.confirm(`Delete ${record.type} record for ${record.name}?`)) return;
        try {
          const query = new URLSearchParams({ name: record.name, record_type: record.type });
          await request(`/api/sites/${site.id}/dns?${query}`, { method: "DELETE" });
          await loadDns();
        } catch (error) { showError(error.message); }
      }));
      row.append(
        element("td", "", record.name),
        element("td", "", record.type),
        element("td", "", String(record.ttl)),
        values,
        action,
      );
      body.append(row);
    }
  } catch (error) {
    empty.hidden = false;
    empty.querySelector("p").textContent = error.message;
  }
}

async function loadTracking() {
  const site = selectedSite();
  if (!site) return;
  try {
    const settings = await request(`/api/sites/${site.id}/tracking`);
    document.querySelector("#gtm-id").value = settings.gtm_id;
    document.querySelector("#ga4-id").value = settings.ga4_id;
    document.querySelector("#meta-pixel-id").value = settings.meta_pixel_id;
    document.querySelector("#tiktok-pixel-id").value = settings.tiktok_pixel_id;
    document.querySelector("#tracking-updated").textContent = settings.updated_at
      ? `Last saved ${new Date(`${settings.updated_at}Z`).toLocaleString()}` : "Not configured";
  } catch (error) { showError(error.message); }
}

document.querySelector("#login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const password = document.querySelector("#admin-password").value;
  const errorLabel = document.querySelector("#login-error");
  try {
    const response = await fetch("/auth/check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    if (!response.ok) throw new Error("Incorrect admin password");
    state.password = password;
    sessionStorage.setItem("sitecraft-admin-password", password);
    errorLabel.hidden = true;
    loginPane.hidden = true;
    appShell.hidden = false;
    await loadSites();
  } catch (error) {
    errorLabel.textContent = error.message;
    errorLabel.hidden = false;
  }
});

document.querySelector("#sign-out").addEventListener("click", signOut);
document.querySelectorAll(".nav-link").forEach((button) => {
  button.addEventListener("click", () => setView(button.dataset.view));
});
document.querySelector("#site-select").addEventListener("change", (event) => {
  state.siteId = Number(event.target.value) || null;
  updateSiteViews();
});
document.querySelector("#add-site").addEventListener("click", () => openSiteDialog());
document.querySelector("#empty-add-site").addEventListener("click", () => openSiteDialog());
document.querySelector("#close-site-dialog").addEventListener("click", () => siteDialog.close());
document.querySelector("#cancel-site-dialog").addEventListener("click", () => siteDialog.close());
document.querySelector("#add-post").addEventListener("click", () => openPostDialog());
document.querySelector("#empty-add-post").addEventListener("click", () => openPostDialog());
document.querySelector("#close-post-dialog").addEventListener("click", () => postDialog.close());
document.querySelector("#cancel-post-dialog").addEventListener("click", () => postDialog.close());
document.querySelector("#refresh-dns").addEventListener("click", loadDns);

document.querySelector("#site-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const id = document.querySelector("#site-id").value;
  const site = {
    name: document.querySelector("#site-name").value.trim(),
    domain: document.querySelector("#site-domain").value.trim(),
    hosted_zone_id: document.querySelector("#site-zone").value.trim(),
  };
  if (id) delete site.domain;
  try {
    await request(id ? `/api/sites/${id}` : "/api/sites", {
      method: id ? "PUT" : "POST", body: JSON.stringify(site),
    });
    siteDialog.close();
    await loadSites();
  } catch (error) { showError(error.message); }
});

document.querySelector("#post-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const id = document.querySelector("#post-id").value;
  const post = {
    title: document.querySelector("#post-title").value.trim(),
    slug: document.querySelector("#post-slug").value.trim(),
    body: document.querySelector("#post-body").value,
    status: document.querySelector("#post-status").value,
  };
  try {
    const path = id ? `/api/posts/${id}` : `/api/sites/${selectedSite().id}/posts`;
    await request(path, { method: id ? "PUT" : "POST", body: JSON.stringify(post) });
    postDialog.close();
    await loadPosts();
  } catch (error) { showError(error.message); }
});

document.querySelector("#dns-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const site = selectedSite();
  if (!site) return showError("Add or select a site before changing DNS.");
  const values = document.querySelector("#dns-values").value.split("\n").map((value) => value.trim()).filter(Boolean);
  const record = {
    name: document.querySelector("#dns-name").value.trim(),
    type: document.querySelector("#dns-type").value,
    ttl: Number(document.querySelector("#dns-ttl").value),
    values,
  };
  try {
    await request(`/api/sites/${site.id}/dns`, { method: "PUT", body: JSON.stringify(record) });
    document.querySelector("#dns-values").value = "";
    await loadDns();
  } catch (error) { showError(error.message); }
});

document.querySelector("#tracking-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const site = selectedSite();
  if (!site) return showError("Add or select a site before configuring tags.");
  const tracking = {
    gtm_id: document.querySelector("#gtm-id").value.trim(),
    ga4_id: document.querySelector("#ga4-id").value.trim(),
    meta_pixel_id: document.querySelector("#meta-pixel-id").value.trim(),
    tiktok_pixel_id: document.querySelector("#tiktok-pixel-id").value.trim(),
  };
  try {
    await request(`/api/sites/${site.id}/tracking`, { method: "PUT", body: JSON.stringify(tracking) });
    await loadTracking();
    notice.textContent = "Tracking settings saved.";
    notice.hidden = false;
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => { notice.hidden = true; }, 5000);
    notice.classList.add("notice-success");
  } catch (error) { showError(error.message); }
});

document.querySelector("#site-select").replaceChildren(new Option("Select a site", ""));
state.password = sessionStorage.getItem("sitecraft-admin-password") || "";
if (state.password) {
  fetch("/auth/check", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: state.password }),
  }).then((response) => {
    if (!response.ok) throw new Error("Session expired");
    loginPane.hidden = true;
    appShell.hidden = false;
    return loadSites();
  }).catch(() => signOut());
}
