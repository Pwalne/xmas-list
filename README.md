# xmas-list
List of gifts for children


## Connection test

This test uses one sample gift and a separate, randomly generated test passphrase. It is the first milestone in [the build plan](Family-Christmas-Wishlist-Plan.md).

1. Create a standalone project in Google Apps Script and paste in [Code.gs](apps-script/Code.gs).
2. In **Project Settings**, add the private test Sheet ID as `PROBE_SPREADSHEET_ID` and a randomly generated value of at least 20 characters as `PROBE_PASSPHRASE`. Run `setupProbe` from the editor and approve access to check the configured Sheet.
3. Deploy as a **Web app** that executes as you and allows **Anyone** to access it. Copy the published URL ending in `/exec`.
4. Publish [probe/index.html](probe/index.html) through GitHub Pages. In a signed-out browser, load the test page and try an incorrect passphrase. Then use the test passphrase to read and purchase the sample gift.
5. Open the test page in a second signed-out browser or device and verify that the gift is purchased. Compare with the checkbox in the Sheet. To repeat the test, clear that checkbox in the Sheet.

Archive the test deployment after verification. Use a separate passphrase and the production implementation for the family list.
