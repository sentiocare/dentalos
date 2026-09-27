import { withClinic } from "@dentalos/db";
import type { JobHelpers } from "graphile-worker";
import type { WorkerDeps } from "../worker";

/**
 * Call recordings are copied from the telephony provider into our own storage in India (Supabase Mumbai),
 * so staff can play them from the dashboard and they are deleted on our schedule, not the provider's.
 */
export function makeFetchRecordingTask(deps: Pick<WorkerDeps, "pool" | "adapters">) {
  return async (payload: unknown, _helpers: JobHelpers) => {
    const { clinicId, callId } = payload as { clinicId: string; callId: string };
    const ctx = { clinicId, actor: "job:fetch_recording" as const, role: "system" as const };
    const call = await withClinic(
      deps.pool,
      ctx,
      async (c) =>
        (await c.query("select recording_url, recording_key from calls where id = $1", [callId])).rows[0],
    );
    if (!call?.recording_url || call.recording_key) return;
    const recording = await deps.adapters.telephony.fetchRecording(call.recording_url);
    if (!recording) return;
    const ext = recording.mimeType.includes("wav") ? "wav" : "mp3";
    const key = `recordings/${clinicId}/${callId}.${ext}`;
    await deps.adapters.storage.put({ key, bytes: recording.bytes, contentType: recording.mimeType });
    await withClinic(deps.pool, ctx, (c) =>
      c.query("update calls set recording_key = $2 where id = $1", [callId, key]),
    );
  };
}

/** Nightly: delete recordings past the clinic's retention period (COMPLIANCE decision 5, default 90 days). */
export function makePurgeRecordingsTask(deps: Pick<WorkerDeps, "pool" | "adapters" | "logger">) {
  return async () => {
    const { rows: clinics } = await deps.pool.query(
      "select id, coalesce((settings->'retention'->>'recordingDays')::int, 90) as days from clinics",
    );
    for (const clinic of clinics) {
      const ctx = { clinicId: clinic.id, actor: "job:purge_recordings" as const, role: "system" as const };
      const old = await withClinic(
        deps.pool,
        ctx,
        async (c) =>
          (
            await c.query(
              "select id, recording_key from calls where recording_key is not null and started_at < now() - make_interval(days => $1)",
              [clinic.days],
            )
          ).rows,
      );
      for (const row of old) {
        await deps.adapters.storage.delete(row.recording_key);
        await withClinic(deps.pool, ctx, (c) =>
          c.query("update calls set recording_key = null, recording_url = null where id = $1", [row.id]),
        );
      }
      if (old.length)
        deps.logger.info({ clinicId: clinic.id, deleted: old.length }, "old call recordings deleted");
    }
  };
}
