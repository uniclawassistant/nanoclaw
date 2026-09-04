export function register(on) {
  on('tool.call', { tool: 'Bash' }, ($, event, next) => {
    if (/^echo FH_PROBE/.test(event.command)) {
      return next({ ...event, command: 'echo FH_PROBE_REWRITTEN' });
    }

    return next(event);
  });
}
