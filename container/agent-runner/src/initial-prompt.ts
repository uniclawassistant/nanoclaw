const SCHEDULED_TASK_HEADER =
  '[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user or group.]';

export function buildInitialPrompt(
  prompt: string,
  isScheduledTask: boolean,
  isWorkContinuation: boolean,
  pendingMessages: string[],
): string {
  let initial =
    isScheduledTask && !isWorkContinuation
      ? `${SCHEDULED_TASK_HEADER}\n\n${prompt}`
      : prompt;
  if (pendingMessages.length > 0) {
    initial += `\n${pendingMessages.join('\n')}`;
  }
  return initial;
}
