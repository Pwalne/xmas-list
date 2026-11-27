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
const manageListControls = document.querySelector('#manage-list-controls');
const managedWishlists = document.querySelector('#managed-wishlists');
const wishlistFormHeading = document.querySelector('#wishlist-form-heading');
const saveWishlist = document.querySelector('#save-wishlist');
const cancelWishlistEdit = document.querySelector('#cancel-wishlist-edit');
const removeDialog = document.querySelector('#remove-wishlist-dialog');
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
let removingList = null;
let lists = [];
let selectedList = null;

const errors = {
  incorrect_passphrase: 'That passphrase didn’t match. Try again.',
  rate_limited: 'There have been too many attempts. Wait two minutes and try again.',
  session_expired: 'Your session expired. Enter the family passphrase again.',
  gift_missing: 'This gift may have changed. Refresh the list and try again.',
  busy: 'The wishlist is busy. Please try again.',
  list_unavailable: 'This list’s Google Sheet is unavailable. Ask the list organizer to check its sharing and setup.',
  admin_unavailable: 'Wishlist administration hasn’t been configured.',
  admin_session_expired: 'Admin access expired. Enter the admin passphrase again.',
  invalid_list_settings: 'Enter a child name, a valid Google Sheet link or ID if needed, and the exact gift tab name.',
  list_already_added: 'That gift tab is already connected.',
  list_changed: 'This wishlist changed since you opened settings. Close and reopen settings, then try again.',
};

function showStatus(message, isError = false) {
  status.textContent = message;
  status.classList.toggle('error', isError);
}

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
  adminPanel.querySelectorAll('button').forEach(button => { button.disabled = value; });
  confirmRemoval.disabled = value;
  wishlistTabs.querySelectorAll('button').forEach(button => { button.disabled = value; });
  available.querySelectorAll('input').forEach(input => { input.disabled = value; });
}

function selectWishlist(id) {
  selectedList = lists.find(list => list.id === id) || null;
  giftsHeading.textContent = selectedList ? selectedList.name + '’s gift ideas' : 'Gift ideas';
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
      showStatus('Opening wishlist…');
      try {
        await loadGifts(true);
        showStatus('');
      } catch (error) {
        reportError(error, 'Couldn’t open this wishlist. Use Refresh to try again.');
      } finally {
        setBusy(false);
      }
    });
    wishlistTabs.append(button);
  }
  wishlistTabs.hidden = !lists.length;
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
  if (url.hostname !== 'www.target.com' && url.hostname !== 'target.com') return '';
  const product = url.pathname.match(/^\/p\/.*\/A-(\d+)\/?$/i);
  return product ? targetProductPhotos.get(product[1]) || '' : '';
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
      const photoUrl = productPhoto(url);
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
    checkbox.disabled = busy;
    checkbox.addEventListener('change', () => {
      checkbox.checked = false;
      if (!busy) markPurchased(gift, checkbox);
    });
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

function closeAdmin() {
  adminToken = '';
  adminPanel.hidden = true;
  adminForm.hidden = false;
  adminForm.reset();
  addListForm.hidden = true;
  resetWishlistForm();
  manageListControls.hidden = true;
  managedWishlists.replaceChildren();
  adminStatus.textContent = '';
  manage.setAttribute('aria-expanded', 'false');
}

manage.addEventListener('click', () => {
  if (!adminPanel.hidden) {
    closeAdmin();
    return;
  }
  adminPanel.hidden = false;
  manage.setAttribute('aria-expanded', 'true');
  adminPassphrase.focus();
});

function reportAdminError(error, fallback) {
  if (error.message === 'session_expired') {
    reportError(error, fallback);
    return;
  }
  if (error.message === 'admin_session_expired') {
    adminToken = '';
    addListForm.hidden = true;
    manageListControls.hidden = true;
    resetWishlistForm();
    adminForm.hidden = false;
    adminPassphrase.focus();
  }
  adminStatus.textContent = errors[error.message] || fallback;
}

adminForm.addEventListener('submit', async event => {
  event.preventDefault();
  if (busy) return;
  setBusy(true);
  adminStatus.textContent = 'Unlocking settings…';
  try {
    const result = await request('admin_unlock', { passphrase: adminPassphrase.value });
    adminToken = result.token;
    await refreshManagedWishlists();
    adminForm.hidden = true;
    addListForm.hidden = false;
    addListForm.elements.name.focus();
    adminStatus.textContent = '';
  } catch (error) {
    reportAdminError(error, 'Couldn’t unlock settings. Try again.');
  } finally {
    adminForm.reset();
    setBusy(false);
  }
});

function resetWishlistForm() {
  editingList = null;
  addListForm.reset();
  wishlistFormHeading.textContent = 'Add a wishlist';
  saveWishlist.textContent = 'Add wishlist';
  cancelWishlistEdit.hidden = true;
}

cancelWishlistEdit.addEventListener('click', () => {
  resetWishlistForm();
  addListForm.elements.name.focus();
});

async function refreshManagedWishlists() {
  const { lists: connectedLists } = await request('admin_lists', { adminToken });
  managedWishlists.replaceChildren();
  for (const list of connectedLists) {
    const row = document.createElement('li');
    row.className = 'gift-row';
    const name = document.createElement('strong');
    name.textContent = list.name;
    const actions = document.createElement('div');
    actions.className = 'actions';
    for (const label of ['Edit', 'Remove']) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'secondary';
      button.textContent = label;
      button.setAttribute('aria-label', label + ' ' + list.name);
      button.addEventListener('click', () => {
        if (busy || !adminToken) return;
        if (label === 'Edit') {
          editingList = list;
          addListForm.elements.name.value = list.name;
          addListForm.elements.source.value = list.source;
          addListForm.elements.tab.value = list.tab;
          wishlistFormHeading.textContent = 'Edit wishlist';
          saveWishlist.textContent = 'Save changes';
          cancelWishlistEdit.hidden = false;
          adminStatus.textContent = '';
          addListForm.elements.name.focus();
        } else {
          removingList = list;
          removeMessage.textContent = 'Remove ' + list.name + ' from the website? Its Google Sheet and gifts will be kept.';
          removeDialog.showModal();
        }
      });
      actions.append(button);
    }
    row.append(name, actions);
    managedWishlists.append(row);
  }
  manageListControls.hidden = !connectedLists.length;
}

async function refreshAfterManage(message) {
  adminStatus.textContent = message;
  try {
    await openWishlists();
    await refreshManagedWishlists();
  } catch (error) {
    reportAdminError(error, message + ' Reload to refresh the displayed lists.');
  }
}

cancelRemoval.addEventListener('click', () => removeDialog.close());
removeDialog.addEventListener('close', () => { removingList = null; });
confirmRemoval.addEventListener('click', async () => {
  const list = removingList;
  if (busy || !adminToken || !list) return;
  removeDialog.close();
  setBusy(true);
  try {
    await request('admin_remove_list', { listId: list.id, previous: JSON.stringify(list), adminToken });
    if (editingList?.id === list.id) resetWishlistForm();
    await refreshAfterManage('Removed ' + list.name + ' from the wishlist tabs.');
  } catch (error) {
    reportAdminError(error, 'Couldn’t remove the wishlist. Try again.');
  } finally {
    setBusy(false);
  }
});

addListForm.addEventListener('submit', async event => {
  event.preventDefault();
  if (busy || !adminToken) return;
  setBusy(true);
  adminStatus.textContent = 'Checking and connecting the Sheet…';
  try {
    const previous = editingList;
    const { list } = await request(previous ? 'admin_edit_list' : 'admin_add_list', {
      ...Object.fromEntries(new FormData(addListForm)), adminToken,
      listId: previous?.id, previous: previous ? JSON.stringify(previous) : undefined,
    });
    resetWishlistForm();
    await refreshAfterManage(previous ? 'Saved changes to ' + list.name + '.' : 'Added ' + list.name + ' to the wishlist tabs.');
  } catch (error) {
    const fallback = error.message === 'list_unavailable'
      ? 'Check the tab name, gift column headers, and Google Sheet sharing.'
      : 'Couldn’t save the wishlist. Try again.';
    if (error.message === 'list_unavailable') adminStatus.textContent = fallback;
    else reportAdminError(error, fallback);
  } finally {
    setBusy(false);
  }
});

function reportError(error, fallback) {
  if (error.message === 'session_expired') showLocked();
  showStatus(errors[error.message] || fallback, true);
}

async function loadGifts(focusHeading = false) {
  const result = await request('list', { listId: selectedList?.id });
  gifts = result.gifts;
  listRevision = result.listRevision;
  passphrase.value = '';
  unlockPanel.hidden = true;
  giftsPanel.hidden = false;
  renderGifts();
  if (focusHeading) giftsHeading.focus();
}

async function openWishlists(focusHeading = false) {
  let previousSelection;
  try {
    previousSelection = sessionStorage.getItem(selectionStorageKey);
  } catch {
    // Continue without a saved selection.
  }

  try {
    const directory = await request('directory');
    lists = directory.lists;
  } catch (error) {
    // Older deployments support the original single-list form.
    if (error.message !== 'invalid_request') throw error;
    lists = [];
    renderWishlistTabs();
    selectWishlist(null);
    return loadGifts(focusHeading);
  }

  const next = lists.find(list => list.id === (selectedList?.id || previousSelection)) || lists[0];
  if (next?.id !== selectedList?.id) clearGifts();
  renderWishlistTabs();
  selectWishlist(next?.id);
  passphrase.value = '';
  unlockPanel.hidden = true;
  giftsPanel.hidden = false;
  if (next) return loadGifts(focusHeading);

  clearGifts();
  empty.textContent = 'No wishlists have been configured yet.';
  empty.hidden = false;
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
  showStatus('Opening wishlist…');
  try {
    const result = await request('unlock', { passphrase: passphrase.value });
    storeSession(result.token);
    await openWishlists(true);
    showStatus('');
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
  showStatus('Opening wishlist…');
  try {
    await openWishlists();
    showStatus('');
  } catch (error) {
    showLocked(false);
    reportError(error, 'Couldn’t reopen the wishlist. Please enter the passphrase again.');
  } finally {
    setBusy(false);
  }
}

restoreSession();
