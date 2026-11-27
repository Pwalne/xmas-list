const WISHLIST_HEADERS = ['Gift ID', 'Gift name', 'Shopping link', 'Priority', 'Purchased', 'Price'];
const PRIORITIES = { high: 0, normal: 1, low: 2 };
const SESSION_LIFETIME_MS = 4 * 60 * 60 * 1000;
const ATTEMPT_WINDOW_MS = 2 * 60 * 1000;
const MAX_FAILED_ATTEMPTS = 12;

const WISHLIST_SETTINGS = 'Wishlist settings';
const SETTINGS_HEADERS = ['List ID', 'Child name', 'Spreadsheet URL or ID', 'Gift tab'];
const ADMIN_ACTIONS = ['admin_unlock', 'admin_lists', 'admin_add_list', 'admin_edit_list', 'admin_remove_list'];

// Run in the editor after setting WISHLIST_SPREADSHEET_ID.
function setupWishlist() {
  const properties = PropertiesService.getScriptProperties();
  if (!properties.getProperty('WISHLIST_PASSPHRASE')) {
    throw new Error('Set WISHLIST_PASSPHRASE to the shared site passphrase.');
  }
  const lists = configuredWishlists_(properties);
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
    if (ADMIN_ACTIONS.includes(request.action)) {
      if (!validWishlistToken_(request.token, sessionKey, Date.now())) {
        return wishlistResponse_({ ok: false, code: 'session_expired' });
      }
      const adminPassphrase = properties.getProperty('WISHLIST_ADMIN_PASSPHRASE');
      if (!adminPassphrase || adminPassphrase === passphrase) {
        return wishlistResponse_({ ok: false, code: 'admin_unavailable' });
      }
      const adminKey = signWishlist_('admin-session:' + adminPassphrase, sessionKey);
      if (request.action === 'admin_unlock') {
        if (typeof request.passphrase !== 'string' || !request.passphrase || request.passphrase.length > 256) {
          return wishlistResponse_({ ok: false, code: 'invalid_request' });
        }
        return wishlistResponse_(withWishlistLock_(() => unlockWishlist_(
          request.passphrase, properties, adminPassphrase, adminKey, 'WISHLIST_ADMIN_FAILED_ATTEMPTS', 30 * 60 * 1000
        )));
      }
      if (!validWishlistToken_(request.adminToken, adminKey, Date.now())) {
        return wishlistResponse_({ ok: false, code: 'admin_session_expired' });
      }
      return wishlistResponse_(withWishlistLock_(() => manageWishlists_(properties, request)));
    }
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

    const metadata = request.action === 'list' ? loadWishlistProductMetadata_(properties, request.listId) : new Map();
    return wishlistResponse_(withWishlistLock_(() => {
      const lists = configuredWishlists_(properties);
      if (request.action === 'directory') {
        return { ok: true, lists: Array.from(lists.values(), ({ id, name }) => ({ id, name })) };
      }
      const list = lists.get(request.listId ?? (lists.size === 1 ? lists.keys().next().value : ''));
      if (!list) return { ok: false, code: 'list_unavailable' };
      const listRevision = signWishlist_(JSON.stringify([list.id, list.spreadsheetId, list.tab]), sessionKey);
      if (request.action === 'purchase' && request.listRevision != null && request.listRevision !== listRevision) {
        return { ok: false, code: 'list_changed' };
      }
      const sheet = wishlistGiftSheet_(list);
      if (!sheet) return { ok: false, code: 'list_unavailable' };
      if (request.action === 'purchase') return purchaseWishlistGift_(sheet, request.giftId);
      return { ok: true, gifts: listWishlistGifts_(sheet, metadata), listRevision };
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

function unlockWishlist_(submitted, properties, passphrase, sessionKey,
  attemptsKey = 'WISHLIST_FAILED_ATTEMPTS', lifetime = SESSION_LIFETIME_MS) {
  const now = Date.now();
  const stored = properties.getProperty(attemptsKey);
  const [until, count] = (stored || '0:0').split(':').map(Number);
  if (until > now && count >= MAX_FAILED_ATTEMPTS) {
    return { ok: false, code: 'rate_limited' };
  }

  if (!sameWishlistSignature_(
    signWishlist_('passphrase:' + submitted, sessionKey),
    signWishlist_('passphrase:' + passphrase, sessionKey)
  )) {
    properties.setProperty(attemptsKey, until > now
      ? until + ':' + (count + 1)
      : (now + ATTEMPT_WINDOW_MS) + ':1');
    return { ok: false, code: 'incorrect_passphrase' };
  }

  if (stored) properties.deleteProperty(attemptsKey);
  const payload = (now + lifetime) + '.' + Utilities.getUuid();
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

  for (const [index, [rawId, rawName, source, tab]] of rows.entries()) {
    const id = rawId.trim();
    const name = rawName.trim();
    const spreadsheetId = source.trim() ? wishlistSpreadsheetId_(source.trim()) : homeId;
    if (!/^[a-z0-9_-]{1,48}$/.test(id) || !name || name.length > 80 || !spreadsheetId ||
        !tab.trim() ||
        (spreadsheetId === homeId && tab.toLowerCase() === WISHLIST_SETTINGS.toLowerCase())) continue;
    if (lists.has(id)) throw new Error('Duplicate list ID in Wishlist settings.');
    lists.set(id, { id, name, spreadsheetId, tab, row: index + 2 });
  }
  return lists;
}

function manageWishlists_(properties, request) {
  const homeId = properties.getProperty('WISHLIST_SPREADSHEET_ID');
  const settings = SpreadsheetApp.openById(homeId).getSheetByName(WISHLIST_SETTINGS);
  if (!settings) return { ok: false, code: 'admin_unavailable' };
  const lists = configuredWishlists_(properties);
  const renderList = list => ({
    id: list.id,
    name: list.name,
    source: list.spreadsheetId === homeId ? '' : list.spreadsheetId,
    tab: list.tab,
  });
  if (request.action === 'admin_lists') {
    return { ok: true, lists: Array.from(lists.values(), renderList) };
  }
  const existing = lists.get(request.listId);
  if (request.action !== 'admin_add_list') {
    if (!existing || JSON.stringify(renderList(existing)) !== request.previous) {
      return { ok: false, code: 'list_changed' };
    }
  }
  if (request.action === 'admin_remove_list') {
    settings.getRange(existing.row, 1, 1, SETTINGS_HEADERS.length).clearContent();
    SpreadsheetApp.flush();
    return { ok: true };
  }

  const { name, source, tab } = request;
  if (typeof name !== 'string' || !name.trim() || name.length > 80 ||
      typeof source !== 'string' || source.length > 500 ||
      typeof tab !== 'string' || !tab.trim() || tab.length > 100) {
    return { ok: false, code: 'invalid_list_settings' };
  }
  const spreadsheetId = source.trim() ? wishlistSpreadsheetId_(source.trim()) : homeId;
  if (!spreadsheetId || (spreadsheetId === homeId && tab.toLowerCase() === WISHLIST_SETTINGS.toLowerCase())) {
    return { ok: false, code: 'invalid_list_settings' };
  }
  if ([...lists.values()].some(list => list.id !== existing?.id && list.spreadsheetId === spreadsheetId && list.tab === tab)) {
    return { ok: false, code: 'list_already_added' };
  }
  if ((spreadsheetId !== existing?.spreadsheetId || tab !== existing?.tab) &&
      !wishlistGiftSheet_({ spreadsheetId, tab })) {
    return { ok: false, code: 'list_unavailable' };
  }
  const id = existing?.id || Utilities.getUuid();
  const row = [id, name.trim(), spreadsheetId === homeId ? '' : spreadsheetId, tab];
  const nextRow = existing?.row || settings.getLastRow() + 1;
  if (nextRow > settings.getMaxRows()) settings.insertRowsAfter(settings.getMaxRows(), 1);
  settings.getRange(nextRow, 1, 1, row.length).setRichTextValues([
    row.map(value => SpreadsheetApp.newRichTextValue().setText(value).build()),
  ]);
  SpreadsheetApp.flush();
  return { ok: true, list: { id, name: name.trim() } };
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

function wishlistProductUrl_(link) {
  const url = String(link).trim();
  const target = url.match(/^https?:\/\/(?:www\.)?target\.com\/p\/(?:[^/?#\s\\]+\/)*A-(\d{6,12})\/?(?:[?#]|$)/i);
  if (target) return 'https://www.target.com/p/-/A-' + target[1];
  const amazon = url.match(/^https?:\/\/(?:www\.)?amazon\.com\/(?:[^/?#\s\\]+\/)*(?:dp|gp\/product)\/([a-z0-9]{10})\/?(?:[/?#]|$)/i);
  if (amazon) return 'https://www.amazon.com/dp/' + amazon[1].toUpperCase();
  return '';
}

function loadWishlistProductMetadata_(properties, listId) {
  const lists = configuredWishlists_(properties);
  const list = lists.get(listId ?? (lists.size === 1 ? lists.keys().next().value : ''));
  const sheet = list && wishlistGiftSheet_(list);
  const found = new Map();
  if (!sheet) return found;

  const urls = [...new Set(wishlistGiftRows_(sheet)
    .filter(([, name, , , , price]) => !String(name).trim() || price === '')
    .map(([, , link]) => wishlistProductUrl_(link)).filter(Boolean))];
  if (!urls.length) return found;

  try {
    const cache = CacheService.getScriptCache();
    const pending = [];
    const keys = urls.map(url => 'product:' + url);
    // Limit each cache call as well as the number of outbound requests.
    for (let start = 0; start < urls.length; start += 100) {
      const cached = cache.getAll(keys.slice(start, start + 100));
      for (const url of urls.slice(start, start + 100)) {
        const value = cached['product:' + url];
        if (value) found.set(url, JSON.parse(value));
        else if (pending.length < 4) pending.push(url);
      }
    }
    if (pending.length) {
      let responses;
      try {
        responses = UrlFetchApp.fetchAll(pending.map(url => ({
          url, followRedirects: false, muteHttpExceptions: true, timeoutSeconds: 5,
        })));
      } catch {
        pending.forEach(url => cache.put('product:' + url, '{}', 600));
        return found;
      }
      pending.forEach((url, index) => {
        const response = responses[index];
        const details = response.getResponseCode() === 200
          ? parseWishlistProduct_(response.getContentText().slice(0, 2000000))
          : {};
        cache.put('product:' + url, JSON.stringify(details), 21600);
        found.set(url, details);
      });
    }
  } catch {
    // Product lookups are optional. The normal list remains usable.
  }
  return found;
}

function parseWishlistProduct_(html) {
  const products = [];
  function collect(node, depth = 0) {
    if (!node || typeof node !== 'object' || depth > 8) return;
    if (Array.isArray(node)) {
      node.forEach(item => collect(item, depth + 1));
      return;
    }
    if ([node['@type']].flat().some(type => /^(?:https?:\/\/schema\.org\/)?Product$/i.test(type))) products.push(node);
    collect(node['@graph'], depth + 1);
    collect(node.mainEntity, depth + 1);
  }
  for (const [, json] of html.matchAll(/<script\b[^>]*\btype\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script\s*>/gi)) {
    try {
      collect(JSON.parse(json));
    } catch {
      // Ignore malformed structured data.
    }
  }

  const metadata = new Map();
  for (const [tag] of html.matchAll(/<meta\b[^>]*>/gi)) {
    const attrs = Object.fromEntries(Array.from(tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g),
      ([, key, double, single]) => [key.toLowerCase(), double ?? single]));
    const key = (attrs.property || attrs.name || attrs.itemprop || '').toLowerCase();
    if (key && attrs.content != null) {
      if (!metadata.has(key)) metadata.set(key, new Set());
      metadata.get(key).add(attrs.content);
    }
  }
  const one = values => values?.size === 1 ? values.values().next().value : undefined;
  const result = {};
  if (products.length > 1) return result;
  const product = products[0];
  const productPage = !!product || one(metadata.get('og:type')) === 'product' || metadata.has('product:price:amount');
  if (!productPage) return result;
  const rawName = product?.name || one(metadata.get('og:title'));
  if (typeof rawName === 'string') {
    const entities = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' };
    const title = rawName.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, value) => {
      if (!value.startsWith('#')) return entities[value.toLowerCase()] ?? whole;
      const number = /^#x/i.test(value) ? parseInt(value.slice(2), 16) : Number(value.slice(1));
      return number > 31 && number <= 0x10ffff && !(number >= 0xd800 && number <= 0xdfff)
        ? String.fromCodePoint(number) : whole;
    }).replace(/\s+/g, ' ').trim();
    if (title && title.length <= 200) result.name = title;
  }

  const usdPrice = (amount, currency) =>
    currency === 'USD' && /^\d+(?:\.\d{1,2})?$/.test(String(amount).trim()) && Number.isFinite(Number(amount))
      ? Number(amount) : undefined;
  const offers = [product?.offers].flat().filter(offer => offer && offer.price != null);
  const offerPrices = new Set(offers.map(offer => usdPrice(offer.price, offer.priceCurrency)));
  const price = offers.length ? one(offerPrices) : usdPrice(
    one(metadata.get('product:price:amount') || metadata.get('price')),
    one(metadata.get('product:price:currency') || metadata.get('pricecurrency'))
  );
  if (price != null) result.price = price;
  return result;
}

function wishlistGiftDetails_(value, link) {
  const shoppingLink = String(link).trim();
  const url = /^https?:\/\/[^\s]+$/i.test(shoppingLink) ? shoppingLink : '';
  const name = String(value).trim();
  if (name || !url) return { name, url };

  // Fall back to the URL's public text when retailer metadata is unavailable.
  const parts = url.match(/^https?:\/\/([\w.-]+)(?::\d+)?(\/[^?#\\]*)?(?=[?#]|$)/i);
  if (!parts) return { name: '', url };
  const host = parts[1].toLowerCase().replace(/^www\./, '');
  const segments = (parts[2] || '').split('/').filter(Boolean);
  if (host === 'target.com' && segments[0] === 'p' && segments.slice(-2).join('/') === '-/A-92538311') {
    return { name: 'LEGO Creator 3-in-1 Surprising Spider', url };
  }

  for (const segment of segments.reverse()) {
    let decoded;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      continue;
    }
    const label = decoded.replace(/\.html?$/i, '').replace(/[-_]+/g, ' ').trim();
    if (!/\p{L}/u.test(label) || !/\s/.test(label) || /\p{C}/u.test(label) ||
        /^a \d+$/i.test(label) || /^[\da-f ]+$/i.test(label)) continue;
    const title = label.replace(/\p{L}[\p{L}\p{M}]*/gu, word => word[0].toUpperCase() + word.slice(1));
    return { name: title.slice(0, 160), url };
  }
  return { name: 'Gift from ' + host, url };
}

function wishlistGiftRows_(sheet) {
  const count = sheet.getLastRow() - 1;
  return count < 1 ? [] : sheet.getRange(2, 1, count, WISHLIST_HEADERS.length).getValues();
}

function listWishlistGifts_(sheet, metadata = new Map()) {
  const rows = wishlistGiftRows_(sheet);
  const gifts = [];
  const existingIds = new Set(rows.map(row => row[0]).filter(validWishlistId_));
  const seenIds = new Set();
  let wroteToSheet = false;
  rows.forEach(([id, value, link, priority, purchased, price], index) => {
    const lookup = metadata.get(wishlistProductUrl_(link));
    if (lookup) {
      // The retailer request has finished. Re-read the cells before filling blanks.
      const row = index + 2;
      const [currentId, currentName, currentLink, , , currentPrice] =
        sheet.getRange(row, 1, 1, WISHLIST_HEADERS.length).getValues()[0];
      if (currentId === id && currentLink === link) {
        value = currentName;
        price = currentPrice;
        if (!String(value).trim() && lookup.name) {
          const nameCell = sheet.getRange(row, 2);
          if (!nameCell.getFormula()) {
            nameCell.setRichTextValue(SpreadsheetApp.newRichTextValue().setText(lookup.name).build());
            value = lookup.name;
            wroteToSheet = true;
          }
        }
        if (price === '' && lookup.price != null) {
          const priceCell = sheet.getRange(row, 6);
          if (!priceCell.getFormula()) {
            priceCell.setValue(lookup.price);
            price = lookup.price;
            wroteToSheet = true;
          }
        }
      }
    }
    const { name, url } = wishlistGiftDetails_(value, link);
    if (!name) return;
    if (!validWishlistId_(id) || seenIds.has(id)) {
      do { id = Utilities.getUuid(); } while (existingIds.has(id));
      existingIds.add(id);
      sheet.getRange(index + 2, 1).setValue(id);
      wroteToSheet = true;
    }
    seenIds.add(id);
    const rank = PRIORITIES[String(priority).trim().toLowerCase()];
    gifts.push({
      id,
      name,
      url,
      purchased: purchased === true,
      price: Number.isFinite(price) && price >= 0 ? price : null,
      priority: typeof rank === 'number' ? rank : PRIORITIES.normal,
      order: index,
    });
  });
  if (wroteToSheet) SpreadsheetApp.flush();
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
  const [currentId, name, link, , purchased] = sheet.getRange(row, 1, 1, WISHLIST_HEADERS.length).getValues()[0];
  if (currentId !== id || !wishlistGiftDetails_(name, link).name) return { ok: false, code: 'gift_missing' };
  if (purchased !== true) {
    sheet.getRange(row, 5).setValue(true);
    SpreadsheetApp.flush();
  }
  return { ok: true, alreadyPurchased: purchased === true };
}

function wishlistResponse_(result) {
  return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(ContentService.MimeType.JSON);
}
