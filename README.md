# Family Christmas Wishlist

The GitHub Pages site lets shoppers unlock the list, follow shopping links, and
mark gifts as purchased. One shared passphrase opens the site and all configured
lists. Each website tab can use a gift tab in the organizer's spreadsheet or
a separate Google spreadsheet maintained by another family.

## Managing gifts

In the wishlist's tab, enter a gift name or an HTTP or HTTPS shopping link,
and an optional **High**, **Normal**, or **Low** priority. When the name is
blank, the site can use the title from a supported product page. Otherwise it
uses the product URL or the store's hostname. Leave
the **Gift ID** alone. The wishlist assigns it automatically. Available gifts
appear in priority order, with Sheet row order breaking ties. Sort or move full
rows to keep the IDs, gifts, and checkmarks together.

Clear the Sheet's **Purchased** checkbox to undo an accidental purchase. Shoppers
see gift additions, edits, and checkmark resets the next time they load or refresh
the list.

When a wishlist is opened, the app looks up blank gift names and prices for
direct Amazon.com and Target product links. It saves the product title and an
unambiguous US-dollar price when the retailer makes them available. The
lookup runs in small batches, so additional rows may fill in after refreshing.
The app preserves existing values and formulas. It does not keep saved prices
in sync with the store. If a retailer blocks the lookup or omits the price,
enter it manually in **Price**.

## Adding a child's wishlist

On the website, unlock the family wishlist, then use **Manage wishlists**
and enter the separate admin passphrase. Use the **+** tab to connect a
spreadsheet. Supply the child name, the Google Sheet link or ID if it is a
separate workbook, and the exact gift tab name. The site checks the gift
tab and assigns a List ID for you.

Once admin mode is unlocked, select a wishlist tab and use the pinned
**Add gift** button. Enter a gift name or shopping link, with an optional
priority and price. Use **Exit admin** when you're finished.
The pencil and **×** on each gift let you edit it or delete its entry
from the connected Google Sheet.
The site assigns the Gift ID. The admin passphrase is required to add gifts
or change connected spreadsheets through the site.
Use **Edit** to change a connected child's name, spreadsheet, or gift tab.
Use **Remove** to disconnect a list from the website. The source spreadsheet
and its gifts stay in Google Sheets.

The organizer can also add a row directly to **Wishlist settings** in the private spreadsheet.
The first row contains these headings, in order.

| Column | What to enter |
| --- | --- |
| List ID | A unique, stable ID using lowercase letters, digits, hyphens, or underscores. |
| Child name | The tab label shoppers see after unlocking. |
| Spreadsheet URL or ID | Leave blank for the organizer's workbook. Paste the Google Sheets URL for a separate workbook. |
| Gift tab | The exact name of the tab with the gift headers below. |

For a separate workbook, have its owner share it as **Editor** with the Google
account that deployed the web app. That account writes purchase checkmarks.
Families can edit their own gift sheet directly. The organizer adds its URL to
the private settings tab and keeps that workbook private. The site lists the
configured children after unlocking. Settings changes appear after Refresh or
a page reload. Only the organizer needs access to the settings spreadsheet.

Change the `WISHLIST_PASSPHRASE` script property to revoke existing site
sessions. Sessions also expire after four hours.

Set `WISHLIST_ADMIN_PASSPHRASE` in Apps Script to enable the website settings.
Use a separate, strong passphrase and share it privately with the organizers.
The admin session expires after 30 minutes or closes when you close settings.

## Deploying the wishlist

1. Use a private spreadsheet with at least one wishlist tab and these six headers in row 1:
   **Gift ID**, **Gift name**, **Shopping link**, **Priority**, **Purchased**, **Price**.
   Format the **Purchased** cells as checkboxes.
2. In the standalone Apps Script editor, set the source of **Code.gs** to the
   contents of [Wishlist.gs](apps-script/Wishlist.gs). This file is the whole
   production script, with its own web app handlers.
3. Under **Script Properties** in **Project Settings**, set the private spreadsheet
   ID as `WISHLIST_SPREADSHEET_ID` and the shared passphrase as
   `WISHLIST_PASSPHRASE`. Run `setupWishlist` in the editor to
   verify the headers and create the signing key. Approve access if Google asks.
   Product lookups require authorization for external requests.
4. Deploy a **Web app** that executes as the owner and allows **Anyone** to
   reach the passphrase prompt. Put the published URL ending in `/exec` in the
   `wishlist-endpoint` meta tag in [index.html](index.html). Publish the repository
   root through GitHub Pages.
5. Try a bad passphrase, then unlock and mark a temporary gift purchased. Verify
   its checkbox in the Sheet and check the list again from a signed-out phone.
   Remove the temporary gift before sharing the page and passphrase with family.

The original **Gifts** tab can keep its existing passphrase. Configure its
settings row with List ID `family`, label `Family`, Gift tab `Gifts`, and leave
the spreadsheet cell blank.


## Connection test

This test uses one sample gift and a separate, randomly generated test passphrase. It is the first milestone in [the build plan](Family-Christmas-Wishlist-Plan.md).

1. Create a standalone project in Google Apps Script and paste in the test [Code.gs](apps-script/Code.gs).
2. In **Project Settings**, add the private test Sheet ID as `PROBE_SPREADSHEET_ID` and a randomly generated value of at least 20 characters as `PROBE_PASSPHRASE`. Run `setupProbe` from the editor and approve access to check the configured Sheet.
3. Deploy as a **Web app** that executes as you and allows **Anyone** to access it. Copy the published URL ending in `/exec`.
4. Publish [probe/index.html](probe/index.html) through GitHub Pages. In a signed-out browser, load the test page and try an incorrect passphrase. Then use the test passphrase to read and purchase the sample gift.
5. Open the test page in a second signed-out browser or device and verify that the gift is purchased. Compare with the checkbox in the Sheet. To repeat the test, clear that checkbox in the Sheet.

Archive the test deployment after verification. Use a separate passphrase and the production implementation for the family list.
