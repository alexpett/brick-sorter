# Setting up the Google Sheet backup

Do this once, on a computer. It takes about five minutes.

1. Create a new Google Sheet (call it "Brick Sorter backup").
2. In the sheet choose **Extensions > Apps Script**.
3. Delete everything in the editor and paste in the contents of [`Code.gs`](Code.gs) (open it on GitHub, press **Raw**, select all, copy).
4. Near the top, save your code as a script property named `SECRET_CODE` (Project Settings > Script properties > Add script property), which keeps it out of the code. Or, instead, replace `PASTE-YOUR-SECRET-CODE-HERE` with it. In the app, **Settings > Google Sheet backup > Make a code** makes one for you. Press the disk icon to save.
5. Choose **Deploy > New deployment**. Click the cog next to "Select type" and pick **Web app**.
   - Execute as: **Me**
   - Who has access: **Anyone**
6. Press **Deploy** and approve the permissions. Google warns that the app is unverified because you wrote it yourself: choose **Advanced**, then **Go to (project name)**, then **Allow**.
7. Copy the **Web app URL** (it ends in `/exec`).
8. In the app go to **Settings > Google Sheet backup**, paste the URL and the same secret code, press **Test**, then **Save**.

From then on the app backs up a few seconds after each change, when you open it, and when the phone comes back online. **Sync now** forces it.

## How it works

- The sheet gets four tabs: `sets`, `bins`, `inventory`, `settings`. Each row is one record. The `summary` column is readable; `json` holds the full record.
- Deleted items stay in the sheet marked as deleted, so deletions reach other devices.
- If the same record is changed in two places, the newest change wins.
- Parts lists are not stored in the sheet. A new device downloads them again from Rebrickable (it needs your Rebrickable key).
- Your Rebrickable key is never sent to the sheet.

## Keep it private

"Anyone" access means the web app address can be reached by anyone who has it, but every request must carry your secret code. Treat the address and the code like a password, and never put them in the repository. To rotate the code, change the `SECRET_CODE` property (or constant), choose **Deploy > Manage deployments > Edit > New version > Deploy**, and enter the new code in the app.

## Camera fallback

The camera first tries to send photos to Brickognize straight from the browser. If the browser blocks that, the app sends the photo through this script instead, which forwards it from Google's servers. For that you need the current `Code.gs` deployed as a new version (see below). The photo is not stored in the sheet. This route also tells Brickognize the app's name in its User-Agent, which they asked for.

## Changing the script later

After editing the script, choose **Deploy > Manage deployments**, edit the deployment, pick **New version** and deploy. The address stays the same.

## Updating for goals and badges

The goals, streaks and badges keep a small activity log (one row per save). To back it up and share it between devices, paste the current `Code.gs` into the script and deploy a new version (Deploy → Manage deployments → edit → New version). Until you do, the log stays on each device and nothing is lost; it is sent the first time the app sees the updated script.
