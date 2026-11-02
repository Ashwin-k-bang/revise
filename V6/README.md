# Revise

Standalone revision tracker. Tap a box = revised now. Press and hold (or tap the arrow) = open the topic page.

## Deploy
1. Create a new GitHub repo (e.g. `revise`), upload everything in this folder to the repo root.
2. Settings -> Pages -> Deploy from branch -> `main` / root.
3. Open `https://<user>.github.io/<repo>/`.
4. On each device, tap **Set up sync** once, or open `https://<user>.github.io/<repo>/#token=YOUR_TOKEN` once.
   Token: fine-grained, **only this repo**, Permissions -> Contents: Read and write.

Data is saved to `data/revise.json` in this repo (created automatically on first sync). Do not upload a `data/` folder.
This app has its own sync settings and does not use the Daylog repo or token.
