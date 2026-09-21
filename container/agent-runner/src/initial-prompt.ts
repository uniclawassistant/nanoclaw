const SCHEDULED_TASK_HEADER =
  '[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user or group.]';

const WORK_CONTINUATION_HEADER = (workId: string) =>
  `[WORK CONTINUATION - open work "${workId}". Call close_work("${workId}") once it is done, or it will be woken again.]`;

export function buildInitialPrompt(
  prompt: string,
  isScheduledTask: boolean,
  isWorkContinuation: boolean,
  pendingMessages: string[],
  workId?: string,
): string {
  let initial =
    isScheduledTask && !isWorkContinuation
      ? `${SCHEDULED_TASK_HEADER}\n\n${prompt}`
      : prompt;
  // The remaining text travels verbatim; the work id rides in a separate header
  // line rather than being folded into it.
  if (isWorkContinuation && workId) {
    initial = `${WORK_CONTINUATION_HEADER(workId)}\n\n${initial}`;
  }
  if (pendingMessages.length > 0) {
    initial += `\n${pendingMessages.join('\n')}`;
  }
  return initial;
}
