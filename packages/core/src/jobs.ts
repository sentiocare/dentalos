/** Background job queue as seen by domain code (Graphile Worker in production, an array in tests). */
export interface JobQueue {
  add(
    task: string,
    payload: Record<string, unknown>,
    /** queueName: jobs sharing a queue run one at a time, in order (e.g. one patient's messages). */
    options?: { jobKey?: string; runAt?: Date; queueName?: string },
  ): Promise<void>;
}

export class MemoryJobQueue implements JobQueue {
  readonly jobs: {
    task: string;
    payload: Record<string, unknown>;
    jobKey?: string;
    runAt?: Date;
    queueName?: string;
  }[] = [];
  async add(
    task: string,
    payload: Record<string, unknown>,
    options: { jobKey?: string; runAt?: Date; queueName?: string } = {},
  ) {
    if (options.jobKey) {
      const i = this.jobs.findIndex((j) => j.jobKey === options.jobKey);
      if (i >= 0) this.jobs.splice(i, 1);
    }
    this.jobs.push({ task, payload, ...options });
  }
  take(task: string) {
    const taken = this.jobs.filter((j) => j.task === task);
    for (const j of taken) this.jobs.splice(this.jobs.indexOf(j), 1);
    return taken;
  }
}
