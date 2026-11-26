# Family Christmas Wishlist

The GitHub Pages site lets shoppers unlock the list, follow shopping links, and
mark gifts as purchased. The shared passphrase is managed in Google Apps Script.
Gift details and purchase checkmarks live in a private Google Sheet.

## Managing gifts

In the Sheet's **Gifts** tab, enter a gift name, an optional HTTP or HTTPS
shopping link, and an optional **High**, **Normal**, or **Low** priority. Leave
the **Gift ID** alone. The wishlist assigns it automatically. Available gifts
appear in priority order, with Sheet row order breaking ties. Sort or move full
rows to keep the IDs, gifts, and checkmarks together.

Clear the Sheet's **Purchased** checkbox to undo an accidental purchase. Shoppers
see gift additions, edits, and checkmark resets the next time they load or refresh
the list.

## Deploying the wishlist

1. Use a private spreadsheet with a **Gifts** tab and these five headers in row 1:
   **Gift ID**, **Gift name**, **Shopping link**, **Priority**, **Purchased**.
   Format the **Purchased** cells as checkboxes.
2. In the standalone Apps Script editor, set the source of **Code.gs** to the
   contents of [Wishlist.gs](apps-script/Wishlist.gs). This file is the whole
   production script, with its own web app handlers.
3. In **Project Settings → Script Properties**, set the private spreadsheet ID
   as `WISHLIST_SPREADSHEET_ID` and a strong family passphrase of at least 20
   characters as `WISHLIST_PASSPHRASE`. Run `setupWishlist` in the editor to
   verify the headers and create the signing key. Approve access if Google asks.
4. Deploy a **Web app** that executes as the owner and allows **Anyone** to
   reach the passphrase prompt. Put the published URL ending in `/exec` in the
   `wishlist-endpoint` meta tag in [index.html](index.html). Publish the repository
   root through GitHub Pages.
5. Try a bad passphrase, then unlock and mark a temporary gift purchased. Verify
   its checkbox in the Sheet and check the list again from a signed-out phone.
   Remove the temporary gift before sharing the page and passphrase with family.

To rotate the passphrase, change `WISHLIST_PASSPHRASE` in Apps Script. Existing
sessions stop working on their next request. Sessions also expire after four
hours. Send the new passphrase to family privately.


## Connection test

This test uses one sample gift and a separate, randomly generated test passphrase. It is the first milestone in [the build plan](Family-Christmas-Wishlist-Plan.md).

1. Create a standalone project in Google Apps Script and paste in the test [Code.gs](apps-script/Code.gs).
2. In **Project Settings**, add the private test Sheet ID as `PROBE_SPREADSHEET_ID` and a randomly generated value of at least 20 characters as `PROBE_PASSPHRASE`. Run `setupProbe` from the editor and approve access to check the configured Sheet.
3. Deploy as a **Web app** that executes as you and allows **Anyone** to access it. Copy the published URL ending in `/exec`.
4. Publish [probe/index.html](probe/index.html) through GitHub Pages. In a signed-out browser, load the test page and try an incorrect passphrase. Then use the test passphrase to read and purchase the sample gift.
5. Open the test page in a second signed-out browser or device and verify that the gift is purchased. Compare with the checkbox in the Sheet. To repeat the test, clear that checkbox in the Sheet.

Archive the test deployment after verification. Use a separate passphrase and the production implementation for the family list.
