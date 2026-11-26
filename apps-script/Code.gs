const PROBE_SHEET_NAME = 'Gifts';
const PROBE_GIFT_ID = 'sample-gift';

// Run from the editor to verify access and grant authorization before deployment.
function setupProbe() {
  const properties = PropertiesService.getScriptProperties();
  probePassphrase_(properties);
  const sheet = getProbeSheet_(properties);
  const headers = sheet.getRange(1, 1, 1, 5).getValues()[0];
  if (headers.join('|') !== 'Gift ID|Gift name|Shopping link|Priority|Purchased') {
    throw new Error('The Gifts tab does not have the expected headers.');
  }
}

function getProbeSheet_(properties) {
  const spreadsheetId = properties.getProperty('PROBE_SPREADSHEET_ID');
  if (!spreadsheetId) throw new Error('Set PROBE_SPREADSHEET_ID to the private test Sheet ID.');
  const sheet = SpreadsheetApp.openById(spreadsheetId).getSheetByName(PROBE_SHEET_NAME);
  if (!sheet) throw new Error('The test spreadsheet is missing the Gifts tab.');
  return sheet;
}

function doGet() {
  return probeResponse_({ ok: false, code: 'post_required' });
}

function doPost(event) {
  try {
    const body = event && event.postData && event.postData.contents;
    if (!body || body.length > 4096) return probeResponse_({ ok: false, code: 'invalid_request' });

    let request;
    try {
      request = JSON.parse(body);
    } catch {
      return probeResponse_({ ok: false, code: 'invalid_request' });
    }
    if (!request || typeof request !== 'object' || Array.isArray(request)) {
      return probeResponse_({ ok: false, code: 'invalid_request' });
    }

    const properties = PropertiesService.getScriptProperties();
    const configuredPassphrase = probePassphrase_(properties);
    if (typeof request.passphrase !== 'string' || request.passphrase !== configuredPassphrase) {
      return probeResponse_({ ok: false, code: 'unauthorized' });
    }

    const isPurchase = request.action === 'purchase' && request.giftId === PROBE_GIFT_ID;
    if (request.action !== 'read' && !isPurchase) {
      return probeResponse_({ ok: false, code: 'invalid_request' });
    }

    const lock = LockService.getScriptLock();
    if (!lock.tryLock(5000)) return probeResponse_({ ok: false, code: 'busy' });
    try {
      const sheet = getProbeSheet_(properties);
      const count = sheet.getLastRow() - 1;
      const rows = count > 0 ? sheet.getRange(2, 1, count, 5).getValues() : [];
      const index = rows.findIndex(row => row[0] === PROBE_GIFT_ID);
      if (index === -1) return probeResponse_({ ok: false, code: 'sample_missing' });

      const [, name, , , purchased] = rows[index];
      if (isPurchase && purchased !== true) {
        sheet.getRange(index + 2, 5).setValue(true);
        SpreadsheetApp.flush();
      }

      return probeResponse_({
        ok: true,
        gift: { id: PROBE_GIFT_ID, name: String(name), purchased: isPurchase || purchased === true },
        alreadyPurchased: isPurchase && purchased === true,
      });
    } finally {
      lock.releaseLock();
    }
  } catch {
    return probeResponse_({ ok: false, code: 'setup_or_service_error' });
  }
}

function probePassphrase_(properties) {
  const passphrase = properties.getProperty('PROBE_PASSPHRASE');
  if (!passphrase || passphrase.length < 20) {
    throw new Error('Set PROBE_PASSPHRASE to a randomly generated test passphrase with at least 20 characters.');
  }
  return passphrase;
}

function probeResponse_(result) {
  return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(ContentService.MimeType.JSON);
}
