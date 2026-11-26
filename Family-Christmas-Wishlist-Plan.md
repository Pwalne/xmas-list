# Family Christmas Wishlist Build Plan

## First release

Build one mobile-friendly Christmas wishlist for your son. GitHub Pages hosts the public unlock screen, Google Apps Script checks the family passphrase and handles shared updates, and a private Google Sheet stores the gifts.

- **Family editors** add and edit gifts, set their priority, and reset accidental purchase checkmarks in the Sheet.
- **Shoppers** enter the shared passphrase, see the list, open optional shopping links, and check **I bought this** after buying a gift. They can use the page without a Google account.
- Available gifts appear first, sorted from highest to lowest priority. Equal priorities follow Sheet order. Priority is used for sorting only. Purchased gifts appear at the bottom.

## Sheet layout

| Column | What it does |
| --- | --- |
| Gift ID | A permanent ID assigned automatically so row sorting and moves preserve purchase updates. |
| Gift name | Required name shown on the page. |
| Shopping link | Optional web link. |
| Priority | High, Normal, or Low. Blank is treated as Normal. |
| Purchased | A checkbox. Editors can clear it if a shopper checks the wrong item. |

## Build sequence

1. **Prove the connection.** Set up a private test Sheet with a sample gift. From a GitHub Pages test page in a signed-out browser, verify that Apps Script can return the list and confirm a purchase across origins. If the browser cannot reliably read responses, test an Apps Script-hosted wishlist opened from the GitHub Pages landing page before committing to that fallback.
2. **Build access and purchase updates.** Keep the passphrase in server-side configuration. Check authorization before every read or write, keep the passphrase out of source files and URLs, and limit repeated failed attempts. Keep visitors signed in for the browser session with a short-lived token, and invalidate existing sessions when the passphrase changes. Use a server-side lock and the gift ID to check and record each purchase, so concurrent requests report the gift as already purchased after the first successful update.
3. **Build the wishlist page.** Add the passphrase form, the sorted gift list, shopping links, and purchase checkboxes. Wait for confirmation before moving a gift to the purchased section. If a save fails, show the error and let the shopper retry. Give the list a clear empty state.
4. **Verify and publish.** Test the real deployment on two devices, including a signed-out mobile browser. Document how to add gifts, change priority, reset a purchase, and rotate the passphrase. Replace sample gifts with the real list before sharing the URL and passphrase with family.

## Launch checks

- A signed-out visitor with the correct passphrase can open the list. Missing or incorrect credentials block both reads and writes. An old session stops working after rotation.
- Adding or reprioritizing a gift in the Sheet appears after refresh without a site redeploy. Gifts without a link still display. Priority labels are hidden.
- A purchase on one device appears at the bottom on the other after refresh. Two requests for the same gift result in one recorded purchase. Resetting the checkbox returns the gift to its priority position.
- A failed save never displays a false confirmation, and moving Sheet rows before a purchase still updates the correct gift.
