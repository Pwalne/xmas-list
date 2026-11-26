const WISHLIST_HEADERS = ['Gift ID', 'Gift name', 'Shopping link', 'Priority', 'Purchased'];
const PRIORITIES = { high: 0, normal: 1, low: 2 };
const SESSION_LIFETIME_MS = 4 * 60 * 60 * 1000;
const ATTEMPT_WINDOW_MS = 2 * 60 * 1000;
const MAX_FAILED_ATTEMPTS = 12;

// Run once in the editor after setting the two WISHLIST_* configuration properties.
function setupWishlist() {
  const properties = PropertiesService.getScriptProperties();
  const sheet = wishlistSheet_(properties);
  const headers = sheet.getRange(1, 1, 1, WISHLIST_HEADERS.length).getValues()[0];
  if (headers.some((header, index) => header !== WISHLIST_HEADERS[index])) {
    throw new Error('The Gifts tab needs the headers shown in the repository README.');
  }
  if ((properties.getProperty('WISHLIST_PASSPHRASE') || '').length < 20) {
    throw new Error('Set WISHLIST_PASSPHRASE to a strong passphrase of at least 20 characters.');
  }
  if (!properties.getProperty('WISHLIST_SIGNING_KEY')) {
    properties.setProperty('WISHLIST_SIGNING_KEY', Utilities.getUuid() + Utilities.getUuid());
  }
}

function doGet() {
  return wishlistResponse_({ ok: false, code: 'post_required' });
}

function doPost(event) {
  const body = event && event.postData && event.postData.contents;
  if (typeof body !== 'string' || !body || body.length > 2048) {
    return wishlistResponse_({ ok: false, code: 'invalid_request' });
  }

  let request;
  try {
    request = JSON.parse(body);
  } catch {
    return wishlistResponse_({ ok: false, code: 'invalid_request' });
  }
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    return wishlistResponse_({ ok: false, code: 'invalid_request' });
  }

  try {
    const properties = PropertiesService.getScriptProperties();
    const passphrase = properties.getProperty('WISHLIST_PASSPHRASE');
    const secret = properties.getProperty('WISHLIST_SIGNING_KEY');
    if (!passphrase || passphrase.length < 20 || !secret) {
      return wishlistResponse_({ ok: false, code: 'service_unavailable' });
    }
    if (request.action === 'unlock') {
      if (typeof request.passphrase !== 'string' || request.passphrase.length > 256) {
        return wishlistResponse_({ ok: false, code: 'invalid_request' });
      }
      return wishlistResponse_(withWishlistLock_(() => unlockWishlist_(request, properties, passphrase, secret)));
    }
    if (request.action !== 'list' && request.action !== 'purchase') {
      return wishlistResponse_({ ok: false, code: 'invalid_request' });
    }
    const sessionKey = signWishlist_('session-key:' + passphrase, secret);
    if (!validWishlistToken_(request.token, sessionKey, Date.now())) {
      return wishlistResponse_({ ok: false, code: 'session_expired' });
    }
    if (request.action === 'purchase' && !validWishlistId_(request.giftId)) {
      return wishlistResponse_({ ok: false, code: 'invalid_request' });
    }

    return wishlistResponse_(withWishlistLock_(() => {
      const sheet = wishlistSheet_(properties);
      if (request.action === 'purchase') return purchaseWishlistGift_(sheet, request.giftId);
      return { ok: true, gifts: listWishlistGifts_(sheet) };
    }));
  } catch (error) {
    console.error('Wishlist operation failed: ' + error.name);
    return wishlistResponse_({ ok: false, code: 'service_unavailable' });
  }
}

function withWishlistLock_(callback) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return { ok: false, code: 'busy' };
  try {
    return callback();
  } finally {
    lock.releaseLock();
  }
}

function unlockWishlist_(request, properties, passphrase, secret) {
  const now = Date.now();
  const stored = properties.getProperty('WISHLIST_FAILED_ATTEMPTS');
  const [until, count] = (stored || '0:0').split(':').map(Number);
  if (until > now && count >= MAX_FAILED_ATTEMPTS) {
    return { ok: false, code: 'rate_limited' };
  }
  if (!sameWishlistSignature_(signWishlist_(request.passphrase, secret), signWishlist_(passphrase, secret))) {
    properties.setProperty('WISHLIST_FAILED_ATTEMPTS', until > now
      ? until + ':' + (count + 1)
      : (now + ATTEMPT_WINDOW_MS) + ':1');
    return { ok: false, code: 'incorrect_passphrase' };
  }
  if (stored) properties.deleteProperty('WISHLIST_FAILED_ATTEMPTS');
  const sessionKey = signWishlist_('session-key:' + passphrase, secret);
  const payload = (now + SESSION_LIFETIME_MS) + '.' + Utilities.getUuid();
  return { ok: true, token: payload + '.' + signWishlist_('token:' + payload, sessionKey) };
}

function validWishlistToken_(token, key, now) {
  if (typeof token !== 'string' || !/^\d{13}\.[a-f0-9-]{36}\.[A-Za-z0-9_-]{43}$/.test(token)) return false;
  const [expires, nonce, signature] = token.split('.');
  return Number(expires) > now &&
    sameWishlistSignature_(signature, signWishlist_('token:' + expires + '.' + nonce, key));
}

function signWishlist_(value, key) {
  return Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(value, key))
    .replace(/=+$/, '');
}

function sameWishlistSignature_(left, right) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index++) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

function wishlistSheet_(properties) {
  const id = properties.getProperty('WISHLIST_SPREADSHEET_ID');
  if (!id) throw new Error('Set WISHLIST_SPREADSHEET_ID to the private wishlist Sheet ID.');
  const sheet = SpreadsheetApp.openById(id).getSheetByName('Gifts');
  if (!sheet) throw new Error('The wishlist spreadsheet needs a Gifts tab.');
  return sheet;
}

function validWishlistId_(id) {
  return typeof id === 'string' && /^[a-z0-9_-]{1,80}$/i.test(id);
}

function listWishlistGifts_(sheet) {
  const count = sheet.getLastRow() - 1;
  if (count < 1) return [];
  const rows = sheet.getRange(2, 1, count, WISHLIST_HEADERS.length).getValues();
  const gifts = [];
  const existingIds = new Set(rows.map(row => row[0]).filter(validWishlistId_));
  const seenIds = new Set();
  let idsAssigned = false;
  rows.forEach(([id, value, link, priority, purchased], index) => {
    const name = String(value).trim();
    if (!name) return;
    if (!validWishlistId_(id) || seenIds.has(id)) {
      do { id = Utilities.getUuid(); } while (existingIds.has(id));
      existingIds.add(id);
      sheet.getRange(index + 2, 1).setValue(id);
      idsAssigned = true;
    }
    seenIds.add(id);
    const rank = PRIORITIES[String(priority).trim().toLowerCase()];
    gifts.push({
      id,
      name,
      url: /^https?:\/\/[^\s]+$/i.test(String(link).trim()) ? String(link).trim() : '',
      purchased: purchased === true,
      priority: typeof rank === 'number' ? rank : PRIORITIES.normal,
      order: index,
    });
  });
  if (idsAssigned) SpreadsheetApp.flush();
  gifts.sort((left, right) =>
    Number(left.purchased) - Number(right.purchased) ||
    (left.purchased ? 0 : left.priority - right.priority) ||
    left.order - right.order);
  return gifts.map(({ id, name, url, purchased }) => ({ id, name, url, purchased }));
}

function purchaseWishlistGift_(sheet, id) {
  const count = sheet.getLastRow() - 1;
  if (count < 1) return { ok: false, code: 'gift_missing' };
  const matches = sheet.getRange(2, 1, count, 1).createTextFinder(id)
    .matchEntireCell(true).matchCase(true).findAll();
  if (matches.length !== 1) return { ok: false, code: 'gift_missing' };
  const row = matches[0].getRow();
  const [currentId, name, , , purchased] = sheet.getRange(row, 1, 1, WISHLIST_HEADERS.length).getValues()[0];
  if (currentId !== id || !String(name).trim()) return { ok: false, code: 'gift_missing' };
  if (purchased !== true) {
    sheet.getRange(row, 5).setValue(true);
    SpreadsheetApp.flush();
  }
  return { ok: true, alreadyPurchased: purchased === true };
}

function wishlistResponse_(result) {
  return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(ContentService.MimeType.JSON);
}
