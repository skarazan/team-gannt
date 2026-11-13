# inbox

Drop an import file here (same format as the board's Import button, see the main README) and push to `main`.
After Render redeploys, the board applies each new file **once**, in file-name order, all-or-nothing.
The result (applied or failed, and why) shows under **Auto-updates** on the board.

- Name files `YYYY-MM-DD-NN-short-description.json` so they apply in order.
- Never edit or reuse a file name after it has been applied; add a new file instead.
- Optional `"description"` at the top level is shown in the Auto-updates list.
