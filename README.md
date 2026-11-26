# Family Christmas Wishlist

The GitHub Pages site lets shoppers unlock the list, follow shopping links, and
mark gifts as purchased. Each wishlist lives in a tab of the same private
Google spreadsheet. The tab name is that list's passphrase, including case
and spaces.

## Managing gifts

In the wishlist's tab, enter a gift name, an optional HTTP or HTTPS
shopping link, and an optional **High**, **Normal**, or **Low** priority. Leave
the **Gift ID** alone. The wishlist assigns it automatically. Available gifts
appear in priority order, with Sheet row order breaking ties. Sort or move full
rows to keep the IDs, gifts, and checkmarks together.

Clear the Sheet's **Purchased** checkbox to undo an accidental purchase. Shoppers
see gift additions, edits, and checkmark resets the next time they load or refresh
the list.

Enter an optional US-dollar amount in **Price**. The site displays the saved
amount until you update it in the Sheet. A blank price is hidden.

To add another wishlist, create a blank tab with the headers and checkboxes
described below. Give it its own passphrase as the tab name. Keep the
spreadsheet private and share each tab name only with that list's shoppers.
Rename a tab to change its passphrase. Open sessions for that list will need
the new passphrase on their next request. Sessions also expire after four hours.

## Deploying the wishlist

1. Use a private spreadsheet with at least one wishlist tab and these six headers in row 1:
   **Gift ID**, **Gift name**, **Shopping link**, **Priority**, **Purchased**, **Price**.
   Format the **Purchased** cells as checkboxes.
2. In the standalone Apps Script editor, set the source of **Code.gs** to the
   contents of [Wishlist.gs](apps-script/Wishlist.gs). This file is the whole
   production script, with its own web app handlers.
3. Under **Script Properties** in **Project Settings**, set the private spreadsheet
   ID as `WISHLIST_SPREADSHEET_ID`. Run `setupWishlist` in the editor to
   verify the headers and create the signing key. Approve access if Google asks.
4. Deploy a **Web app** that executes as the owner and allows **Anyone** to
   reach the passphrase prompt. Put the published URL ending in `/exec` in the
   `wishlist-endpoint` meta tag in [index.html](index.html). Publish the repository
   root through GitHub Pages.
5. Try a bad passphrase, then unlock and mark a temporary gift purchased. Verify
   its checkbox in the Sheet and check the list again from a signed-out phone.
   Remove the temporary gift before sharing the page and passphrase with family.

When upgrading the original single-list deployment, first publish the new
version at the existing web app URL. Then rename the original **Gifts** tab
to the current passphrase and remove the old `WISHLIST_PASSPHRASE` script
property. The old passphrase continues to open **Gifts** until the rename.


## Connection test

This test uses one sample gift and a separate, randomly generated test passphrase. It is the first milestone in [the build plan](Family-Christmas-Wishlist-Plan.md).

1. Create a standalone project in Google Apps Script and paste in the test [Code.gs](apps-script/Code.gs).
2. In **Project Settings**, add the private test Sheet ID as `PROBE_SPREADSHEET_ID` and a randomly generated value of at least 20 characters as `PROBE_PASSPHRASE`. Run `setupProbe` from the editor and approve access to check the configured Sheet.
3. Deploy as a **Web app** that executes as you and allows **Anyone** to access it. Copy the published URL ending in `/exec`.
4. Publish [probe/index.html](probe/index.html) through GitHub Pages. In a signed-out browser, load the test page and try an incorrect passphrase. Then use the test passphrase to read and purchase the sample gift.
5. Open the test page in a second signed-out browser or device and verify that the gift is purchased. Compare with the checkbox in the Sheet. To repeat the test, clear that checkbox in the Sheet.

Archive the test deployment after verification. Use a separate passphrase and the production implementation for the family list.
