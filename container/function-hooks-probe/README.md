# Function hooks SDK probe

This plugin exists only to test whether Claude Code function hooks execute when
NanoClaw uses the Agent SDK. It rewrites a Bash tool call whose command matches
`^echo FH_PROBE` to `echo FH_PROBE_REWRITTEN`.

The host runner forwards `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` only when the
host process has that exact value. The same image therefore supports both
controls:

- Without the environment variable, ask the agent to run `echo FH_PROBE` and
  expect `FH_PROBE`.
- With `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`, ask the agent to run
  `echo FH_PROBE` and expect `FH_PROBE_REWRITTEN`.

Build a separate image for the spike:

```sh
CONTAINER_IMAGE=nanoclaw-agent-function-hooks-spike:fed-56 ./container/build.sh
```

For a host-side positive control, point the NanoClaw launchd service at that
image and add `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` to its
`EnvironmentVariables`. For the negative control, use the same image with that
variable absent. After either plist edit, reload the service:

```sh
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
```

Start a fresh agent session before each control. Restore the previous image and
remove the probe variable after the spike. A `kickstart` is insufficient
because it reuses the already loaded launchd configuration.
