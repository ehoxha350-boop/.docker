import wixData from "wix-data";

const CONFIG = {
  defaultCollectionName: "ContentItems",
  defaultOwner: "your-github-owner",
  defaultRepository: "your-repository",
  defaultBranch: "main",
  defaultPath: "content/content-items.json",
  pageSize: 1000,
  elements: {
    tokenInput: "#githubTokenInput",
    ownerInput: "#githubOwnerInput",
    repositoryInput: "#githubRepositoryInput",
    branchInput: "#githubBranchInput",
    pathInput: "#githubPathInput",
    collectionsInput: "#githubCollectionsInput",
    messageInput: "#githubMessageInput",
    syncButton: "#githubSyncButton",
    importButton: "#githubImportButton",
    statusText: "#githubStatusText",
    loadingBox: "#githubLoadingBox"
  }
};

$w.onReady(function () {
  setDefaultValue("ownerInput", CONFIG.defaultOwner);
  setDefaultValue("repositoryInput", CONFIG.defaultRepository);
  setDefaultValue("branchInput", CONFIG.defaultBranch);
  setDefaultValue("pathInput", CONFIG.defaultPath);
  setDefaultValue("collectionsInput", CONFIG.defaultCollectionName);
  setDefaultValue("messageInput", "Sync CMS content");

  $w(CONFIG.elements.syncButton).onClick(syncCmsToGitHub);
  $w(CONFIG.elements.importButton).onClick(importCmsFromGitHub);
  setStatus("Ready to export or import CMS content.", "success");
});

async function syncCmsToGitHub() {
  const settings = readSettings();
  const validationError = validateSettings(settings);

  if (validationError) {
    setStatus(validationError, "error");
    return;
  }

  setBusy(true);

  let completed = 0;
  try {
    const results = [];
    for (const collectionName of settings.collections) {
      const records = await getCmsRecords(collectionName);
      const content = createExport(collectionName, records);
      const fileSettings = getCollectionSettings(settings, collectionName);
      const existingFile = await getRepositoryFile(fileSettings);
      const response = await commitFile(fileSettings, content, existingFile?.sha);
      results.push(`${existingFile ? "updated" : "created"} ${fileSettings.path}`);
      completed += 1;
      console.info(`Exported ${records.length} records from ${collectionName} in commit ${response.commit.sha}.`);
    }

    setStatus(`Export complete: ${results.join("; ")}.`, "success");
  } catch (error) {
    console.error("GitHub CMS sync failed", error);
    const progress = completed ? `Export stopped after ${completed} collection(s). ` : "";
    setStatus(`${progress}${formatGitHubError(error)}`, "error");
  } finally {
    setBusy(false);
  }
}

async function importCmsFromGitHub() {
  const settings = readSettings();
  const validationError = validateSettings(settings);

  if (validationError) {
    setStatus(validationError, "error");
    return;
  }

  setBusy(true);

  let importedCount = 0;
  let completed = 0;
  try {
    for (const collectionName of settings.collections) {
      const fileSettings = getCollectionSettings(settings, collectionName);
      const repositoryFile = await getRepositoryFile(fileSettings);
      if (!repositoryFile) {
        throw new Error(`GitHub file ${fileSettings.path} was not found.`);
      }

      const exported = decodeExport(repositoryFile.content, collectionName);
      for (const record of exported.items) {
        const item = prepareImportedRecord(record, collectionName);
        await wixData.save(collectionName, item);
        importedCount += 1;
      }
      completed += 1;
    }

    setStatus(`Import complete: saved ${importedCount} record(s) across ${completed} collection(s).`, "success");
  } catch (error) {
    console.error("GitHub CMS import failed", error);
    const progress = importedCount
      ? `Import stopped after saving ${importedCount} record(s). `
      : completed
        ? `Import stopped after ${completed} collection(s). `
        : "";
    setStatus(`${progress}${formatGitHubError(error)}`, "error");
  } finally {
    setBusy(false);
  }
}

async function getCmsRecords(collectionName) {
  let result = await wixData.query(collectionName)
    .limit(CONFIG.pageSize)
    .ascending("_createdDate")
    .find();

  const records = [...result.items];
  while (result.hasNext()) {
    result = await result.next();
    records.push(...result.items);
  }

  return records;
}

function createExport(collectionName, records) {
  return JSON.stringify({
    generatedAt: new Date().toISOString(),
    collection: collectionName,
    count: records.length,
    items: records
  }, null, 2);
}

function getCollectionSettings(settings, collectionName) {
  return {
    ...settings,
    path: settings.path.replaceAll("{collection}", collectionName)
  };
}

async function getRepositoryFile(settings) {
  const url = buildContentsUrl(settings);
  const response = await githubRequest(url, settings.token, {
    method: "GET",
    headers: {
      Accept: "application/vnd.github+json"
    }
  }, true);

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    throw await createApiError(response);
  }

  return response.json();
}

function decodeExport(encodedContent, expectedCollection) {
  if (typeof encodedContent !== "string" || !encodedContent.trim()) {
    throw new Error("The GitHub file has no base64 content to import.");
  }

  let exported;
  try {
    const binary = atob(encodedContent.replace(/\s/g, ""));
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    exported = JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    throw new Error(`Could not decode the GitHub export: ${error.message}`);
  }

  if (!exported || exported.collection !== expectedCollection || !Array.isArray(exported.items)) {
    throw new Error(`The GitHub file is not a valid export for ${expectedCollection}.`);
  }

  return exported;
}

function prepareImportedRecord(record, collectionName) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new Error(`The ${collectionName} export contains an invalid record.`);
  }

  if (typeof record._id !== "string" || !record._id.trim()) {
    throw new Error(`A record in the ${collectionName} export is missing its Wix _id.`);
  }

  const item = { ...record };
  delete item._owner;
  delete item._createdDate;
  delete item._updatedDate;
  delete item._publishDate;
  delete item._revision;
  return item;
}

async function commitFile(settings, content, sha) {
  const body = {
    message: settings.message,
    content: encodeBase64Utf8(content),
    branch: settings.branch
  };

  if (sha) {
    body.sha = sha;
  }

  const response = await githubRequest(buildContentsUrl(settings), settings.token, {
    method: "PUT",
    headers: {
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    throw await createApiError(response);
  }

  return response.json();
}

function buildContentsUrl(settings) {
  const owner = encodeURIComponent(settings.owner);
  const repository = encodeURIComponent(settings.repository);
  const path = settings.path.split("/").map(encodeURIComponent).join("/");
  return `https://api.github.com/repos/${owner}/${repository}/contents/${path}`;
}

async function githubRequest(url, token, options = {}, allowNotFound = false) {
  const response = await fetch(url, {
    ...options,
    headers: {
      ...(options.headers || {}),
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28"
    }
  });

  if (allowNotFound && response.status === 404) {
    return response;
  }

  return response;
}

async function createApiError(response) {
  let details = "";

  try {
    const payload = await response.json();
    details = payload.message || "";
  } catch (error) {
    details = "";
  }

  return new Error(`GitHub returned ${response.status}${details ? `: ${details}` : "."}`);
}

function readSettings() {
  return {
    token: String($w(CONFIG.elements.tokenInput).value || "").trim(),
    owner: String($w(CONFIG.elements.ownerInput).value || "").trim(),
    repository: String($w(CONFIG.elements.repositoryInput).value || "").trim(),
    branch: String($w(CONFIG.elements.branchInput).value || "").trim(),
    path: String($w(CONFIG.elements.pathInput).value || "").trim(),
    collections: String($w(CONFIG.elements.collectionsInput).value || "")
      .split(/[,\n]/)
      .map((collectionName) => collectionName.trim())
      .filter(Boolean),
    message: String($w(CONFIG.elements.messageInput).value || "").trim()
  };
}

function validateSettings(settings) {
  if (!settings.token) {
    return "Enter a GitHub token with permission to read and write repository contents.";
  }

  if (!settings.owner || !settings.repository || !settings.branch || !settings.path) {
    return "Owner, repository, branch, and file path are required.";
  }

  if (settings.collections.length === 0) {
    return "Enter at least one CMS collection ID.";
  }

  if (settings.collections.some((collectionName) => !/^[A-Za-z0-9_-]+$/.test(collectionName))) {
    return "Collection IDs may contain only letters, numbers, underscores, and hyphens.";
  }

  if (new Set(settings.collections).size !== settings.collections.length) {
    return "Each CMS collection ID can be listed only once.";
  }

  if (!/^[A-Za-z0-9_.-]+$/.test(settings.owner)) {
    return "The GitHub owner is invalid.";
  }

  if (!/^[A-Za-z0-9_.-]+$/.test(settings.repository)) {
    return "The GitHub repository name is invalid.";
  }

  if (settings.path.startsWith("/") || settings.path.includes("..")) {
    return "The file path must be relative and cannot contain '..'.";
  }

  if (settings.collections.length > 1 && !settings.path.includes("{collection}")) {
    return "For multiple collections, include {collection} in the file path.";
  }

  return "";
}

function encodeBase64Utf8(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";

  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });

  return btoa(binary);
}

function setDefaultValue(elementName, value) {
  const element = $w(CONFIG.elements[elementName]);
  if (!element.value) {
    element.value = value;
  }
}

function setBusy(isBusy) {
  if (isBusy) {
    $w(CONFIG.elements.loadingBox).show();
    $w(CONFIG.elements.syncButton).disable();
    $w(CONFIG.elements.importButton).disable();
  } else {
    $w(CONFIG.elements.loadingBox).hide();
    $w(CONFIG.elements.syncButton).enable();
    $w(CONFIG.elements.importButton).enable();
  }
}

function setStatus(message, type) {
  const status = $w(CONFIG.elements.statusText);
  status.text = message;
  status.style.color = type === "error" ? "#B42318" : "#18794E";
}

function formatGitHubError(error) {
  if (error?.message?.includes("401")) {
    return "GitHub rejected the token. Check that it is valid and has repository contents write permission.";
  }

  if (error?.message?.includes("404")) {
    return "Repository, branch, or file path was not found, or the token cannot access it.";
  }

  return error?.message || "The CMS export failed.";
}