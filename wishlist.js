'use strict';

const endpoint = document.querySelector('meta[name="wishlist-endpoint"]').content;
const sessionStorageKey = 'family-christmas-wishlist-session';
const unlockPanel = document.querySelector('#unlock-panel');
const unlockForm = document.querySelector('#unlock');
const passphrase = document.querySelector('#passphrase');
const unlockButton = unlockForm.querySelector('button');
const status = document.querySelector('#status');
const giftsPanel = document.querySelector('#gifts-panel');
const giftsHeading = document.querySelector('#gifts-heading');
const refresh = document.querySelector('#refresh');
const lock = document.querySelector('#lock');
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
let busy = false;

const errors = {
  incorrect_passphrase: 'That passphrase didn’t match. Try again.',
  rate_limited: 'There have been too many attempts. Wait two minutes and try again.',
  session_expired: 'Your session expired. Enter the family passphrase again.',
  gift_missing: 'This gift may have changed. Refresh the list and try again.',
  busy: 'The wishlist is busy. Please try again.',
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
  lock.disabled = value;
  available.querySelectorAll('input').forEach(input => { input.disabled = value; });
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
      link.setAttribute('aria-label', 'Shopping link for ' + gift.name);
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
    checkbox.setAttribute('aria-label', 'I bought this: ' + gift.name);
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

function showLocked(shouldFocus = true) {
  storeSession('');
  gifts = [];
  renderGifts();
  giftsPanel.hidden = true;
  unlockPanel.hidden = false;
  passphrase.value = '';
  if (shouldFocus) passphrase.focus();
}

function reportError(error, fallback) {
  if (error.message === 'session_expired') showLocked();
  showStatus(errors[error.message] || fallback, true);
}

async function loadGifts(focusHeading = false) {
  const result = await request('list');
  gifts = result.gifts;
  passphrase.value = '';
  unlockPanel.hidden = true;
  giftsPanel.hidden = false;
  renderGifts();
  if (focusHeading) giftsHeading.focus();
}

async function markPurchased(gift, checkbox) {
  setBusy(true);
  showStatus('Saving purchase…');
  try {
    const result = await request('purchase', { giftId: gift.id });
    gift.purchased = true;
    renderGifts();
    giftsHeading.focus();
    showStatus(result.alreadyPurchased ? 'This gift was already marked purchased.' : 'Purchase saved.');
  } catch (error) {
    reportError(error, 'Couldn’t confirm the purchase. Refresh the list or try again.');
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
    await loadGifts(true);
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
    await loadGifts();
    showStatus('Wishlist updated.');
  } catch (error) {
    reportError(error, 'Couldn’t refresh the wishlist. Please try again.');
  } finally {
    setBusy(false);
  }
});

lock.addEventListener('click', () => {
  showLocked();
  showStatus('');
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
    await loadGifts();
    showStatus('');
  } catch (error) {
    showLocked(false);
    reportError(error, 'Couldn’t reopen the wishlist. Please enter the passphrase again.');
  } finally {
    setBusy(false);
  }
}

restoreSession();
