const WISHLIST_HEADERS = ['Gift ID', 'Gift name', 'Shopping link', 'Priority', 'Purchased', 'Price'];
const WISHLIST_PHOTO_HEADER = 'Product photo URL';
const WISHLIST_PHOTO_RETRY_DELAY_MS = 15 * 60 * 1000;
const WISHLIST_PHOTO_RETRY_BATCH = 6;
const PRIORITIES = { high: 0, normal: 1, low: 2 };
const SESSION_LIFETIME_MS = 4 * 60 * 60 * 1000;
const ATTEMPT_WINDOW_MS = 2 * 60 * 1000;
const MAX_FAILED_ATTEMPTS = 12;

const WISHLIST_SETTINGS = 'Wishlist settings';
const SETTINGS_HEADERS = ['List ID', 'Child name', 'Spreadsheet URL or ID', 'Gift tab'];
const SETTINGS_BANNER_HEADER = 'Banner';
const WISHLIST_BANNER_LIMIT = 240;
const GIFT_ADMIN_ACTIONS = ['admin_add_gift', 'admin_add_gifts', 'admin_get_gift', 'admin_edit_gift', 'admin_remove_gift'];
const WISHLIST_BATCH_LIMIT = 25;
const ADMIN_ACTIONS = ['admin_unlock', 'admin_lists', 'admin_open', 'admin_add_list', 'admin_edit_list', 'admin_remove_list', ...GIFT_ADMIN_ACTIONS];

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
  if (typeof body !== 'string' || !body || body.length > 48000) {
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
  if (body.length > 2048 && request.action !== 'admin_add_gifts') {
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
        const result = withWishlistLock_(() => unlockWishlist_(
          request.passphrase, properties, adminPassphrase, adminKey, 'WISHLIST_ADMIN_FAILED_ATTEMPTS', 30 * 60 * 1000
        ), LockService.getUserLock());
        if (!result.ok || !request.includeLists) return wishlistResponse_(result);
        const directory = manageWishlists_(properties, { action: 'admin_lists' }, adminKey, sessionKey);
        return wishlistResponse_(directory.ok ? { ...result, lists: directory.lists } : directory);
      }
      if (!validWishlistToken_(request.adminToken, adminKey, Date.now())) {
        return wishlistResponse_({ ok: false, code: 'admin_session_expired' });
      }
      if (['admin_lists', 'admin_open', 'admin_get_gift'].includes(request.action)) {
        return wishlistResponse_(manageWishlists_(properties, request, adminKey, sessionKey));
      }
      let newGift;
      let batchGifts;
      if (request.action === 'admin_edit_gift' && (amazonShortProductUrl_(request.link) || wishlistProductUrl_(request.link))) {
        newGift = wishlistGiftInput_(request);
        if (!newGift) return wishlistResponse_({ ok: false, code: 'invalid_gift' });
        fillWishlistProductDetails_([newGift]);
      }
      if (request.action === 'admin_add_gift') {
        newGift = wishlistGiftInput_(request);
        if (!newGift || typeof request.giftId !== 'string' || !/^[0-9a-f-]{36}$/.test(request.giftId)) {
          return wishlistResponse_({ ok: false, code: 'invalid_gift' });
        }
        // Fetch before taking the write lock so a slow retailer cannot block shoppers.
        fillWishlistProductDetails_([newGift]);
      }
      if (request.action === 'admin_add_gifts') {
        batchGifts = validateWishlistGiftBatch_(request.gifts);
        if (!batchGifts) return wishlistResponse_({ ok: false, code: 'invalid_gift_batch' });
        // Fetch outside the write lock. A retailer failure must not prevent saving.
        fillWishlistProductDetails_(batchGifts);
      }
      return wishlistResponse_(withWishlistLock_(() =>
        manageWishlists_(properties, request, adminKey, sessionKey, newGift, batchGifts)));
    }
    if (request.action === 'unlock') {
      if (typeof request.passphrase !== 'string' || !request.passphrase || request.passphrase.length > 256) {
        return wishlistResponse_({ ok: false, code: 'invalid_request' });
      }
      const result = withWishlistLock_(() =>
        unlockWishlist_(request.passphrase, properties, passphrase, sessionKey), LockService.getUserLock());
      if (!result.ok || !request.includeView) return wishlistResponse_(result);
      return wishlistResponse_({ ...result, ...openWishlist_(configuredWishlists_(properties), request.listId, sessionKey) });
    }
    if (!['open', 'directory', 'list', 'purchase', 'retry_photos'].includes(request.action)) {
      return wishlistResponse_({ ok: false, code: 'invalid_request' });
    }
    if (!validWishlistToken_(request.token, sessionKey, Date.now())) {
      return wishlistResponse_({ ok: false, code: 'session_expired' });
    }
    if (request.action === 'retry_photos') {
      return wishlistResponse_(retryWishlistPhotos_(properties, request, sessionKey));
    }
    if (request.action === 'purchase' && !validWishlistId_(request.giftId)) {
      return wishlistResponse_({ ok: false, code: 'invalid_request' });
    }

    const readOrPurchase = () => {
      const lists = configuredWishlists_(properties);
      if (request.action === 'open') return openWishlist_(lists, request.listId, sessionKey);
      if (request.action === 'directory') {
        return { ok: true, lists: Array.from(lists.values(), wishlistDirectoryEntry_) };
      }
      const list = lists.get(request.listId ?? (lists.size === 1 ? lists.keys().next().value : ''));
      if (!list) return { ok: false, code: 'list_unavailable' };
      const listRevision = wishlistSourceRevision_(list, sessionKey);
      if (request.action === 'purchase' && request.listRevision != null && request.listRevision !== listRevision) {
        return { ok: false, code: 'list_changed' };
      }
      const sheet = wishlistGiftSheet_(list);
      if (!sheet) return { ok: false, code: 'list_unavailable' };
      if (request.action === 'purchase') return purchaseWishlistGift_(sheet, request.giftId);
      return wishlistView_(list, sessionKey, sheet);
    };
    return wishlistResponse_(request.action === 'purchase' ? withWishlistLock_(readOrPurchase) : readOrPurchase());
  } catch (error) {
    console.error('Wishlist operation failed: ' + error.name);
    return wishlistResponse_({ ok: false, code: 'service_unavailable' });
  }
}

function wishlistSourceRevision_(list, sessionKey) {
  return signWishlist_(JSON.stringify([list.id, list.spreadsheetId, list.tab]), sessionKey);
}

function wishlistView_(list, sessionKey, sheet = wishlistGiftSheet_(list), lockHeld = false) {
  if (!sheet) return { ok: false, code: 'list_unavailable' };
  const gifts = listWishlistGifts_(sheet, lockHeld);
  const listRevision = wishlistSourceRevision_(list, sessionKey);
  const now = Date.now();
  const keys = lockHeld ? [] : gifts.filter(gift => gift.id && gift.detailsRetryAt && gift.detailsRetryAt <= now)
    .map(gift => wishlistRetryKey_(listRevision, gift.id));
  const coolingDown = keys.length ? CacheService.getScriptCache().getAll(keys) : {};
  return { ok: true, gifts: gifts.map(({ detailsRetryAt, ...gift }) => gift),
    listRevision, photoRetryDue: keys.some(key => !coolingDown[key]) };
}

function openWishlist_(lists, preferredId, sessionKey) {
  const list = lists.get(preferredId) || lists.values().next().value;
  return {
    ok: true,
    lists: Array.from(lists.values(), wishlistDirectoryEntry_),
    selectedId: list?.id,
    view: list ? wishlistView_(list, sessionKey) : null,
  };
}

function withWishlistLock_(callback, lock = LockService.getScriptLock(), wait = 5000) {
  if (!lock.tryLock(wait)) return { ok: false, code: 'busy' };
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
  return readConfiguredWishlists_(homeId, home.getSheetByName(WISHLIST_SETTINGS));
}

function wishlistDirectoryEntry_({ id, name, banner }) {
  return banner ? { id, name, banner } : { id, name };
}

function wishlistSettingsBannerColumn_(headers) {
  const index = headers.indexOf(SETTINGS_BANNER_HEADER, SETTINGS_HEADERS.length);
  return index < 0 ? 0 : index + 1;
}

function readConfiguredWishlists_(homeId, settings) {
  const lists = new Map();
  if (!settings) {
    lists.set('family', { id: 'family', name: 'Family', spreadsheetId: homeId, tab: 'Gifts' });
    return lists;
  }

  const headers = settings.getRange(1, 1, 1, Math.max(SETTINGS_HEADERS.length, settings.getLastColumn())).getDisplayValues()[0];
  if (!SETTINGS_HEADERS.every((header, index) => header === headers[index])) {
    throw new Error('Unexpected Wishlist settings headers.');
  }
  const count = settings.getLastRow() - 1;
  if (count < 1) return lists;
  const bannerColumn = wishlistSettingsBannerColumn_(headers);
  const rows = settings.getRange(2, 1, count, Math.max(SETTINGS_HEADERS.length, bannerColumn)).getDisplayValues();

  for (const [index, row] of rows.entries()) {
    const [rawId, rawName, source, tab] = row;
    const id = rawId.trim();
    const name = rawName.trim();
    const spreadsheetId = source.trim() ? wishlistSpreadsheetId_(source.trim()) : homeId;
    if (!/^[a-z0-9_-]{1,48}$/.test(id) || !name || name.length > 80 || !spreadsheetId ||
        !tab.trim() ||
        (spreadsheetId === homeId && tab.toLowerCase() === WISHLIST_SETTINGS.toLowerCase())) continue;
    if (lists.has(id)) throw new Error('Duplicate list ID in Wishlist settings.');
    const banner = bannerColumn ? row[bannerColumn - 1].trim().slice(0, WISHLIST_BANNER_LIMIT) : '';
    lists.set(id, { id, name, spreadsheetId, tab, banner, row: index + 2 });
  }
  return lists;
}

function manageWishlists_(properties, request, adminKey, sessionKey, newGift, batchGifts) {
  const homeId = properties.getProperty('WISHLIST_SPREADSHEET_ID');
  const settings = SpreadsheetApp.openById(homeId).getSheetByName(WISHLIST_SETTINGS);
  if (!settings) return { ok: false, code: 'admin_unavailable' };
  const lists = readConfiguredWishlists_(homeId, settings);
  const renderList = list => ({
    ...wishlistDirectoryEntry_(list),
    source: list.spreadsheetId === homeId ? '' : list.spreadsheetId,
    tab: list.tab,
  });
  if (request.action === 'admin_lists') {
    return { ok: true, lists: Array.from(lists.values(), renderList) };
  }
  if (request.action === 'admin_open') {
    return { ...openWishlist_(lists, request.listId, sessionKey), managedLists: Array.from(lists.values(), renderList) };
  }
  const existing = lists.get(request.listId);
  if (request.action !== 'admin_add_list') {
    if (!existing || JSON.stringify(renderList(existing)) !== request.previous) {
      return { ok: false, code: 'list_changed' };
    }
  }
  if (GIFT_ADMIN_ACTIONS.includes(request.action)) {
    const sheet = wishlistGiftSheet_(existing);
    if (!sheet) return { ok: false, code: 'list_unavailable' };
    let result;
    if (request.action === 'admin_add_gifts') {
      result = addWishlistGifts_(sheet, batchGifts);
    } else if (request.action === 'admin_add_gift') {
      result = addWishlistGift_(sheet, request.giftId, newGift);
    } else {
      result = editWishlistGift_(sheet, existing.id, request, adminKey, newGift);
    }
    if (!result.ok || !request.includeView || request.action === 'admin_get_gift') return result;
    try {
      return { ...result, view: wishlistView_(existing, sessionKey, sheet, true) };
    } catch {
      // The mutation was saved. Let the client retry just the read.
      return result;
    }
  }
  if (request.action === 'admin_remove_list') {
    settings.getRange(existing.row, 1, 1, SETTINGS_HEADERS.length).clearContent();
    if (existing.banner) writeWishlistBanner_(settings, existing.row, '');
    SpreadsheetApp.flush();
    lists.delete(existing.id);
    return { ok: true, managedLists: Array.from(lists.values(), renderList) };
  }

  const { name, source, tab, banner = existing?.banner || '' } = request;
  if (typeof name !== 'string' || !name.trim() || name.length > 80 ||
      typeof source !== 'string' || source.length > 500 ||
      typeof tab !== 'string' || !tab.trim() || tab.length > 100 ||
      typeof banner !== 'string' || banner.length > WISHLIST_BANNER_LIMIT) {
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
  if (banner.trim() !== (existing?.banner || '')) writeWishlistBanner_(settings, nextRow, banner.trim());
  SpreadsheetApp.flush();
  lists.set(id, { id, name: name.trim(), spreadsheetId, tab, banner: banner.trim() });
  return { ok: true, list: renderList(lists.get(id)), managedLists: Array.from(lists.values(), renderList) };
}

function writeWishlistBanner_(settings, row, banner) {
  const last = settings.getLastColumn();
  const headers = settings.getRange(1, 1, 1, last).getDisplayValues()[0];
  let column = wishlistSettingsBannerColumn_(headers);
  if (!column) {
    if (!banner) return;
    column = last + 1;
    if (column > settings.getMaxColumns()) settings.insertColumnsAfter(last, 1);
    settings.getRange(1, column).setValue(SETTINGS_BANNER_HEADER);
  }
  const cell = settings.getRange(row, column);
  if (banner) cell.setRichTextValue(SpreadsheetApp.newRichTextValue().setText(banner).build());
  else cell.clearContent();
}

function wishlistGiftInput_(request) {
  const { name, link, priority, price } = request;
  if (typeof name !== 'string' || name.length > 200 ||
      typeof link !== 'string' || link.length > 500 ||
      !['High', 'Normal', 'Low'].includes(priority) ||
      typeof price !== 'string' || (price && (!/^\d{1,9}(?:\.\d{1,2})?$/.test(price)))) {
    return null;
  }
  const giftName = name.trim();
  const url = link.trim();
  if ((!giftName && !url) || (url && !/^https?:\/\/[\w.-]+(?::\d+)?(?:[/?#][^\s\\]*)?$/i.test(url))) {
    return null;
  }
  return { name: giftName, link: url, priority, price: price ? Number(price) : '' };
}

function literalGiftText_(text) {
  return /^[=']/.test(text) ? "'" + text : text;
}

function wishlistRowOccupied_(row) {
  return row.some((value, col) => value !== '' && !(col === 4 && value === false));
}

function addWishlistGift_(sheet, giftId, gift) {
  const rows = wishlistGiftRows_(sheet);
  if (rows.some(row => row[0] === giftId)) return { ok: true };

  appendWishlistRows_(sheet, rows, [[giftId, literalGiftText_(gift.name), gift.link, gift.priority, false, gift.price]], [wishlistPhotoValue_(gift)]);
  return { ok: true };
}

function validateWishlistGiftBatch_(entries) {
  if (!Array.isArray(entries) || !entries.length || entries.length > WISHLIST_BATCH_LIMIT) {
    return null;
  }
  const inputIds = new Set();
  const validated = [];
  for (const entry of entries) {
    const id = entry?.giftId;
    if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id) || inputIds.has(id)) {
      return null;
    }
    const gift = wishlistGiftInput_(entry);
    if (!gift) return null;
    inputIds.add(id);
    validated.push({ id, ...gift });
  }
  return validated;
}

function addWishlistGifts_(sheet, validated) {
  const rows = wishlistGiftRows_(sheet);
  const knownIds = new Set(rows.map(([id]) => id));
  const linkKey = link => wishlistProductUrl_(link) || String(link).trim();
  const seenLinks = new Set(rows.map(([, , link]) => linkKey(link)).filter(Boolean));
  const additions = [];
  const photos = [];
  for (const gift of validated) {
    const key = linkKey(gift.link);
    if (knownIds.has(gift.id) || (key && seenLinks.has(key))) continue;
    if (key) seenLinks.add(key);
    additions.push([gift.id, literalGiftText_(gift.name), gift.link, gift.priority, false, gift.price]);
    photos.push(wishlistPhotoValue_(gift));
  }
  if (additions.length) appendWishlistRows_(sheet, rows, additions, photos);
  return { ok: true, added: additions.length, skipped: validated.length - additions.length };
}

function appendWishlistRows_(sheet, rows, additions, photos) {
  let end = rows.length;
  while (end && !wishlistRowOccupied_(rows[end - 1])) end--;
  // Keep formulas that appear blank, along with the existing checkbox formatting.
  let start = end + 2;
  if (rows.length > end) {
    const formulas = sheet.getRange(start, 1, rows.length - end, WISHLIST_HEADERS.length).getFormulas();
    for (let index = formulas.length - 1; index >= 0; index--) {
      if (!formulas[index].some(Boolean)) continue;
      start += index + 1;
      break;
    }
  }
  const maxRows = sheet.getMaxRows();
  const extra = start + additions.length - 1 - maxRows;
  if (extra > 0) sheet.insertRowsAfter(maxRows, extra);
  sheet.getRange(start, 1, additions.length, WISHLIST_HEADERS.length).setValues(additions);
  if (photos.some(Boolean)) {
    const column = wishlistPhotoColumn_(sheet, true);
    sheet.getRange(start, column, photos.length, 1).setValues(photos.map(photo => [photo || '']));
  }
  SpreadsheetApp.flush();
}

function editWishlistGift_(sheet, listId, request, adminKey, preparedGift) {
  if (!validWishlistId_(request.giftId)) return { ok: false, code: 'invalid_gift' };
  const cells = findWishlistGift_(sheet, request.giftId);
  if (!cells) return { ok: false, code: 'gift_missing' };
  const [values] = cells.getValues();
  const [id, name, link, priority, , price] = values;
  if (id !== request.giftId || !wishlistGiftDetails_(name, link).name) {
    return { ok: false, code: 'gift_missing' };
  }
  const [formulas] = cells.getFormulas();
  const revision = signWishlist_(JSON.stringify([listId, values, formulas]), adminKey);
  const knownPriority = ['High', 'Normal', 'Low'].find(value => value.toLowerCase() === String(priority).trim().toLowerCase());
  if (request.action === 'admin_get_gift') {
    return { ok: true, gift: {
      id, name: String(name), link: String(link), priority: knownPriority || 'Normal',
      price: Number.isFinite(price) && price >= 0 ? String(price) : '',
    }, revision };
  }
  if (request.revision !== revision) return { ok: false, code: 'gift_changed' };
  if (request.action === 'admin_remove_gift') {
    cells.clearContent();
    const column = wishlistPhotoColumn_(sheet);
    if (column) sheet.getRange(cells.getRow(), column).clearContent();
  } else {
    const gift = preparedGift || wishlistGiftInput_(request);
    if (!gift) return { ok: false, code: 'invalid_gift' };
    const replacements = [id, gift.name, gift.link, gift.priority, values[4], gift.price];
    const original = [id, String(name), String(link), knownPriority || 'Normal', values[4],
      Number.isFinite(price) && price >= 0 ? price : ''];
    const updated = values.map((value, i) => replacements[i] === original[i]
      ? formulas[i] || (typeof value === 'string' ? literalGiftText_(value) : value)
      : typeof replacements[i] === 'string' ? literalGiftText_(replacements[i]) : replacements[i]);
    cells.setValues([updated]);
    const sameProduct = link === gift.link || link === request.link ||
      (wishlistProductUrl_(gift.link) && wishlistProductUrl_(link) === wishlistProductUrl_(gift.link));
    const photoValue = wishlistPhotoValue_(gift);
    if (photoValue || !sameProduct) {
      const column = wishlistPhotoColumn_(sheet, !!photoValue);
      if (column) {
        const photoCell = sheet.getRange(cells.getRow(), column);
        if (gift.imageUrl || !sameProduct || !photoCell.getValue()) photoCell.setValue(photoValue);
      }
    }
  }
  SpreadsheetApp.flush();
  return { ok: true };
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

function wishlistPhotoColumn_(sheet, create = false) {
  const base = WISHLIST_HEADERS.length;
  const last = sheet.getLastColumn();
  const index = last > base
    ? sheet.getRange(1, base + 1, 1, last - base).getValues()[0].indexOf(WISHLIST_PHOTO_HEADER)
    : -1;
  if (index >= 0) return base + 1 + index;
  if (!create) return 0;
  const max = sheet.getMaxColumns();
  // Existing empty columns can carry the owner's validation rules.
  sheet.insertColumnsAfter(max, 1);
  sheet.getRange(1, max + 1, sheet.getMaxRows(), 1).clearDataValidations();
  sheet.getRange(1, max + 1).setValue(WISHLIST_PHOTO_HEADER);
  return max + 1;
}

function wishlistProductPhotoUrl_(value) {
  const url = typeof value === 'string' ? value.trim() : '';
  return /^https:\/\/(?:m\.media-amazon\.com|images-na\.ssl-images-amazon\.com|target\.scene7\.com)\/[^\s"'<>\\]+$/i.test(url)
    && url.length <= 1500 ? url : '';
}

function needsWishlistTitle_(name) {
  const text = String(name ?? '').trim();
  return !text || /^Gift from (?:amazon\.com|a\.co|target\.com)$/i.test(text);
}

function needsWishlistPrice_(price) {
  return price === '' || price === false;
}

function wishlistDetailsRetryAt_(name, price, photo, link) {
  if (!wishlistProductUrl_(link) && !amazonShortProductUrl_(link)) return 0;
  if (!needsWishlistTitle_(name) && !needsWishlistPrice_(price) && wishlistProductPhotoUrl_(photo)) return 0;
  const marker = typeof photo === 'string' && photo.match(/^pending-photo:(\d{13})$/);
  return marker ? Number(marker[1]) : 1;
}

function wishlistRetryKey_(listRevision, giftId) {
  return 'gift-details-retry:' + listRevision + ':' + giftId;
}

function wishlistPhotoValue_(gift) {
  return gift.imageUrl || (gift.photoChallenged ? 'pending-photo:' + Date.now() : '');
}

function retryWishlistPhotos_(properties, request, sessionKey) {
  const getList = () => configuredWishlists_(properties).get(request.listId);
  const matchesSource = list => list && request.listRevision === wishlistSourceRevision_(list, sessionKey);
  const cache = CacheService.getScriptCache();
  const claimed = withWishlistLock_(() => {
    const list = getList();
    if (!matchesSource(list)) return { ok: false, code: 'list_changed' };
    const sheet = wishlistGiftSheet_(list);
    if (!sheet) return { ok: false, code: 'list_unavailable' };
    const rows = wishlistGiftRows_(sheet);
    if (!rows.length) return { ok: true, jobs: [] };
    const column = wishlistPhotoColumn_(sheet);
    const photos = column ? sheet.getRange(2, column, rows.length, 1).getValues() : [];
    const now = Date.now();
    const candidates = rows.flatMap(([id, name, link, , , price], index) => {
      const photo = photos[index]?.[0];
      const due = wishlistDetailsRetryAt_(name, price, photo, link);
      if (!validWishlistId_(id) || !due || due > now) return [];
      return [{ id, link, name: needsWishlistTitle_(name) ? '' : String(name),
        price: needsWishlistPrice_(price) ? '' : price, imageUrl: wishlistProductPhotoUrl_(photo),
        key: wishlistRetryKey_(request.listRevision, id) }];
    });
    const coolingDown = candidates.length ? cache.getAll(candidates.map(gift => gift.key)) : {};
    const jobs = candidates.filter(gift => !coolingDown[gift.key]).slice(0, WISHLIST_PHOTO_RETRY_BATCH);
    if (jobs.length) cache.putAll(Object.fromEntries(jobs.map(gift => [gift.key, '1'])), WISHLIST_PHOTO_RETRY_DELAY_MS / 1000);
    return { ok: true, jobs };
  }, LockService.getScriptLock(), 0);
  if (!claimed.ok) return claimed;

  const lookups = claimed.jobs.map(job => ({ ...job }));
  fillWishlistProductDetails_(lookups, true);
  const found = lookups.flatMap((gift, index) => {
    const original = claimed.jobs[index];
    const update = {};
    if (!original.name && gift.name) update.name = gift.name;
    if (original.price === '' && gift.price !== '') update.price = gift.price;
    if (!original.imageUrl && gift.imageUrl) update.imageUrl = gift.imageUrl;
    return Object.keys(update).length ? [{ id: gift.id, link: original.link, update }] : [];
  });
  if (!found.length) return { ok: true, photos: {}, details: {} };
  return withWishlistLock_(() => {
    const list = getList();
    if (!matchesSource(list)) return { ok: false, code: 'list_changed' };
    const sheet = wishlistGiftSheet_(list);
    if (!sheet) return { ok: false, code: 'list_unavailable' };
    let column = wishlistPhotoColumn_(sheet);
    const photos = Object.create(null);
    const details = Object.create(null);
    for (const { id, link, update } of found) {
      const cells = findWishlistGift_(sheet, id);
      if (!cells) continue;
      const [, name, storedLink, , , price] = cells.getValues()[0];
      if (storedLink !== link) continue;
      const [formulas] = cells.getFormulas();
      const saved = {};
      if (update.name && needsWishlistTitle_(name) && !formulas[1]) {
        cells.getCell(1, 2).setValue(literalGiftText_(update.name));
        saved.name = update.name;
      }
      if (update.price != null && needsWishlistPrice_(price) && !formulas[5]) {
        cells.getCell(1, 6).setValue(update.price);
        saved.price = update.price;
      }
      if (update.imageUrl) {
        if (!column) column = wishlistPhotoColumn_(sheet, true);
        const cell = sheet.getRange(cells.getRow(), column);
        const previous = cell.getValue();
        if (!wishlistProductPhotoUrl_(previous) && !cell.getFormula()) {
          cell.setValue(update.imageUrl);
          photos[id] = update.imageUrl;
          saved.imageUrl = update.imageUrl;
        }
      }
      if (Object.keys(saved).length) details[id] = saved;
    }
    if (Object.keys(details).length) SpreadsheetApp.flush();
    return { ok: true, photos, details };
  });
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

function amazonShortProductUrl_(link) {
  const match = typeof link === 'string' && link.trim().match(/^https?:\/\/a\.co\/d\/([a-z0-9]+)\/?(?:[?#]|$)/i);
  return match ? 'https://a.co/d/' + match[1] : '';
}

function resolveAmazonShortProducts_(gifts) {
  const urls = [...new Set(gifts.map(gift => amazonShortProductUrl_(gift.link)).filter(Boolean))];
  if (!urls.length) return;

  const destinations = new Map();
  try {
    const cache = CacheService.getScriptCache();
    const cached = cache.getAll(urls.map(url => 'redirect:' + url));
    const pending = [];
    for (const url of urls) {
      const saved = cached['redirect:' + url];
      if (saved) destinations.set(url, saved);
      else pending.push(url);
    }
    if (pending.length) {
      const responses = UrlFetchApp.fetchAll(pending.map(url => ({
        url, followRedirects: false, muteHttpExceptions: true, timeoutSeconds: 5,
      })));
      for (const [index, response] of responses.entries()) {
        if (![301, 302, 303, 307, 308].includes(response.getResponseCode())) continue;
        const headers = response.getHeaders();
        const locationKey = Object.keys(headers).find(key => key.toLowerCase() === 'location');
        const location = headers[locationKey];
        if (typeof location !== 'string' || !/^(?:https:)?\/\/(?:www\.)?amazon\.com\//i.test(location)) continue;
        const product = wishlistProductUrl_(location.startsWith('//') ? 'https:' + location : location);
        if (!product) continue;
        destinations.set(pending[index], product);
        cache.put('redirect:' + pending[index], product, 21600);
      }
    }
  } catch {
    // Preserve the original store link if the redirect cannot be resolved.
  }
  for (const gift of gifts) {
    const product = destinations.get(amazonShortProductUrl_(gift.link));
    if (product) gift.link = product;
  }
}

function fillWishlistProductDetails_(gifts, refreshIncomplete = false) {
  resolveAmazonShortProducts_(gifts);
  const missing = gifts.filter(gift => !gift.name || gift.price === '' || !gift.imageUrl);
  const urls = [...new Set(missing.map(gift => wishlistProductUrl_(gift.link)).filter(Boolean))];
  if (!urls.length) return;

  const details = new Map();
  const cacheKey = url => 'product-photo:' + url;
  try {
    const cache = CacheService.getScriptCache();
    const cached = cache.getAll(urls.map(cacheKey));
    const pending = urls.filter(url => {
      const value = cached[cacheKey(url)];
      if (!value) return true;
      const product = JSON.parse(value);
      details.set(url, product);
      return refreshIncomplete && missing.some(gift => wishlistProductUrl_(gift.link) === url &&
        ((!gift.name && !product.name) || (gift.price === '' && product.price == null) || (!gift.imageUrl && !product.imageUrl)));
    });
    if (pending.length) {
      const responses = UrlFetchApp.fetchAll(pending.map(url => ({
        url, followRedirects: false, muteHttpExceptions: true, timeoutSeconds: 5,
      })));
      for (const [index, response] of responses.entries()) {
        const url = pending[index];
        const html = response.getContentText().slice(0, 2000000);
        const challenged = url.startsWith('https://www.amazon.com/') &&
          /\/errors\/validateCaptcha\b|<title>\s*Robot Check\s*<\/title>/i.test(html);
        const product = challenged ? { challenged: true }
          : response.getResponseCode() === 200 ? parseWishlistProduct_(html, url) : {};
        const combined = { ...details.get(url), ...product };
        details.set(url, combined);
        if (!challenged) cache.put(cacheKey(url), JSON.stringify(combined), Object.keys(combined).length ? 21600 : 600);
      }
    }
  } catch {
    // Use any details already collected and leave the remaining fields as entered.
  }
  for (const gift of missing) {
    const product = details.get(wishlistProductUrl_(gift.link));
    if (!product) continue;
    if (!gift.name && product.name) gift.name = product.name;
    if (gift.price === '' && product.price != null) gift.price = product.price;
    if (!gift.imageUrl && product.imageUrl) gift.imageUrl = product.imageUrl;
    if (product.challenged) gift.photoChallenged = true;
  }
}

function wishlistProductTitle_(rawName) {
  if (typeof rawName !== 'string') return undefined;
  const entities = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' };
  const title = rawName.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, value) => {
    if (!value.startsWith('#')) return entities[value.toLowerCase()] ?? whole;
    const number = /^#x/i.test(value) ? parseInt(value.slice(2), 16) : Number(value.slice(1));
    return number > 31 && number <= 0x10ffff && !(number >= 0xd800 && number <= 0xdfff)
      ? String.fromCodePoint(number) : whole;
  }).replace(/\s+/g, ' ').trim();
  return title && title.length <= 200 ? title : undefined;
}

function parseAmazonWishlistProduct_(html) {
  const title = html.match(/<span\b[^>]*\bid=["']productTitle["'][^>]*>([^<]*)<\/span>/i);
  if (!title) return {};
  const name = wishlistProductTitle_(title[1]);
  const result = name ? { name } : {};
  const image = html.match(/<img\b[^>]*\sid=["']landingImage["'][^>]*>/i)?.[0];
  const source = image?.match(/\sdata-old-hires=["']([^"']+)["']/i)?.[1]
    || image?.match(/\ssrc=["']([^"']+)["']/i)?.[1];
  const imageUrl = wishlistProductPhotoUrl_(source?.replace(/&amp;/g, '&'));
  if (imageUrl) result.imageUrl = imageUrl;
  const prices = new Set();
  for (const [, raw] of html.matchAll(/<span\b[^>]*\bclass=["'](?:[^"']*\s)?apex-pricetopay-value(?:\s[^"']*)?["'][^>]*>\s*<span\b[^>]*\bclass=["']a-offscreen["'][^>]*>\s*\$((?:\d{1,3}(?:,\d{3})+|\d+)\.\d{2})\s*<\/span>/gi)) {
    prices.add(Number(raw.replace(/,/g, '')));
  }
  if (prices.size === 1) {
    const price = prices.values().next().value;
    if (Number.isFinite(price) && price <= 999999999.99) result.price = price;
  }
  return result;
}

function parseWishlistProduct_(html, url = '') {
  const fallback = url.startsWith('https://www.amazon.com/') ? parseAmazonWishlistProduct_(html) : {};
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
  if (products.length > 1) return fallback;
  const product = products[0];
  const productPage = !!product || one(metadata.get('og:type')) === 'product' || metadata.has('product:price:amount');
  if (!productPage) return fallback;
  const name = wishlistProductTitle_(product?.name || one(metadata.get('og:title'))) || fallback.name;
  if (name) result.name = name;
  const imageUrl = [product?.image].flat().map(value => wishlistProductPhotoUrl_(
    typeof value === 'string' ? value : value?.url || value?.contentUrl
  )).find(Boolean) || fallback.imageUrl || wishlistProductPhotoUrl_(one(metadata.get('og:image')));
  if (imageUrl) result.imageUrl = imageUrl;

  const usdPrice = (amount, currency) =>
    currency === 'USD' && /^\d+(?:\.\d{1,2})?$/.test(String(amount).trim()) && Number.isFinite(Number(amount))
      ? Number(amount) : undefined;
  const offers = [product?.offers].flat().filter(offer => offer && offer.price != null);
  const offerPrices = new Set(offers.map(offer => usdPrice(offer.price, offer.priceCurrency)));
  const price = offers.length ? one(offerPrices) : usdPrice(
    one(metadata.get('product:price:amount') || metadata.get('price')),
    one(metadata.get('product:price:currency') || metadata.get('pricecurrency'))
  );
  if (price != null || fallback.price != null) result.price = price ?? fallback.price;
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

function listWishlistGifts_(sheet, lockHeld = false) {
  const rows = wishlistGiftRows_(sheet);
  const photoColumn = rows.length ? wishlistPhotoColumn_(sheet) : 0;
  const photos = photoColumn ? sheet.getRange(2, photoColumn, rows.length, 1).getValues() : [];
  const gifts = [];
  const existingIds = new Set(rows.map(row => row[0]).filter(validWishlistId_));
  const seenIds = new Set();
  const repairs = [];
  rows.forEach(([id, value, link, priority, purchased, price], index) => {
    const { name, url } = wishlistGiftDetails_(value, link);
    if (!name) return;
    if (!validWishlistId_(id) || seenIds.has(id)) {
      id = null;
      if (lockHeld) {
        do { id = Utilities.getUuid(); } while (existingIds.has(id));
        existingIds.add(id);
      }
      repairs.push({ index, id });
    }
    seenIds.add(id);
    const rank = PRIORITIES[String(priority).trim().toLowerCase()];
    gifts.push({
      id,
      name,
      url,
      purchased: purchased === true,
      price: Number.isFinite(price) && price >= 0 ? price : null,
      imageUrl: wishlistProductPhotoUrl_(photos[index]?.[0]),
      detailsRetryAt: wishlistDetailsRetryAt_(value, price, photos[index]?.[0], link),
      priority: typeof rank === 'number' ? rank : PRIORITIES.normal,
      order: index,
    });
  });
  if (repairs.length && !lockHeld) {
    // Re-read under the lock before touching IDs. Valid gifts stay visible if a write is in progress.
    const result = withWishlistLock_(() => listWishlistGifts_(sheet, true), LockService.getScriptLock(), 0);
    if (Array.isArray(result)) return result;
  }
  if (repairs.length && lockHeld) {
    let first = 0;
    while (first < repairs.length) {
      let end = first + 1;
      while (end < repairs.length && repairs[end].index === repairs[end - 1].index + 1) end++;
      sheet.getRange(repairs[first].index + 2, 1, end - first, 1)
        .setValues(repairs.slice(first, end).map(repair => [repair.id]));
      first = end;
    }
    SpreadsheetApp.flush();
  }
  gifts.sort((left, right) =>
    Number(left.purchased) - Number(right.purchased) ||
    (left.purchased ? 0 : left.priority - right.priority) ||
    left.order - right.order);
  return gifts.map(({ priority, order, ...gift }) => gift);
}

function findWishlistGift_(sheet, id) {
  const count = sheet.getLastRow() - 1;
  if (count < 1) return null;
  const matches = sheet.getRange(2, 1, count, 1).createTextFinder(id)
    .matchEntireCell(true).matchCase(true).findAll();
  return matches.length === 1 ? sheet.getRange(matches[0].getRow(), 1, 1, WISHLIST_HEADERS.length) : null;
}

function purchaseWishlistGift_(sheet, id) {
  const cells = findWishlistGift_(sheet, id);
  if (!cells) return { ok: false, code: 'gift_missing' };
  const [currentId, name, link, , purchased] = cells.getValues()[0];
  if (currentId !== id || !wishlistGiftDetails_(name, link).name) return { ok: false, code: 'gift_missing' };
  if (purchased !== true) {
    cells.getCell(1, 5).setValue(true);
    SpreadsheetApp.flush();
  }
  return { ok: true, alreadyPurchased: purchased === true };
}

function wishlistResponse_(result) {
  return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(ContentService.MimeType.JSON);
}
