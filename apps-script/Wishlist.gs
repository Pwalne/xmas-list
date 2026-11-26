const WISHLIST_HEADERS = ['Gift ID', 'Gift name', 'Shopping link', 'Priority', 'Purchased', 'Price'];
const PRIORITIES = { high: 0, normal: 1, low: 2 };
const SESSION_LIFETIME_MS = 4 * 60 * 60 * 1000;
const ATTEMPT_WINDOW_MS = 2 * 60 * 1000;
const MAX_FAILED_ATTEMPTS = 12;

const WISHLIST_SETTINGS = 'Wishlist settings';
const SETTINGS_HEADERS = ['List ID', 'Child name', 'Spreadsheet URL or ID', 'Gift tab'];

// Run in the editor after setting WISHLIST_SPREADSHEET_ID.
function setupWishlist() {
  const properties = PropertiesService.getScriptProperties();
  if (!properties.getProperty('WISHLIST_PASSPHRASE')) {
    throw new Error('Set WISHLIST_PASSPHRASE to the shared site passphrase.');
  }
  const lists = configuredWishlists_(properties);
  if (!lists.size) throw new Error('Add a list to the Wishlist settings tab.');
  for (const list of lists.values()) {
    if (!wishlistGiftSheet_(list)) throw new Error('Check the gift tab and its headers for list ' + list.id);
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
    if (!passphrase || !secret) {
      return wishlistResponse_({ ok: false, code: 'service_unavailable' });
    }
    const sessionKey = signWishlist_('session-key:' + passphrase, secret);
    if (request.action === 'unlock') {
      if (typeof request.passphrase !== 'string' || !request.passphrase || request.passphrase.length > 256) {
        return wishlistResponse_({ ok: false, code: 'invalid_request' });
      }
      return wishlistResponse_(withWishlistLock_(() => unlockWishlist_(request.passphrase, properties, passphrase, sessionKey)));
    }
    if (request.action !== 'directory' && request.action !== 'list' && request.action !== 'purchase') {
      return wishlistResponse_({ ok: false, code: 'invalid_request' });
    }
    if (!validWishlistToken_(request.token, sessionKey, Date.now())) {
      return wishlistResponse_({ ok: false, code: 'session_expired' });
    }
    if (request.action === 'purchase' && !validWishlistId_(request.giftId)) {
      return wishlistResponse_({ ok: false, code: 'invalid_request' });
    }

    return wishlistResponse_(withWishlistLock_(() => {
      const lists = configuredWishlists_(properties);
      if (request.action === 'directory') {
        return { ok: true, lists: Array.from(lists.values(), ({ id, name }) => ({ id, name })) };
      }
      const list = lists.get(request.listId ?? (lists.size === 1 ? lists.keys().next().value : ''));
      if (!list) return { ok: false, code: 'list_unavailable' };
      const sheet = wishlistGiftSheet_(list);
      if (!sheet) return { ok: false, code: 'list_unavailable' };
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

function unlockWishlist_(submitted, properties, passphrase, sessionKey) {
  const now = Date.now();
  const stored = properties.getProperty('WISHLIST_FAILED_ATTEMPTS');
  const [until, count] = (stored || '0:0').split(':').map(Number);
  if (until > now && count >= MAX_FAILED_ATTEMPTS) {
    return { ok: false, code: 'rate_limited' };
  }

  if (!sameWishlistSignature_(
    signWishlist_('passphrase:' + submitted, sessionKey),
    signWishlist_('passphrase:' + passphrase, sessionKey)
  )) {
    properties.setProperty('WISHLIST_FAILED_ATTEMPTS', until > now
      ? until + ':' + (count + 1)
      : (now + ATTEMPT_WINDOW_MS) + ':1');
    return { ok: false, code: 'incorrect_passphrase' };
  }

  if (stored) properties.deleteProperty('WISHLIST_FAILED_ATTEMPTS');
  const payload = (now + SESSION_LIFETIME_MS) + '.' + Utilities.getUuid();
  return { ok: true, token: payload + '.' + signWishlist_('token:' + payload, sessionKey) };
}

function validWishlistToken_(token, key, now) {
  if (typeof token !== 'string' || !/^\d{13}\.[a-f0-9-]{36}\.[A-Za-z0-9_-]{43}$/.test(token)) return false;
  const [expires, nonce, signature] = token.split('.');
  return Number(expires) > now &&
    sameWishlistSignature_(signature, signWishlist_('token:' + expires + '.' + nonce, key));
}

function configuredWishlists_(properties) {
  const homeId = properties.getProperty('WISHLIST_SPREADSHEET_ID');
  if (!homeId) throw new Error('Set WISHLIST_SPREADSHEET_ID to the private settings spreadsheet ID.');
  const home = SpreadsheetApp.openById(homeId);
  const settings = home.getSheetByName(WISHLIST_SETTINGS);
  const lists = new Map();
  if (!settings) {
    lists.set('family', { id: 'family', name: 'Family', spreadsheetId: homeId, tab: 'Gifts' });
    return lists;
  }

  const headers = settings.getRange(1, 1, 1, SETTINGS_HEADERS.length).getDisplayValues()[0];
  if (!SETTINGS_HEADERS.every((header, index) => header === headers[index])) {
    throw new Error('Unexpected Wishlist settings headers.');
  }
  const count = settings.getLastRow() - 1;
  if (count < 1) return lists;
  const rows = settings.getRange(2, 1, count, SETTINGS_HEADERS.length).getDisplayValues();

  for (const [rawId, rawName, source, tab] of rows) {
    const id = rawId.trim();
    const name = rawName.trim();
    const spreadsheetId = source.trim() ? wishlistSpreadsheetId_(source.trim()) : homeId;
    if (!/^[a-z0-9_-]{1,48}$/.test(id) || !name || name.length > 80 || !spreadsheetId ||
        !tab.trim() ||
        (spreadsheetId === homeId && tab.toLowerCase() === WISHLIST_SETTINGS.toLowerCase())) continue;
    if (lists.has(id)) throw new Error('Duplicate list ID in Wishlist settings.');
    lists.set(id, { id, name, spreadsheetId, tab });
  }
  return lists;
}

function wishlistSpreadsheetId_(source) {
  if (/^[A-Za-z0-9_-]{20,}$/.test(source)) return source;
  return source.match(/^https:\/\/docs\.google\.com\/spreadsheets\/d\/([A-Za-z0-9_-]{20,})(?:[/?#]|$)/)?.[1] || '';
}

function wishlistGiftSheet_(list) {
  try {
    const sheet = SpreadsheetApp.openById(list.spreadsheetId).getSheetByName(list.tab);
    return sheet && sheet.getName() === list.tab && isWishlistSheet_(sheet) ? sheet : null;
  } catch {
    return null;
  }
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
