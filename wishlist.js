'use strict';

const endpoint = document.querySelector('meta[name="wishlist-endpoint"]').content;
const sessionStorageKey = 'family-christmas-wishlist-session';
const selectionStorageKey = 'family-christmas-wishlist-selection';
const wishlistTabs = document.querySelector('#wishlist-tabs');
const unlockPanel = document.querySelector('#unlock-panel');
const unlockForm = document.querySelector('#unlock');
const passphrase = document.querySelector('#passphrase');
const unlockButton = unlockForm.querySelector('button');
const status = document.querySelector('#status');
const giftsPanel = document.querySelector('#gifts-panel');
const giftsHeading = document.querySelector('#gifts-heading');
const refresh = document.querySelector('#refresh');
const manage = document.querySelector('#manage-wishlists');
const adminPanel = document.querySelector('#wishlist-admin');
const adminForm = document.querySelector('#admin-unlock');
const adminPassphrase = document.querySelector('#admin-passphrase');
const addListForm = document.querySelector('#add-wishlist');
const adminStatus = document.querySelector('#admin-status');
const adminHeading = document.querySelector('#admin-heading');
const cancelAdmin = document.querySelector('#cancel-admin-dialog');
const openAddGift = document.querySelector('#open-add-gift');
const giftAddFooter = document.querySelector('#gift-add-footer');
const editConnectedList = document.querySelector('#edit-connected-list');
const removeConnectedList = document.querySelector('#remove-connected-list');
const addGiftForm = document.querySelector('#add-gift');
const queueGift = document.querySelector('#queue-gift');
const pendingGiftList = document.querySelector('#pending-gifts');
const saveGifts = document.querySelector('#save-gifts');
const saveWishlist = document.querySelector('#save-wishlist');
const removeDialog = document.querySelector('#remove-wishlist-dialog');
const removalHeading = document.querySelector('#remove-wishlist-heading');
const removeMessage = document.querySelector('#remove-wishlist-message');
const cancelRemoval = document.querySelector('#cancel-wishlist-removal');
const confirmRemoval = document.querySelector('#confirm-wishlist-removal');
const empty = document.querySelector('#empty');
const available = document.querySelector('#available');
const purchased = document.querySelector('#purchased');
const purchasedPanel = document.querySelector('#purchased-panel');
const template = document.querySelector('#gift-template');
const priceFormat = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const targetProductPhotos = new Map([
  ['92538311', 'https://target.scene7.com/is/image/Target/GUEST_d3e5d017-e003-4bdf-b379-d1516216de06?fmt=pjpeg&hei=300&wid=300'],
]);

let token = '';
let gifts = [];
let listRevision;
let busy = false;
let adminToken = '';
let editingList = null;
let managedLists = [];
let pendingGiftId;
let pendingGifts = [];
let removingList = null;
let editingGift = null;
let removingGift = null;
let lists = [];
let selectedList = null;

const errors = {
  incorrect_passphrase: 'That passphrase didn’t match. Try again.',
  rate_limited: 'There have been too many attempts. Wait two minutes and try again.',
  session_expired: 'Your session expired. Enter the family passphrase again.',
  gift_missing: 'This gift may have changed. Refresh the list and try again.',
  gift_changed: 'This gift changed after you opened it. Open it again to see the latest details.',
  busy: 'The wishlist is busy. Please try again.',
  list_unavailable: 'This list’s Google Sheet is unavailable. Ask the list organizer to check its sharing and setup.',
  admin_unavailable: 'Wishlist administration hasn’t been configured.',
  admin_session_expired: 'Admin access expired. Enter the admin passphrase again.',
  invalid_list_settings: 'Enter a child name, a valid Google Sheet link or ID if needed, and the exact gift tab name.',
  invalid_gift: 'Enter a gift name or a valid shopping link, and a nonnegative price with up to two decimal places if needed.',
  invalid_gift_batch: 'Check the pasted gift names, shopping links, and prices, then preview the gifts again.',
  list_already_added: 'That gift tab is already connected.',
  list_changed: 'This wishlist changed since you opened settings. Close and reopen settings, then try again.',
};

function showStatus(message, isError = false) {
  status.textContent = message;
  status.classList.toggle('error', isError);
  status.classList.remove('opening');
}

function showOpeningStatus() {
  showStatus('Opening wishlist…');
  status.classList.add('opening');
}

function finishOpeningWishlist() {
  if (status.classList.contains('opening')) showStatus('');
}

function updateGiftButtonPlacement() {
  if (giftAddFooter.hidden) return;
  // The footer keeps the same height when the button floats.
  const footerBottom = giftAddFooter.getBoundingClientRect().bottom + window.scrollY;
  giftAddFooter.classList.toggle('floating', footerBottom > document.documentElement.clientHeight + 1);
}

new ResizeObserver(updateGiftButtonPlacement).observe(giftAddFooter.parentElement);
window.addEventListener('resize', updateGiftButtonPlacement);

function storeSession(value) {
  token = value;
  try {
    if (value) sessionStorage.setItem(sessionStorageKey, value);
    else sessionStorage.removeItem(sessionStorageKey);
  } catch {
    // The list remains usable when browser storage is unavailable.
  }
}

function setBusy(value) {
  busy = value;
  unlockButton.disabled = value || !endpoint;
  passphrase.readOnly = value;
  refresh.disabled = value;
  manage.disabled = value;
  openAddGift.disabled = value;
  editConnectedList.disabled = value;
  removeConnectedList.disabled = value;
  adminPanel.querySelectorAll('button').forEach(button => { button.disabled = value; });
  addGiftForm.querySelectorAll('input, select').forEach(field => { field.disabled = value; });
  confirmRemoval.disabled = value;
  wishlistTabs.querySelectorAll('button').forEach(button => { button.disabled = value; });
  available.querySelectorAll('input').forEach(input => { input.disabled = value || input.dataset.waitingForId === 'true'; });
  document.querySelectorAll('.gift-admin-actions button').forEach(button => {
    button.disabled = value || button.dataset.waitingForId === 'true';
  });
}

function selectWishlist(id) {
  selectedList = lists.find(list => list.id === id) || null;
  giftsHeading.textContent = selectedList ? selectedList.name + '’s gift ideas' : 'Gift ideas';
  syncAdminControls();
  wishlistTabs.querySelectorAll('button').forEach(button => {
    button.setAttribute('aria-pressed', String(button.dataset.listId === id));
  });
  try {
    if (selectedList) sessionStorage.setItem(selectionStorageKey, selectedList.id);
    else sessionStorage.removeItem(selectionStorageKey);
  } catch {
    // Selection still works for the current page.
  }
}

function renderWishlistTabs() {
  wishlistTabs.replaceChildren();
  for (const list of lists) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'secondary';
    button.dataset.listId = list.id;
    button.textContent = list.name;
    button.addEventListener('click', async () => {
      if (busy || selectedList?.id === list.id) return;
      selectWishlist(list.id);
      clearGifts();
      setBusy(true);
      showOpeningStatus();
      try {
        await loadGifts(true);
      } catch (error) {
        reportError(error, 'Couldn’t open this wishlist. Use Refresh to try again.');
      } finally {
        setBusy(false);
      }
    });
    wishlistTabs.append(button);
  }
  if (adminToken) {
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'secondary';
    add.textContent = '+';
    add.setAttribute('aria-label', 'Connect a spreadsheet');
    add.addEventListener('click', () => {
      if (!busy && adminToken) openListEditor(null);
    });
    wishlistTabs.append(add);
  }
  wishlistTabs.hidden = !lists.length && !adminToken;
}

async function request(action, fields = {}) {
  const url = new URL(endpoint);
  if (url.origin !== 'https://script.google.com' ||
      !/^\/macros\/s\/[\w-]+\/exec$/.test(url.pathname) ||
      url.search || url.hash || url.username || url.password) {
    throw new Error('invalid_endpoint');
  }
  const response = await fetch(url, {
    method: 'POST',
    credentials: 'omit',
    headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
    body: JSON.stringify({ action, token, ...fields }),
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error('service_unavailable');
  const result = await response.json();
  if (!result.ok) throw new Error(result.code || 'service_unavailable');
  return result;
}

function shoppingUrl(value) {
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') &&
      !url.username && !url.password ? url.href : '';
  } catch {
    return '';
  }
}

function productPhoto(shoppingLink) {
  const url = new URL(shoppingLink);
  if (url.hostname === 'www.target.com' || url.hostname === 'target.com') {
    const id = url.pathname.match(/^\/p\/.*\/A-(\d+)\/?$/i)?.[1];
    return targetProductPhotos.get(id) || '';
  }
  return '';
}

function renderGifts() {
  const availableRows = document.createDocumentFragment();
  const purchasedRows = document.createDocumentFragment();
  gifts.forEach(gift => {
    const row = template.content.cloneNode(true);
    const name = row.querySelector('.gift-name');
    name.textContent = gift.name;
    if (Number.isFinite(gift.price) && gift.price >= 0) {
      const price = document.createElement('span');
      price.textContent = priceFormat.format(gift.price);
      name.after(price);
    }
    const link = row.querySelector('.shop-link');
    const url = shoppingUrl(gift.url);
    if (url) {
      link.href = url;
      link.setAttribute('aria-label', 'Buy Now: ' + gift.name);
      link.hidden = false;
      const photoUrl = gift.imageUrl || productPhoto(url);
      if (photoUrl) {
        const photo = row.querySelector('.gift-photo');
        photo.addEventListener('error', () => { photo.hidden = true; }, { once: true });
        photo.hidden = false;
        photo.src = photoUrl;
      }
    }
    const control = row.querySelector('.purchase-control');
    const checkbox = control.querySelector('input');
    control.hidden = gift.purchased;
    row.querySelector('.purchased-label').hidden = !gift.purchased;
    checkbox.setAttribute('aria-label', 'Purchased: ' + gift.name);
    checkbox.dataset.waitingForId = String(!gift.id);
    checkbox.disabled = busy || !gift.id;
    if (!gift.id) control.title = 'Refresh to enable purchase tracking for this gift.';
    checkbox.addEventListener('change', () => {
      checkbox.checked = false;
      if (!busy && gift.id) markPurchased(gift, checkbox);
    });
    const adminActions = row.querySelector('.gift-admin-actions');
    adminActions.hidden = !adminToken || !selectedManagedList();
    for (const [selector, label, removing] of [['.gift-edit', 'Edit', false], ['.gift-remove', 'Delete', true]]) {
      const button = adminActions.querySelector(selector);
      button.dataset.waitingForId = String(!gift.id);
      button.disabled = busy || !gift.id;
      button.setAttribute('aria-label', label + ' ' + gift.name);
      button.title = label + ' gift';
      button.addEventListener('click', () => openGiftAdmin(gift, removing));
    }
    (gift.purchased ? purchasedRows : availableRows).append(row);
  });
  available.replaceChildren(availableRows);
  purchased.replaceChildren(purchasedRows);
  purchasedPanel.hidden = !purchased.childElementCount;
  empty.hidden = !!available.childElementCount;
  empty.textContent = gifts.length ? 'All gifts have been purchased.' : 'No gifts have been added yet.';
}

function clearGifts() {
  gifts = [];
  listRevision = undefined;
  renderGifts();
  empty.hidden = true;
}

function showLocked(shouldFocus = true) {
  storeSession('');
  closeAdmin();
  lists = [];
  selectedList = null;
  renderWishlistTabs();
  clearGifts();
  giftsPanel.hidden = true;
  unlockPanel.hidden = false;
  passphrase.value = '';
  if (shouldFocus) passphrase.focus();
}

function syncAdminControls() {
  const canManage = !!adminToken && managedLists.some(list => list.id === selectedList?.id);
  manage.textContent = adminToken ? 'Exit admin' : 'Manage wishlists';
  giftAddFooter.hidden = !canManage;
  updateGiftButtonPlacement();
  editConnectedList.hidden = !canManage;
  removeConnectedList.hidden = !canManage;
  document.querySelectorAll('.gift-admin-actions').forEach(actions => { actions.hidden = !canManage; });
}

function closeAdmin() {
  adminToken = '';
  managedLists = [];
  editingList = null;
  editingGift = null;
  adminForm.reset();
  addListForm.reset();
  resetGiftEntry();
  adminPanel.close();
  renderWishlistTabs();
  selectWishlist(selectedList?.id);
}

function showAdminForm(form, heading, field) {
  adminHeading.textContent = heading;
  for (const candidate of [adminForm, addListForm, addGiftForm]) candidate.hidden = candidate !== form;
  adminStatus.textContent = '';
  if (!adminPanel.open) adminPanel.showModal();
  field.focus();
}

manage.addEventListener('click', () => {
  if (adminToken) {
    closeAdmin();
    showStatus('');
    return;
  }
  showAdminForm(adminForm, 'Manage wishlists', adminPassphrase);
});

cancelAdmin.addEventListener('click', () => adminPanel.close());
adminPanel.addEventListener('cancel', event => {
  if (busy) event.preventDefault();
});

function reportAdminError(error, fallback) {
  if (error.message === 'session_expired') {
    reportError(error, fallback);
    return;
  }
  if (error.message === 'admin_session_expired') {
    closeAdmin();
    showAdminForm(adminForm, 'Manage wishlists', adminPassphrase);
  }
  if (adminPanel.open) adminStatus.textContent = errors[error.message] || fallback;
  else showStatus(errors[error.message] || fallback, true);
}

async function loadManagedLists() {
  const result = await request('admin_lists', { adminToken });
  managedLists = result.lists;
}

adminForm.addEventListener('submit', async event => {
  event.preventDefault();
  if (busy) return;
  setBusy(true);
  adminStatus.textContent = 'Unlocking settings…';
  try {
    const result = await request('admin_unlock', { passphrase: adminPassphrase.value, includeLists: true });
    adminToken = result.token;
    if (result.lists) managedLists = result.lists;
    else await loadManagedLists();
    adminPanel.close();
    const directory = managedLists.map(({ id, name }) => ({ id, name }));
    if (JSON.stringify(directory) === JSON.stringify(lists)) {
      renderWishlistTabs();
      selectWishlist(selectedList?.id);
    } else {
      await applyWishlistDirectory(directory);
    }
    showStatus('Admin mode unlocked.');
  } catch (error) {
    if (adminToken && adminPanel.open) adminToken = '';
    reportAdminError(error, 'Couldn’t unlock settings. Try again.');
  } finally {
    adminForm.reset();
    setBusy(false);
    if (!adminPanel.open) manage.focus();
  }
});

function selectedManagedList() {
  return managedLists.find(list => list.id === selectedList?.id);
}

function openListEditor(list) {
  editingList = list;
  addListForm.reset();
  saveWishlist.textContent = list ? 'Save changes' : 'Add wishlist';
  if (list) {
    addListForm.elements.name.value = list.name;
    addListForm.elements.source.value = list.source;
    addListForm.elements.tab.value = list.tab;
  }
  showAdminForm(addListForm, list ? 'Edit wishlist' : 'Connect a spreadsheet', addListForm.elements.name);
}

editConnectedList.addEventListener('click', () => {
  const list = selectedManagedList();
  if (!busy && adminToken && list) openListEditor(list);
});

removeConnectedList.addEventListener('click', () => {
  const list = selectedManagedList();
  if (!list || !adminToken || busy) return;
  removingList = list;
  removalHeading.textContent = 'Remove wishlist?';
  confirmRemoval.textContent = 'Remove wishlist';
  removeMessage.textContent = 'Remove ' + list.name + ' from the website? Its Google Sheet and gifts will be kept.';
  removeDialog.showModal();
});

openAddGift.addEventListener('click', () => {
  const list = selectedManagedList();
  if (!list || !adminToken || busy) return;
  editingGift = null;
  resetGiftEntry();
  queueGift.hidden = false;
  saveGifts.textContent = 'Done';
  showAdminForm(addGiftForm, 'Add a gift to ' + list.name, addGiftForm.elements.name);
});

function renderPendingGifts() {
  pendingGiftList.replaceChildren();
  pendingGiftList.hidden = !pendingGifts.length;
  for (const gift of pendingGifts) {
    const row = document.createElement('li');
    const label = document.createElement('span');
    label.textContent = gift.name || gift.link;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'secondary';
    remove.textContent = 'Remove';
    remove.setAttribute('aria-label', 'Remove ' + label.textContent + ' from pending gifts');
    remove.addEventListener('click', () => {
      if (busy) return;
      pendingGifts = pendingGifts.filter(entry => entry !== gift);
      renderPendingGifts();
      adminStatus.textContent = '';
      addGiftForm.elements.name.focus();
    });
    row.append(label, remove);
    pendingGiftList.append(row);
  }
}

function resetGiftEntry() {
  pendingGifts = [];
  pendingGiftId = undefined;
  addGiftForm.reset();
  renderPendingGifts();
}

function readGiftEntry() {
  const fields = Object.fromEntries(new FormData(addGiftForm));
  fields.name = fields.name.trim();
  fields.link = fields.link.trim();
  if (!fields.name && !fields.link && !fields.price && fields.priority === 'Normal') return null;
  if ((!fields.name && !fields.link) || (fields.link && !/^https?:\/\/[\w.-]+(?::\d+)?(?:[/?#][^\s\\]*)?$/i.test(fields.link)) ||
      (fields.price && !/^\d{1,9}(?:\.\d{1,2})?$/.test(fields.price))) {
    throw new Error(errors.invalid_gift);
  }
  pendingGiftId ||= crypto.randomUUID();
  return { ...fields, giftId: pendingGiftId };
}

queueGift.addEventListener('click', () => {
  if (busy || editingGift || !selectedManagedList() || !addGiftForm.reportValidity()) return;
  try {
    const gift = readGiftEntry();
    if (!gift) throw new Error(errors.invalid_gift);
    if (pendingGifts.length >= 25) throw new Error('Save these 25 gifts before adding more.');
    pendingGifts.push(gift);
    renderPendingGifts();
    pendingGiftId = undefined;
    addGiftForm.reset();
    adminStatus.textContent = pendingGifts.length === 1 ? '1 gift ready to add.' : pendingGifts.length + ' gifts ready to add.';
    addGiftForm.elements.name.focus();
  } catch (error) {
    adminStatus.textContent = error.message;
  }
});

async function openGiftAdmin(gift, removing) {
  const list = selectedManagedList();
  if (!list || !adminToken || busy) return;
  setBusy(true);
  try {
    const result = await request('admin_get_gift', {
      listId: list.id, previous: JSON.stringify(list), giftId: gift.id, adminToken,
    });
    if (removing) {
      removingGift = result;
      removalHeading.textContent = 'Delete gift?';
      confirmRemoval.textContent = 'Delete gift';
      removeMessage.textContent = 'Delete ' + gift.name + ' from ' + list.name + ' and its Google Sheet?';
      removeDialog.showModal();
    } else {
      editingGift = result;
      resetGiftEntry();
      queueGift.hidden = true;
      for (const field of ['name', 'link', 'priority', 'price']) {
        addGiftForm.elements[field].value = result.gift[field];
      }
      saveGifts.textContent = 'Save gift';
      showAdminForm(addGiftForm, 'Edit gift', addGiftForm.elements.name);
    }
  } catch (error) {
    reportAdminError(error, 'Couldn’t open this gift. Try again.');
  } finally {
    setBusy(false);
    if (adminPanel.open && !addGiftForm.hidden) addGiftForm.elements.name.focus();
  }
}

addGiftForm.addEventListener('input', () => { pendingGiftId = undefined; });
addGiftForm.addEventListener('submit', async event => {
  event.preventDefault();
  const list = selectedManagedList();
  if (busy || !adminToken || !list) return;
  const existing = editingGift;
  let entries;
  try {
    const current = readGiftEntry();
    entries = current ? [...pendingGifts, current] : pendingGifts;
    if (!entries.length) throw new Error(errors.invalid_gift);
    if (entries.length > 25) throw new Error('Only 25 gifts can be saved at once. Remove a pending gift or clear the current entry.');
  } catch (error) {
    adminStatus.textContent = error.message;
    return;
  }
  const batch = entries.length > 1;
  setBusy(true);
  adminStatus.textContent = batch ? 'Saving gifts…' : 'Saving gift…';
  try {
    const target = { adminToken, listId: list.id, previous: JSON.stringify(list), includeView: true };
    const result = batch
      ? await request('admin_add_gifts', { ...target, gifts: entries })
      : await request(existing ? 'admin_edit_gift' : 'admin_add_gift', {
        ...target, ...entries[0], giftId: existing?.gift.id || entries[0].giftId, revision: existing?.revision,
      });
    editingGift = null;
    resetGiftEntry();
    adminPanel.close();
    let message = existing ? 'Gift updated.' : 'Gift added to ' + list.name + '.';
    if (batch) {
      message = result.added + (result.added === 1 ? ' gift added.' : ' gifts added.');
      if (result.skipped) message += ' Skipped ' + result.skipped + (result.skipped === 1 ? ' duplicate.' : ' duplicates.');
    }
    showStatus(message);
    try {
      if (result.view) displayGifts(result.view);
      else await loadGifts();
    } catch (error) {
      reportError(error, message + ' Use Refresh to load the updated list.');
    }
  } catch (error) {
    reportAdminError(error, 'Couldn’t save. Try again.');
  } finally {
    setBusy(false);
    if (!adminPanel.open) openAddGift.focus();
  }
});

async function refreshAfterManage(message, listId, updatedLists) {
  adminPanel.close();
  showStatus(message);
  try {
    if (updatedLists) managedLists = updatedLists;
    else await loadManagedLists();
    await applyWishlistDirectory(managedLists.map(({ id, name }) => ({ id, name })), false, listId);
  } catch (error) {
    reportAdminError(error, message + ' Use Refresh to load the updated lists.');
  }
}

cancelRemoval.addEventListener('click', () => removeDialog.close());
removeDialog.addEventListener('close', () => {
  removingList = null;
  removingGift = null;
});
confirmRemoval.addEventListener('click', async () => {
  const gift = removingGift;
  const list = gift ? selectedManagedList() : removingList;
  if (busy || !adminToken || !list) return;
  removeDialog.close();
  setBusy(true);
  try {
    const fields = { listId: list.id, previous: JSON.stringify(list), adminToken };
    if (gift) {
      const result = await request('admin_remove_gift', {
        ...fields, giftId: gift.gift.id, revision: gift.revision, includeView: true,
      });
      showStatus('Gift deleted.');
      if (result.view) displayGifts(result.view);
      else await loadGifts();
    } else {
      const result = await request('admin_remove_list', fields);
      await refreshAfterManage('Removed ' + list.name + ' from the wishlist tabs.', undefined, result.managedLists);
    }
  } catch (error) {
    reportAdminError(error, gift ? 'Couldn’t delete the gift or reload the list. Use Refresh to check.' : 'Couldn’t remove the wishlist. Try again.');
  } finally {
    setBusy(false);
  }
});

addListForm.addEventListener('submit', async event => {
  event.preventDefault();
  if (busy || !adminToken) return;
  const fields = Object.fromEntries(new FormData(addListForm));
  setBusy(true);
  adminStatus.textContent = 'Checking and connecting the Sheet…';
  try {
    const previous = editingList;
    const { list, managedLists: updatedLists } = await request(previous ? 'admin_edit_list' : 'admin_add_list', {
      ...fields, adminToken, listId: previous?.id, previous: previous ? JSON.stringify(previous) : undefined,
    });
    await refreshAfterManage(previous ? 'Saved changes to ' + list.name + '.' : 'Added ' + list.name + ' to the wishlist tabs.', list.id, updatedLists);
  } catch (error) {
    if (error.message === 'list_unavailable') adminStatus.textContent = 'Check the tab name, gift column headers, and Google Sheet sharing.';
    else reportAdminError(error, 'Couldn’t save the wishlist. Try again.');
  } finally {
    setBusy(false);
  }
});

function reportError(error, fallback) {
  if (error.message === 'session_expired') showLocked();
  showStatus(errors[error.message] || fallback, true);
}

async function loadGifts(focusHeading = false) {
  const listId = selectedList?.id;
  // Older Apps Script deployments still need the flag to skip retailer requests.
  const result = await request('list', { listId, skipLookup: true });
  displayGifts(result, focusHeading);
}

function displayGifts(result, focusHeading = false) {
  if (!result.ok) throw new Error(result.code);
  gifts = result.gifts;
  listRevision = result.listRevision;
  passphrase.value = '';
  unlockPanel.hidden = true;
  giftsPanel.hidden = false;
  renderGifts();
  finishOpeningWishlist();
  if (focusHeading) giftsHeading.focus();
}

async function openWishlists(focusHeading = false) {
  if (adminToken) {
    try {
      let result;
      try {
        result = await request('admin_open', { adminToken, listId: currentWishlistId() });
      } catch (error) {
        if (error.message !== 'invalid_request') throw error;
        await loadManagedLists();
        return applyWishlistDirectory(managedLists.map(({ id, name }) => ({ id, name })), focusHeading);
      }
      managedLists = result.managedLists;
      return applyWishlistDirectory(result.lists, focusHeading, result.selectedId, result.view);
    } catch (error) {
      if (error.message !== 'admin_session_expired') throw error;
      closeAdmin();
    }
  }
  try {
    const result = await request('open', { listId: currentWishlistId() });
    return applyWishlistDirectory(result.lists, focusHeading, result.selectedId, result.view);
  } catch (error) {
    if (error.message !== 'invalid_request') throw error;
  }
  let directory;
  try {
    directory = await request('directory');
  } catch (error) {
    // Older deployments support the original single-list form.
    if (error.message !== 'invalid_request') throw error;
    lists = [];
    renderWishlistTabs();
    selectWishlist(null);
    return loadGifts(focusHeading);
  }
  return applyWishlistDirectory(directory.lists, focusHeading);
}

function currentWishlistId() {
  if (selectedList) return selectedList.id;
  try {
    return sessionStorage.getItem(selectionStorageKey);
  } catch {
    return undefined;
  }
}

async function applyWishlistDirectory(connectedLists, focusHeading = false, preferredId, view) {
  lists = connectedLists;
  const next = lists.find(list => list.id === (preferredId || currentWishlistId())) || lists[0];
  if (next?.id !== selectedList?.id) clearGifts();
  renderWishlistTabs();
  selectWishlist(next?.id);
  if (next) {
    if (view) return displayGifts(view, focusHeading);
    return loadGifts(focusHeading);
  }

  passphrase.value = '';
  unlockPanel.hidden = true;
  giftsPanel.hidden = false;
  clearGifts();
  empty.textContent = 'No wishlists have been configured yet.';
  empty.hidden = false;
  finishOpeningWishlist();
  if (focusHeading) giftsHeading.focus();
}

async function markPurchased(gift, checkbox) {
  setBusy(true);
  showStatus('Saving purchase…');
  try {
    const result = await request('purchase', { giftId: gift.id, listId: selectedList?.id, listRevision });
    gift.purchased = true;
    renderGifts();
    giftsHeading.focus();
    showStatus(result.alreadyPurchased ? 'This gift was already marked purchased.' : 'Purchase saved.');
  } catch (error) {
    if (error.message === 'list_changed') {
      clearGifts();
      showStatus('This wishlist’s source changed. Refresh before marking a gift purchased.', true);
    } else {
      reportError(error, 'Couldn’t confirm the purchase. Refresh the list or try again.');
    }
  } finally {
    setBusy(false);
    if (checkbox.isConnected && !giftsPanel.hidden) checkbox.focus();
  }
}

unlockForm.addEventListener('submit', async event => {
  event.preventDefault();
  if (busy || !endpoint) return;
  setBusy(true);
  showOpeningStatus();
  try {
    const result = await request('unlock', { passphrase: passphrase.value, includeView: true, listId: currentWishlistId() });
    storeSession(result.token);
    if (result.lists) await applyWishlistDirectory(result.lists, true, result.selectedId, result.view);
    else await openWishlists(true);
  } catch (error) {
    if (unlockPanel.hidden === false) storeSession('');
    reportError(error, 'Couldn’t open the wishlist. Please try again.');
  } finally {
    setBusy(false);
  }
});

refresh.addEventListener('click', async () => {
  if (busy) return;
  setBusy(true);
  showStatus('Refreshing…');
  try {
    await openWishlists();
    showStatus('Wishlist updated.');
  } catch (error) {
    reportError(error, 'Couldn’t refresh the wishlist. Please try again.');
  } finally {
    setBusy(false);
  }
});

async function restoreSession() {
  if (!endpoint) {
    setBusy(false);
    showStatus('The wishlist is waiting for its Google Sheet connection.');
    return;
  }
  try {
    token = sessionStorage.getItem(sessionStorageKey) || '';
  } catch {
    return;
  }
  if (!token) return;
  setBusy(true);
  showOpeningStatus();
  try {
    await openWishlists();
  } catch (error) {
    showLocked(false);
    reportError(error, 'Couldn’t reopen the wishlist. Please enter the passphrase again.');
  } finally {
    setBusy(false);
  }
}

restoreSession();
