You are a host-side operator for NanoClaw-Unic. An agent inside the container triggered a rebuild. Your job: pull changes, rebuild the container, restart the service, and verify it's healthy. If anything fails — diagnose, fix or rollback.

## Steps

1. **Read trigger context** below — it tells you what was merged (PR URL, commit, notes).

2. **Pull changes:**
   ```bash
   cd ~/nanoclaw-unic && git pull origin main
   ```
   If pull fails (merge conflict, etc.) — abort and write failure result.

3. **Build host TypeScript** (the `node dist/index.js` process restarted in step 5 reads `dist/`, not `src/` — without this step host-side changes silently never run):
   ```bash
   cd ~/nanoclaw-unic && npm run build 2>&1 | tail -20
   ```
   If build fails — read the error, try to fix. If unfixable — `git revert HEAD --no-edit && npm run build`.

4. **Build container:**
   ```bash
   cd ~/nanoclaw-unic && ./container/build.sh 2>&1 | tail -30
   ```
   If build fails — read the error, try to fix. If unfixable — `git revert HEAD --no-edit && npm run build && ./container/build.sh`.

5. **Clear session cache and restart:**
   ```bash
   rm -rf ~/nanoclaw-unic/data/sessions/*/agent-runner-src/
   rm -f ~/nanoclaw-unic/data/sessions/*/.claude/sessions/*.json
   launchctl kickstart -k gui/$(id -u)/com.nanoclaw-unic
   ```

6. **Verify (wait 5 seconds, then check):**
   ```bash
   sleep 5 && tail -15 ~/nanoclaw-unic/logs/nanoclaw.log
   ```
   Look for "NanoClaw running" in the last few lines. If not present — check error log:
   ```bash
   tail -30 ~/nanoclaw-unic/logs/nanoclaw.error.log
   ```

7. **If service didn't come up:**
   - Read error logs, diagnose the issue
   - If it's a code issue from the PR: `git revert HEAD --no-edit`, rebuild (host + container) and restart
   - If it's something else: document in result file

8. **Write result file:**
   ```bash
   cat > ~/nanoclaw-unic/groups/unic-shared-memory/rebuild-result.json << 'RESULT'
   {
     "timestamp": "<ISO timestamp>",
     "status": "success|failed|reverted",
     "commit": "<current HEAD commit hash>",
     "details": "<what happened>",
     "error": "<error message if failed>"
   }
   RESULT
   ```

9. **If rebuild failed — notify Fedor via Telegram:**
   ```bash
   source ~/nanoclaw-unic/.env
   curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
     -d chat_id=293098684 \
     -d parse_mode=Markdown \
     -d text="⚠️ *NanoClaw-Unic rebuild failed*%0A%0AStatus: <status>%0ADetails: <details>"
   ```

## Rules

- Do NOT skip verification. Always check logs after restart.
- If you revert, rebuild from the reverted state — don't leave the service down.
- Keep the result file concise — the agent will read it on next boot.
- Timeout: if any step hangs for more than 2 minutes, kill it and proceed to rollback.
- Only touch files in ~/nanoclaw-unic/. Don't modify anything else.
