const WISHLIST_HEADERS = ['Gift ID', 'Gift name', 'Shopping link', 'Priority', 'Purchased', 'Price'];
const PRIORITIES = { high: 0, normal: 1, low: 2 };
const SESSION_LIFETIME_MS = 4 * 60 * 60 * 1000;
const ATTEMPT_WINDOW_MS = 2 * 60 * 1000;
const MAX_FAILED_ATTEMPTS = 12;

// Run in the editor after setting WISHLIST_SPREADSHEET_ID.
function setupWishlist() {
  const properties = PropertiesService.getScriptProperties();
  if (!wishlistSpreadsheet_(properties).getSheets().some(isWishlistSheet_)) {
    throw new Error('At least one tab needs the headers shown in the repository README.');
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
    const secret = properties.getProperty('WISHLIST_SIGNING_KEY');
    if (!secret) {
      return wishlistResponse_({ ok: false, code: 'service_unavailable' });
    }
    if (request.action === 'unlock') {
      if (typeof request.passphrase !== 'string' || !request.passphrase || request.passphrase.length > 256) {
        return wishlistResponse_({ ok: false, code: 'invalid_request' });
      }
      return wishlistResponse_(withWishlistLock_(() => unlockWishlist_(request.passphrase, properties, secret)));
    }
    if (request.action !== 'list' && request.action !== 'purchase') {
      return wishlistResponse_({ ok: false, code: 'invalid_request' });
    }
    if (request.action === 'purchase' && !validWishlistId_(request.giftId)) {
      return wishlistResponse_({ ok: false, code: 'invalid_request' });
    }

    return wishlistResponse_(withWishlistLock_(() => {
      const sheet = wishlistSessionSheet_(request.token, properties, secret, Date.now());
      if (!sheet) return { ok: false, code: 'session_expired' };
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

function unlockWishlist_(passphrase, properties, secret) {
  const now = Date.now();
  const stored = properties.getProperty('WISHLIST_FAILED_ATTEMPTS');
  const [until, count] = (stored || '0:0').split(':').map(Number);
  if (until > now && count >= MAX_FAILED_ATTEMPTS) {
    return { ok: false, code: 'rate_limited' };
  }
  const spreadsheet = wishlistSpreadsheet_(properties);
  let sheet = spreadsheet.getSheetByName(passphrase);
  const legacyPassphrase = properties.getProperty('WISHLIST_PASSPHRASE');
  // Keep the original passphrase working while the original tab is being migrated.
  if (sheet && (sheet.getName() !== passphrase || (legacyPassphrase && passphrase === 'Gifts'))) {
    sheet = null;
  }
  if (!sheet && legacyPassphrase && passphrase === legacyPassphrase) {
    sheet = spreadsheet.getSheetByName('Gifts');
  }
  if (!sheet || !isWishlistSheet_(sheet)) {
    properties.setProperty('WISHLIST_FAILED_ATTEMPTS', until > now
      ? until + ':' + (count + 1)
      : (now + ATTEMPT_WINDOW_MS) + ':1');
    return { ok: false, code: 'incorrect_passphrase' };
  }
  if (stored) properties.deleteProperty('WISHLIST_FAILED_ATTEMPTS');
  const payload = (now + SESSION_LIFETIME_MS) + '.' + sheet.getSheetId() + '.' + Utilities.getUuid();
  return { ok: true, token: payload + '.' + signWishlistSession_(payload, sheet, secret) };
}

function wishlistSessionSheet_(token, properties, secret, now) {
  if (typeof token !== 'string' || !/^\d{13}\.\d{1,10}\.[a-f0-9-]{36}\.[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const [expires, sheetId, nonce, signature] = token.split('.');
  if (Number(expires) <= now) return null;
  const sheet = wishlistSpreadsheet_(properties).getSheetById(Number(sheetId));
  if (!sheet) return null;
  const payload = expires + '.' + sheetId + '.' + nonce;
  return sameWishlistSignature_(signature, signWishlistSession_(payload, sheet, secret)) &&
    isWishlistSheet_(sheet) ? sheet : null;
}

function signWishlistSession_(payload, sheet, secret) {
  return signWishlist_(JSON.stringify(['wishlist-session', payload, sheet.getName()]), secret);
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

function wishlistSpreadsheet_(properties) {
  const id = properties.getProperty('WISHLIST_SPREADSHEET_ID');
  if (!id) throw new Error('Set WISHLIST_SPREADSHEET_ID to the private wishlist Sheet ID.');
  return SpreadsheetApp.openById(id);
}

function isWishlistSheet_(sheet) {
  if (sheet.getMaxColumns() < WISHLIST_HEADERS.length) return false;
  const headers = sheet.getRange(1, 1, 1, WISHLIST_HEADERS.length).getValues()[0];
  return WISHLIST_HEADERS.every((header, index) => header === headers[index]);
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
  rows.forEach(([id, value, link, priority, purchased, price], index) => {
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
      price: Number.isFinite(price) && price >= 0 ? price : null,
      priority: typeof rank === 'number' ? rank : PRIORITIES.normal,
      order: index,
    });
  });
  if (idsAssigned) SpreadsheetApp.flush();
  gifts.sort((left, right) =>
    Number(left.purchased) - Number(right.purchased) ||
    (left.purchased ? 0 : left.priority - right.priority) ||
    left.order - right.order);
  return gifts.map(({ id, name, url, purchased, price }) => ({ id, name, url, purchased, price }));
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
