import type { PaymentEvent } from "@dentalos/adapters";
import { withClinic, type Pool } from "@dentalos/db";
import { paymentLinkPaid } from "./ledger";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A payment event from a clinic's own gateway account (patients paying the clinic). The event is claimed
 * and booked in one transaction, so a failure part-way leaves it unclaimed for the gateway's retry, and a
 * retry after success changes nothing. Only our own references ("plink:<id>") are booked, and only
 * against this clinic's links.
 */
export async function ingestClinicPaymentEvent(
  pool: Pool,
  clinicId: string,
  event: PaymentEvent,
): Promise<{ outcome: "booked" | "duplicate" | "ignored"; receiptId?: string }> {
  if (event.type !== "payment_captured") return { outcome: "ignored" };
  const [kind, linkId] = event.referenceId.split(":");
  if (kind !== "plink" || !linkId || !UUID.test(linkId)) return { outcome: "ignored" };
  return withClinic(pool, { clinicId, actor: "system", role: "system" }, async (c) => {
    const claimed = (
      await c.query("select app.claim_webhook_event('payments', $1, $2) as ok", [event.eventId, clinicId])
    ).rows[0].ok as boolean;
    if (!claimed) return { outcome: "duplicate" as const };
    const paid = await paymentLinkPaid(c, {
      linkId,
      providerPaymentId: event.providerPaymentId,
      amountPaise: event.amountPaise,
      at: event.at,
    });
    if (!paid) return { outcome: "ignored" as const };
    return paid.duplicate
      ? { outcome: "duplicate" as const }
      : { outcome: "booked" as const, receiptId: paid.receiptId };
  });
}
