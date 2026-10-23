// Collection Sorter: sorts Postman collections in the browser. Nothing is uploaded.

const UNNAMED = '(unnamed)';

const dom = {
  dropZone: document.getElementById('drop'),
  filePicker: document.getElementById('pick'),
  results: document.getElementById('results'),
  cardTemplate: document.getElementById('card'),
  actionBar: document.getElementById('bar'),
  downloadAllButton: document.getElementById('all'),
  clearButton: document.getElementById('clear'),
  placeholders: document.getElementById('ph'),
  foldersFirst: document.getElementById('ff'),
  naturalOrder: document.getElementById('nat'),
  sortedSuffix: document.getElementById('suf'),
  showRequests: document.getElementById('req'),
  direction: document.getElementById('dir'),
};

let loadedFiles = []; // [{ name, text }]


// ---------- Collection helpers ----------

const isFolder = item => Array.isArray(item.item);
const itemName = item => item.name || UNNAMED;

function topLevelItems(json) {
  const collection = Array.isArray(json) ? json[0] : json;
  return collection?.item || [];
}

// Snapshot of the folder/request tree. Taken before sorting, since sorting reorders in place.
function outline(items) {
  return items.map(item => ({
    name: itemName(item),
    method: item.request?.method,
    children: isFolder(item) ? outline(item.item) : null,
  }));
}

function countRequests(items) {
  return items.reduce((total, item) => total + (isFolder(item) ? countRequests(item.item) : 1), 0);
}

function countFolders(items) {
  return items.reduce((total, item) => total + (isFolder(item) ? 1 + countFolders(item.item) : 0), 0);
}

function hasDescription(item) {
  return [item.description, item.request?.description].some(description =>
    typeof description === 'string'
      ? description.trim() !== ''
      : Boolean(description && (description.content || description.raw))
  );
}


// ---------- Sorting (ported from the original CLI script) ----------

function readSortOptions() {
  return {
    addPlaceholders: dom.placeholders.checked,
    foldersFirst: dom.foldersFirst.checked,
    naturalOrder: dom.naturalOrder.checked,
    direction: Number(dom.direction.value),
  };
}

function compareItems(a, b, options) {
  if (options.foldersFirst && isFolder(a) !== isFolder(b)) return isFolder(a) ? -1 : 1;
  const nameA = (a.name || '').toLowerCase();
  const nameB = (b.name || '').toLowerCase();
  return options.direction * nameA.localeCompare(nameB, undefined, { numeric: options.naturalOrder });
}

function sortItems(items, options) {
  items.sort((a, b) => compareItems(a, b, options));
  for (const item of items) {
    if (isFolder(item)) sortItems(item.item, options);
    if (options.addPlaceholders && !hasDescription(item)) {
      item.description = `TODO: Add a short description for "${item.name || 'unnamed'}".`;
    }
  }
}

function sortCollection(json, options) {
  if (!json || typeof json !== 'object') throw new Error('Unsupported JSON shape for Postman collection');
  for (const collection of Array.isArray(json) ? json : [json]) {
    if (Array.isArray(collection?.item)) sortItems(collection.item, options);
  }
  return json;
}


// ---------- Processing one file ----------

// Returns { name, error } or { name, output, before, after }.
function processFile({ name, text }) {
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return { name, error: `${name} is not valid JSON. Export the collection from Postman and try again.` };
  }

  const before = outline(topLevelItems(json));
  try {
    json = sortCollection(json, readSortOptions());
  } catch (error) {
    return { name, error: error.message };
  }

  const after = topLevelItems(json);
  if (!after.length) return { name, error: `${name} has no Postman items. Is this a collection export?` };
  return { name, output: JSON.stringify(json, null, 2), before, after };
}

function downloadName(name) {
  if (!dom.sortedSuffix.checked) return name;
  return /\.json$/i.test(name) ? name.replace(/\.json$/i, '.sorted.json') : `${name}.sorted.json`;
}


// ---------- Downloading ----------

function download(name, text) {
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  link.download = name;
  link.click();
  URL.revokeObjectURL(link.href);
}


// ---------- Rendering ----------

function buildTreeEntries(nodes) {
  const visibleNodes = dom.showRequests.checked ? nodes : nodes.filter(node => node.children);
  return visibleNodes.map(node => {
    const entry = document.createElement('li');

    if (node.method) {
      const method = document.createElement('span');
      method.className = 'method';
      method.textContent = node.method;
      entry.append(method);
    }

    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = node.name;
    entry.append(label);

    if (node.children) {
      entry.classList.add('folder');
      const nested = document.createElement('ul');
      nested.append(...buildTreeEntries(node.children));
      entry.append(nested);
    }
    return entry;
  });
}

function fillTree(list, nodes) {
  list.replaceChildren(...buildTreeEntries(nodes));
}

function buildErrorCard(card, result) {
  const pill = card.querySelector('.pill');
  pill.textContent = 'Error';
  pill.classList.add('bad');

  const message = card.querySelector('.stats');
  message.textContent = result.error;
  message.classList.add('err');

  card.querySelector('.cols').remove();
  card.querySelector('.actions').remove();
}

function buildResultCard(card, result) {
  card.querySelector('.pill').textContent = 'Sorted';
  card.querySelector('.stats').textContent =
    `${countFolders(result.after)} folders, ${countRequests(result.after)} requests.`;
  fillTree(card.querySelector('.before'), result.before);
  fillTree(card.querySelector('.after'), outline(result.after));

  const fileName = downloadName(result.name);
  const button = card.querySelector('.dl');
  button.textContent = `Download ${fileName}`;
  button.onclick = () => download(fileName, result.output);
}

function buildCard(result) {
  const card = dom.cardTemplate.content.firstElementChild.cloneNode(true);
  card.querySelector('.fname').textContent = result.name;
  if (result.error) buildErrorCard(card, result);
  else buildResultCard(card, result);
  return card;
}

function render() {
  const results = loadedFiles.map(processFile);
  const sorted = results.filter(result => result.output);

  dom.results.replaceChildren(...results.map(buildCard));
  dom.actionBar.hidden = loadedFiles.length === 0;
  dom.downloadAllButton.hidden = sorted.length < 2;
  dom.downloadAllButton.onclick = () =>
    sorted.forEach(result => download(downloadName(result.name), result.output));
}


// ---------- Events ----------

async function loadFiles(fileList) {
  if (!fileList.length) return;
  loadedFiles = await Promise.all(
    [...fileList].map(async file => ({ name: file.name, text: await file.text() }))
  );
  render();
}

function clearFiles() {
  loadedFiles = [];
  dom.filePicker.value = '';
  render();
}

function openFilePicker() {
  dom.filePicker.click();
}

dom.clearButton.onclick = clearFiles;
[dom.placeholders, dom.foldersFirst, dom.naturalOrder, dom.sortedSuffix, dom.showRequests, dom.direction]
  .forEach(control => { control.onchange = render; });

dom.dropZone.onclick = openFilePicker;
dom.dropZone.onkeydown = event => {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  event.preventDefault();
  openFilePicker();
};
dom.filePicker.onchange = event => loadFiles(event.target.files);

dom.dropZone.ondragover = event => {
  event.preventDefault();
  dom.dropZone.classList.add('over');
};
dom.dropZone.ondragleave = () => dom.dropZone.classList.remove('over');
dom.dropZone.ondrop = event => {
  event.preventDefault();
  dom.dropZone.classList.remove('over');
  loadFiles(event.dataTransfer.files);
};
