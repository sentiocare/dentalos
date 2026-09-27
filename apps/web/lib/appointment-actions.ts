"use client";

import { useTranslations } from "next-intl";
import { useCallback, useState } from "react";
import { useToast } from "../components/ui";
import { ApiError, newIdempotencyKey } from "./api";
import { useOutbox } from "./outbox";
import type { Appointment, AppointmentStatus } from "./types";

export interface PendingConfirmation {
  warnings: string[];
  retry: () => Promise<void>;
}

/**
 * Appointment changes with optimistic updates. Offline, changes are queued (the outbox); when the server
 * refuses a change the local copy is restored and the reason shown. Staff bookings outside the normal
 * schedule come back as "needs confirmation" and are retried with acknowledgeWarnings.
 */
export function useAppointmentActions(
  setData: (update: (current: Appointment[] | null) => Appointment[] | null) => void,
  reload: () => Promise<void>,
) {
  const t = useTranslations();
  const toast = useToast();
  const { send } = useOutbox();
  const [confirmation, setConfirmation] = useState<PendingConfirmation | null>(null);

  const patchLocal = useCallback(
    (id: string, change: Partial<Appointment>) =>
      setData((list) => list?.map((a) => (a.id === id ? { ...a, ...change } : a)) ?? list),
    [setData],
  );

  const handleError = useCallback(
    async (error: unknown, retryWithAck?: () => Promise<void>) => {
      if (error instanceof ApiError && error.code === "needs_confirmation" && retryWithAck) {
        setConfirmation({ warnings: (error.body.warnings as string[]) ?? [], retry: retryWithAck });
        return;
      }
      if (error instanceof ApiError && error.code === "slot_taken") toast(t("calendar.slotTaken"), "error");
      else toast(error instanceof ApiError ? error.message : t("common.error"), "error");
      await reload();
    },
    [reload, t, toast],
  );

  const setStatus = useCallback(
    async (appointment: Appointment, status: AppointmentStatus) => {
      patchLocal(appointment.id, { status, pending: true });
      try {
        const result = await send({
          method: "POST",
          path: `/v1/appointments/${appointment.id}/status`,
          body: { status },
          label: `${t(`status.${status}`)}: ${appointment.patient.name}`,
        });
        patchLocal(appointment.id, { pending: result === null });
        if (result === null) toast(t("common.savedOffline"));
      } catch (error) {
        await handleError(error);
      }
    },
    [handleError, patchLocal, send, t, toast],
  );

  const cancel = useCallback(
    async (appointment: Appointment, reason?: string) => {
      patchLocal(appointment.id, { status: "cancelled", pending: true });
      try {
        const result = await send({
          method: "POST",
          path: `/v1/appointments/${appointment.id}/cancel`,
          body: { reason },
          label: `${t("status.cancelled")}: ${appointment.patient.name}`,
        });
        patchLocal(appointment.id, { pending: result === null });
      } catch (error) {
        await handleError(error);
      }
    },
    [handleError, patchLocal, send, t],
  );

  const move = useCallback(
    async (
      appointment: Appointment,
      change: { startsAt: string; endsAt: string; doctorId?: string; chairId?: string },
      acknowledgeWarnings = false,
    ): Promise<void> => {
      const previous = { ...appointment };
      patchLocal(appointment.id, {
        startsAt: change.startsAt,
        endsAt: change.endsAt,
        ...(change.doctorId ? { doctor: { ...appointment.doctor, id: change.doctorId } } : {}),
        ...(change.chairId ? { chair: { ...appointment.chair, id: change.chairId } } : {}),
        pending: true,
      });
      try {
        const result = await send({
          method: "PATCH",
          path: `/v1/appointments/${appointment.id}`,
          body: { ...change, acknowledgeWarnings },
          label: `${t("actions.move")}: ${appointment.patient.name}`,
        });
        if (result === null) toast(t("common.savedOffline"));
        else toast(t("calendar.moved"));
        await reload();
      } catch (error) {
        patchLocal(appointment.id, previous);
        await handleError(error, () => move(previous, change, true));
      }
    },
    [handleError, patchLocal, reload, send, t, toast],
  );

  const book = useCallback(
    async (body: Record<string, unknown>, label: string, acknowledgeWarnings = false): Promise<boolean> => {
      const payload = { idempotencyKey: newIdempotencyKey(), ...body, acknowledgeWarnings };
      try {
        const result = await send({ method: "POST", path: "/v1/appointments", body: payload, label });
        toast(result === null ? t("common.savedOffline") : t("appointment.booked"));
        await reload();
        return true;
      } catch (error) {
        let booked = false;
        await handleError(error, async () => {
          booked = await book(payload, label, true);
        });
        return booked;
      }
    },
    [handleError, reload, send, t, toast],
  );

  return { setStatus, cancel, move, book, confirmation, clearConfirmation: () => setConfirmation(null) };
}
