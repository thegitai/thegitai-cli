import { getBackgroundJob, hasUnreportedBackgroundJobUpdate } from './background-jobs.js';

export const MAX_CHAINED_JOB_FOLLOW_UPS = 3;

function exitedOnItsOwn(id: string, sessionId: string | null): boolean {
  const job = getBackgroundJob(id, { sessionId });
  return job !== null && job.status !== 'running' && job.status !== 'killed';
}







export function decideJobFollowUp(
  jobIds: readonly string[],
  chainedFollowUps: number,
  sessionId: string | null,
): 'wait' | 'start' | 'stop' {
  if (!jobIds.some((id) => exitedOnItsOwn(id, sessionId))) return 'wait';
  return chainedFollowUps >= MAX_CHAINED_JOB_FOLLOW_UPS ? 'stop' : 'start';
}







export function remainingJobWait(jobIds: readonly string[], sessionId: string | null): string[] {
  return jobIds.filter((id) => {
    const job = getBackgroundJob(id, { sessionId });
    if (job?.status === 'running') return true;
    return exitedOnItsOwn(id, sessionId) && hasUnreportedBackgroundJobUpdate(id, { sessionId });
  });
}






export function createJobWaitTracker(sessionId: () => string | null) {
  let waiting: string[] = [];
  let chained = 0;
  return {
    get waiting(): readonly string[] {
      return waiting;
    },
    turnStarted(jobFollowUp: boolean): void {
      chained = jobFollowUp ? chained + 1 : 0;
    },
    turnEnded(waitingForJobs: readonly string[] | undefined): void {
      waiting = waitingForJobs ? [...waitingForJobs] : remainingJobWait(waiting, sessionId());
    },

    takeDecision(): 'wait' | 'start' | 'stop' {
      const decision = decideJobFollowUp(waiting, chained, sessionId());
      if (decision !== 'wait') waiting = [];
      return decision;
    },
  };
}
