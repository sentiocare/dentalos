"use client";

import { displayPhone } from "../../../lib/format";

import { useLocale, useTranslations } from "next-intl";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button, Field, Input, Select, Sheet, Spinner, useToast } from "../../../components/ui";
import { ApiError } from "../../../lib/api";
import { useClinicConfig } from "../../../lib/data";
import { useRuntimeConfig } from "../../../lib/runtime-config";
import { useSession } from "../../../lib/session";
import { formatRupees, zonedInstant } from "../../../lib/time";
import type { ClinicConfig, Doctor, Procedure } from "../../../lib/types";

/** Sends a change, shows the outcome, reloads settings. Returns the server response, or null on failure. */
type Save = (method: string, path: string, body?: unknown) => Promise<Record<string, unknown> | null>;

function Section({
  title,
  children,
  open,
  id,
}: {
  title: string;
  children: ReactNode;
  open?: boolean;
  id?: string;
}) {
  const ref = useRef<HTMLDetailsElement>(null);
  // Links from the setup checklist (/settings#hours) open and show their section.
  useEffect(() => {
    if (id && ref.current && window.location.hash === `#${id}`) {
      ref.current.open = true;
      ref.current.scrollIntoView({ block: "start" });
    }
  }, [id]);
  return (
    <details
      ref={ref}
      id={id}
      open={open}
      className="group scroll-mt-16 rounded-2xl border border-slate-200 bg-white"
    >
      <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3 font-semibold">
        {title} <span className="text-slate-400 group-open:rotate-90">›</span>
      </summary>
      <div className="space-y-3 border-t border-slate-100 px-4 py-4">{children}</div>
    </details>
  );
}

export default function SettingsPage() {
  const t = useTranslations("settings");
  const tw = useTranslations("whatsapp");
  const tv = useTranslations("voice");
  const tpay = useTranslations("payments");
  const tla = useTranslations("leadAds");
  const tf = useTranslations("followups");
  const tc = useTranslations("common");
  const { api, can } = useSession();
  const toast = useToast();
  const config = useClinicConfig();
  const manage = can("settings.manage");

  const save: Save = async (method, path, body) => {
    try {
      const result = await api<Record<string, unknown>>(path, { method, body });
      toast(tc("saved"));
      await config.reload();
      return result;
    } catch (e) {
      toast(e instanceof ApiError ? e.message : tc("error"), "error");
      return null;
    }
  };

  if (!config.data) {
    return (
      <div className="flex justify-center py-12 text-slate-400">
        <Spinner />
      </div>
    );
  }
  const c = config.data;
  return (
    <div className="mx-auto max-w-2xl space-y-3 px-4 py-4">
      <h1 className="text-xl font-semibold">{t("title")}</h1>
      {manage ? <ClinicDetails save={save} /> : null}
      <Section id="doctors" title={t("doctors")}>
        <Doctors config={c} save={save} manage={manage} />
      </Section>
      <Section title={t("chairs")}>
        <Chairs config={c} save={save} manage={manage} />
      </Section>
      <Section id="procedures" title={t("procedures")}>
        <Procedures config={c} save={save} manage={manage} />
      </Section>
      <Section id="hours" title={t("hours")}>
        <Hours config={c} save={save} manage={manage} />
      </Section>
      <Section title={t("holidays")}>
        <Holidays config={c} save={save} manage={manage} />
      </Section>
      {can("appointments.write") ? (
        <Section title={t("leaves")}>
          <Leaves config={c} save={save} />
        </Section>
      ) : null}
      {manage ? (
        <Section title={t("emergency")}>
          <Emergency config={c} save={save} />
        </Section>
      ) : null}
      {manage ? (
        <Section id="whatsapp" title={tw("title")}>
          <WhatsApp />
        </Section>
      ) : null}
      {manage ? (
        <Section title={tf("ladders")}>
          <Ladders />
        </Section>
      ) : null}
      {manage ? (
        <Section id="voice" title={tv("title")}>
          <VoiceSettings />
        </Section>
      ) : null}
      {manage ? (
        <Section id="leadAds" title={tla("title")}>
          <LeadAds />
        </Section>
      ) : null}
      {manage ? (
        <Section id="reviews" title={t("reviews.title")}>
          <GoogleReviews />
        </Section>
      ) : null}
      {manage ? (
        <Section id="payments" title={tpay("title")}>
          <PaymentsAccount />
        </Section>
      ) : null}
      {can("staff.manage") ? (
        <Section id="staff" title={t("staff")}>
          <Staff save={save} />
        </Section>
      ) : null}
    </div>
  );
}

function ClinicDetails({ save }: { save: Save }) {
  const t = useTranslations("settings");
  const tc = useTranslations("common");
  const { api } = useSession();
  const [v, setV] = useState<Record<string, string | number> | null>(null);
  useEffect(() => {
    void api<{ clinic: Record<string, string | number | null> }>("/v1/clinic").then(({ clinic }) =>
      setV({
        name: clinic.name ?? "",
        phone: clinic.phone ?? "",
        address: clinic.address ?? "",
        city: clinic.city ?? "",
        mapsUrl: clinic.maps_url ?? "",
        slotStepMin: clinic.slot_step_min ?? 15,
      }),
    );
  }, [api]);
  if (!v) return null;
  const set = (k: string) => (e: { target: { value: string } }) => setV({ ...v, [k]: e.target.value });
  return (
    <Section id="clinic" title={t("clinic")} open>
      <Field label={t("clinicName")}>{(id) => <Input id={id} value={v.name} onChange={set("name")} />}</Field>
      <Field label={t("clinicPhone")}>
        {(id) => <Input id={id} type="tel" value={v.phone} onChange={set("phone")} />}
      </Field>
      <Field label={t("address")}>
        {(id) => <Input id={id} value={v.address} onChange={set("address")} />}
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label={t("city")}>{(id) => <Input id={id} value={v.city} onChange={set("city")} />}</Field>
        <Field label={t("slotStep")}>
          {(id) => (
            <Select id={id} value={v.slotStepMin} onChange={set("slotStepMin")}>
              {[5, 10, 15, 20, 30].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>
      <Field label={t("mapsUrl")}>
        {(id) => <Input id={id} type="url" value={v.mapsUrl} onChange={set("mapsUrl")} />}
      </Field>
      <Button
        onClick={() =>
          void save("PATCH", "/v1/clinic", {
            name: v.name,
            phone: v.phone || null,
            address: v.address || null,
            city: v.city || null,
            mapsUrl: v.mapsUrl || null,
            slotStepMin: Number(v.slotStepMin),
          })
        }
      >
        {tc("save")}
      </Button>
    </Section>
  );
}

function Doctors({ config, save, manage }: { config: ClinicConfig; save: Save; manage: boolean }) {
  const t = useTranslations("settings");
  const tp = useTranslations("patients");
  const tc = useTranslations("common");
  const [editing, setEditing] = useState<Partial<Doctor> | null>(null);
  const [visits, setVisits] = useState<{ weekday: number; start: string; end: string }[]>([]);
  const days = t.raw("weekdays") as string[];

  function open(d?: Doctor) {
    setEditing(d ?? { name: "", kind: "permanent", speciality: "", phone: "", active: true });
    setVisits(
      d
        ? config.visiting
            .filter((v) => v.doctor_id === d.id)
            .map((v) => ({ weekday: v.weekday, start: v.start, end: v.end }))
        : [],
    );
  }

  return (
    <>
      <ul className="divide-y divide-slate-100 text-sm">
        {config.doctors.map((d) => (
          <li key={d.id} className="flex items-center justify-between py-2">
            <div>
              <p className={d.active ? "font-medium" : "text-slate-400"}>
                {d.name} {!d.active ? `(${t("inactive")})` : ""}
              </p>
              <p className="text-xs text-slate-500">
                {t(`kinds.${d.kind}`)}
                {d.speciality ? ` · ${d.speciality}` : ""}
                {d.kind === "visiting"
                  ? ` · ${config.visiting
                      .filter((v) => v.doctor_id === d.id)
                      .map((v) => `${days[v.weekday]!.slice(0, 3)} ${v.start}–${v.end}`)
                      .join(", ")}`
                  : ""}
              </p>
            </div>
            {manage ? (
              <button className="text-brand-700 underline" onClick={() => open(d)}>
                {tc("edit")}
              </button>
            ) : null}
          </li>
        ))}
      </ul>
      {manage ? (
        <Button variant="secondary" onClick={() => open()}>
          + {t("addDoctor")}
        </Button>
      ) : null}
      <Sheet
        open={!!editing}
        onClose={() => setEditing(null)}
        title={editing?.id ? (editing.name ?? "") : t("addDoctor")}
      >
        {editing ? (
          <div className="space-y-3">
            <Field label={t("doctorName")}>
              {(id) => (
                <Input
                  id={id}
                  value={editing.name ?? ""}
                  onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                />
              )}
            </Field>
            <Field label={t("speciality")}>
              {(id) => (
                <Input
                  id={id}
                  value={editing.speciality ?? ""}
                  onChange={(e) => setEditing({ ...editing, speciality: e.target.value })}
                />
              )}
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label={t("qualification")}>
                {(id) => (
                  <Input
                    id={id}
                    placeholder="BDS, MDS"
                    value={editing.qualification ?? ""}
                    onChange={(e) => setEditing({ ...editing, qualification: e.target.value })}
                  />
                )}
              </Field>
              <Field label={t("registrationNo")}>
                {(id) => (
                  <Input
                    id={id}
                    value={editing.registration_no ?? ""}
                    onChange={(e) => setEditing({ ...editing, registration_no: e.target.value })}
                  />
                )}
              </Field>
            </div>
            <Field label={t("kind")}>
              {(id) => (
                <Select
                  id={id}
                  value={editing.kind}
                  onChange={(e) => setEditing({ ...editing, kind: e.target.value as Doctor["kind"] })}
                >
                  {(["permanent", "visiting", "on_call"] as const).map((k) => (
                    <option key={k} value={k}>
                      {t(`kinds.${k}`)}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label={tp("phone")}>
              {(id) => (
                <Input
                  id={id}
                  type="tel"
                  value={editing.phone ?? ""}
                  onChange={(e) => setEditing({ ...editing, phone: e.target.value })}
                />
              )}
            </Field>
            {editing.kind === "visiting" ? (
              <div className="space-y-2">
                <p className="text-sm font-medium">{t("visitingDays")}</p>
                {visits.map((v, i) => (
                  <div key={i} className="grid grid-cols-[1fr_auto_auto_auto] items-center gap-2">
                    <Select
                      value={v.weekday}
                      onChange={(e) =>
                        setVisits(
                          visits.map((x, j) => (j === i ? { ...x, weekday: Number(e.target.value) } : x)),
                        )
                      }
                    >
                      {days.map((d, n) => (
                        <option key={n} value={n}>
                          {d}
                        </option>
                      ))}
                    </Select>
                    <Input
                      type="time"
                      value={v.start}
                      onChange={(e) =>
                        setVisits(visits.map((x, j) => (j === i ? { ...x, start: e.target.value } : x)))
                      }
                    />
                    <Input
                      type="time"
                      value={v.end}
                      onChange={(e) =>
                        setVisits(visits.map((x, j) => (j === i ? { ...x, end: e.target.value } : x)))
                      }
                    />
                    <button
                      onClick={() => setVisits(visits.filter((_, j) => j !== i))}
                      aria-label={tc("remove")}
                    >
                      ✕
                    </button>
                  </div>
                ))}
                <Button
                  variant="ghost"
                  onClick={() => setVisits([...visits, { weekday: 2, start: "11:00", end: "17:00" }])}
                >
                  + {t("addShift")}
                </Button>
              </div>
            ) : null}
            {editing.id ? (
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="size-5"
                  checked={!editing.active}
                  onChange={(e) => setEditing({ ...editing, active: !e.target.checked })}
                />
                {t("inactive")}
              </label>
            ) : null}
            <Button
              className="w-full"
              disabled={!editing.name?.trim()}
              onClick={async () => {
                const body = {
                  name: editing.name,
                  kind: editing.kind,
                  speciality: editing.speciality || null,
                  phone: editing.phone || null,
                  qualification: editing.qualification || null,
                  registrationNo: editing.registration_no || null,
                  ...(editing.id ? { active: editing.active } : {}),
                };
                let id = editing.id;
                if (id) {
                  if (!(await save("PATCH", `/v1/doctors/${id}`, body))) return;
                } else {
                  const created = await save("POST", "/v1/doctors", body);
                  if (!created) return;
                  id = created.id as string;
                }
                if (id && editing.kind === "visiting")
                  await save("PUT", `/v1/doctors/${id}/visiting`, { windows: visits });
                setEditing(null);
              }}
            >
              {tc("save")}
            </Button>
          </div>
        ) : null}
      </Sheet>
    </>
  );
}

function Chairs({ config, save, manage }: { config: ClinicConfig; save: Save; manage: boolean }) {
  const t = useTranslations("settings");
  const tc = useTranslations("common");
  const [name, setName] = useState("");
  return (
    <>
      <ul className="divide-y divide-slate-100 text-sm">
        {config.chairs.map((c) => (
          <li key={c.id} className="flex items-center justify-between py-2">
            <span className={c.active ? "" : "text-slate-400"}>{c.name}</span>
            {manage ? (
              <button
                className="text-brand-700 underline"
                onClick={() => void save("PATCH", `/v1/chairs/${c.id}`, { active: !c.active })}
              >
                {c.active ? t("inactive") : tc("add")}
              </button>
            ) : null}
          </li>
        ))}
      </ul>
      {manage ? (
        <div className="flex gap-2">
          <Input placeholder={t("chairName")} value={name} onChange={(e) => setName(e.target.value)} />
          <Button
            variant="secondary"
            disabled={!name.trim()}
            onClick={async () => {
              if (await save("POST", "/v1/chairs", { name, sortOrder: config.chairs.length + 1 }))
                setName("");
            }}
          >
            {tc("add")}
          </Button>
        </div>
      ) : null}
    </>
  );
}

function Procedures({ config, save, manage }: { config: ClinicConfig; save: Save; manage: boolean }) {
  const t = useTranslations("settings");
  const tc = useTranslations("common");
  const locale = useLocale();
  const [editing, setEditing] = useState<Procedure | null>(null);
  const [min, setMin] = useState("");
  const [max, setMax] = useState("");
  const specialists = config.doctors.filter((d) => d.active);

  return (
    <>
      <ul className="divide-y divide-slate-100 text-sm">
        {config.procedures.map((p) => (
          <li key={p.id} className="flex items-center justify-between gap-2 py-2">
            <div className="min-w-0">
              <p className={p.active ? "font-medium" : "text-slate-400"}>
                {locale === "hi" && p.name_hi ? p.name_hi : p.name}
              </p>
              <p className="text-xs text-slate-500">
                {tc("minutes", { count: p.default_duration_min })} ·{" "}
                {p.price_min_paise !== null
                  ? `${formatRupees(p.price_min_paise, locale)}–${formatRupees(p.price_max_paise, locale)}`
                  : t("priceNotSet")}
                {p.price_public ? " ✓" : ""}
              </p>
            </div>
            {manage ? (
              <button
                className="text-brand-700 underline"
                onClick={() => {
                  setEditing(p);
                  setMin(p.price_min_paise !== null ? String(p.price_min_paise / 100) : "");
                  setMax(p.price_max_paise !== null ? String(p.price_max_paise / 100) : "");
                }}
              >
                {tc("edit")}
              </button>
            ) : null}
          </li>
        ))}
      </ul>
      <Sheet open={!!editing} onClose={() => setEditing(null)} title={editing?.name ?? ""}>
        {editing ? (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <Field label={t("durationMin")}>
                {(id) => (
                  <Input
                    id={id}
                    type="number"
                    min={5}
                    max={480}
                    step={5}
                    value={editing.default_duration_min}
                    onChange={(e) => setEditing({ ...editing, default_duration_min: Number(e.target.value) })}
                  />
                )}
              </Field>
              <Field label={t("bufferMin")}>
                {(id) => (
                  <Input
                    id={id}
                    type="number"
                    min={0}
                    max={120}
                    step={5}
                    value={editing.buffer_after_min}
                    onChange={(e) => setEditing({ ...editing, buffer_after_min: Number(e.target.value) })}
                  />
                )}
              </Field>
              <Field label={`${t("priceRange")} · ${t("priceMin")}`}>
                {(id) => (
                  <Input id={id} type="number" min={0} value={min} onChange={(e) => setMin(e.target.value)} />
                )}
              </Field>
              <Field label={t("priceMax")}>
                {(id) => (
                  <Input id={id} type="number" min={0} value={max} onChange={(e) => setMax(e.target.value)} />
                )}
              </Field>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="size-5"
                checked={editing.price_public}
                onChange={(e) => setEditing({ ...editing, price_public: e.target.checked })}
              />
              {t("pricePublic")}
            </label>
            <div className="space-y-1 text-sm">
              <p className="font-medium">{t("onlyDoctors")}</p>
              <p className="text-xs text-slate-500">{t("anyDoctor")}</p>
              {specialists.map((d) => (
                <label key={d.id} className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    className="size-5"
                    checked={editing.allowed_doctor_ids.includes(d.id)}
                    onChange={(e) =>
                      setEditing({
                        ...editing,
                        allowed_doctor_ids: e.target.checked
                          ? [...editing.allowed_doctor_ids, d.id]
                          : editing.allowed_doctor_ids.filter((x) => x !== d.id),
                      })
                    }
                  />
                  {d.name}
                </label>
              ))}
            </div>
            <ProcedureFollowups editing={editing} setEditing={setEditing} />
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="size-5"
                checked={!editing.active}
                onChange={(e) => setEditing({ ...editing, active: !e.target.checked })}
              />
              {t("inactive")}
            </label>
            <Button
              className="w-full"
              onClick={async () => {
                const ok = await save("PATCH", `/v1/procedures/${editing.id}`, {
                  defaultDurationMin: editing.default_duration_min,
                  bufferAfterMin: editing.buffer_after_min,
                  priceMinPaise: min === "" ? null : Math.round(Number(min) * 100),
                  priceMaxPaise: max === "" ? null : Math.round(Number(max) * 100),
                  pricePublic: editing.price_public && min !== "" && max !== "",
                  allowedDoctorIds: editing.allowed_doctor_ids,
                  active: editing.active,
                  recallMonths: editing.recall_months ?? null,
                  checkin: editing.checkin ?? false,
                  aftercare:
                    editing.aftercare && (editing.aftercare.en || editing.aftercare.hi)
                      ? editing.aftercare
                      : null,
                  depositPaise: editing.deposit_paise ?? null,
                });
                if (ok) setEditing(null);
              }}
            >
              {tc("save")}
            </Button>
          </div>
        ) : null}
      </Sheet>
    </>
  );
}

function Hours({ config, save, manage }: { config: ClinicConfig; save: Save; manage: boolean }) {
  const t = useTranslations("settings");
  const tc = useTranslations("common");
  const days = t.raw("weekdays") as string[];
  const [rows, setRows] = useState(() =>
    config.workingHours
      .filter((w) => w.doctor_id === null)
      .map((w) => ({ weekday: w.weekday, start: w.start, end: w.end })),
  );
  return (
    <>
      {days.map((day, weekday) => {
        const shifts = rows.map((r, i) => ({ ...r, i })).filter((r) => r.weekday === weekday);
        return (
          <div key={weekday} className="flex flex-wrap items-center gap-2 text-sm">
            <span className="w-24 font-medium">{day}</span>
            {shifts.length === 0 ? <span className="text-slate-400">{t("closed")}</span> : null}
            {shifts.map((s) => (
              <span key={s.i} className="flex items-center gap-1">
                <Input
                  type="time"
                  className="w-28"
                  disabled={!manage}
                  value={s.start}
                  onChange={(e) =>
                    setRows(rows.map((r, j) => (j === s.i ? { ...r, start: e.target.value } : r)))
                  }
                />
                –
                <Input
                  type="time"
                  className="w-28"
                  disabled={!manage}
                  value={s.end}
                  onChange={(e) =>
                    setRows(rows.map((r, j) => (j === s.i ? { ...r, end: e.target.value } : r)))
                  }
                />
                {manage ? (
                  <button aria-label={tc("remove")} onClick={() => setRows(rows.filter((_, j) => j !== s.i))}>
                    ✕
                  </button>
                ) : null}
              </span>
            ))}
            {manage ? (
              <button
                className="text-brand-700 underline"
                onClick={() => setRows([...rows, { weekday, start: "10:00", end: "14:00" }])}
              >
                + {t("addShift")}
              </button>
            ) : null}
          </div>
        );
      })}
      {manage ? (
        <Button onClick={() => void save("PUT", "/v1/working-hours", { doctorId: null, windows: rows })}>
          {tc("save")}
        </Button>
      ) : null}
    </>
  );
}

function Holidays({ config, save, manage }: { config: ClinicConfig; save: Save; manage: boolean }) {
  const t = useTranslations("settings");
  const tc = useTranslations("common");
  const [date, setDate] = useState("");
  const [name, setName] = useState("");
  return (
    <>
      <ul className="divide-y divide-slate-100 text-sm">
        {config.holidays.map((h) => (
          <li key={h.id} className="flex justify-between py-2">
            <span>
              {h.date} · {h.name}
            </span>
            {manage ? (
              <button
                className="text-red-700 underline"
                onClick={() => void save("DELETE", `/v1/holidays/${h.id}`)}
              >
                {tc("remove")}
              </button>
            ) : null}
          </li>
        ))}
      </ul>
      {manage ? (
        <div className="grid grid-cols-[auto_1fr_auto] gap-2">
          <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          <Input placeholder={t("holidayName")} value={name} onChange={(e) => setName(e.target.value)} />
          <Button
            variant="secondary"
            disabled={!date || !name.trim()}
            onClick={async () => {
              if (await save("POST", "/v1/holidays", { date, name })) {
                setDate("");
                setName("");
              }
            }}
          >
            {tc("add")}
          </Button>
        </div>
      ) : null}
    </>
  );
}

function Leaves({ config, save }: { config: ClinicConfig; save: Save }) {
  const t = useTranslations("settings");
  const tc = useTranslations("common");
  const tz = config.clinic.timezone;
  const [doctorId, setDoctorId] = useState(config.doctors[0]?.id ?? "");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  return (
    <>
      <ul className="divide-y divide-slate-100 text-sm">
        {config.leaves.map((l) => (
          <li key={l.id} className="flex justify-between py-2">
            <span>
              {config.doctors.find((d) => d.id === l.doctor_id)?.name} · {l.starts_at.slice(0, 10)} →{" "}
              {l.ends_at.slice(0, 10)}
            </span>
            <button
              className="text-red-700 underline"
              onClick={() => void save("DELETE", `/v1/leaves/${l.id}`)}
            >
              {tc("remove")}
            </button>
          </li>
        ))}
      </ul>
      <div className="grid grid-cols-3 gap-2">
        <Select value={doctorId} onChange={(e) => setDoctorId(e.target.value)}>
          {config.doctors
            .filter((d) => d.active)
            .map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
        </Select>
        <Input type="date" aria-label={t("from")} value={from} onChange={(e) => setFrom(e.target.value)} />
        <Input type="date" aria-label={t("to")} value={to} onChange={(e) => setTo(e.target.value)} />
      </div>
      <Button
        variant="secondary"
        disabled={!from || !to || to < from}
        onClick={async () => {
          // Whole days in clinic time: from the start of the first day to the end of the last.
          const startsAt = zonedInstant(from, 0, tz).toISOString();
          const endsAt = zonedInstant(to, 24 * 60, tz).toISOString();
          if (await save("POST", "/v1/leaves", { doctorId, startsAt, endsAt })) {
            setFrom("");
            setTo("");
          }
        }}
      >
        + {t("addLeave")}
      </Button>
    </>
  );
}

function Emergency({ config, save }: { config: ClinicConfig; save: Save }) {
  const t = useTranslations("settings");
  const tc = useTranslations("common");
  const days = t.raw("weekdays") as string[];
  const [chairId, setChairId] = useState(config.chairs[0]?.id ?? "");
  const [weekday, setWeekday] = useState(1);
  const [start, setStart] = useState("19:00");
  const [duration, setDuration] = useState(30);
  return (
    <>
      <ul className="divide-y divide-slate-100 text-sm">
        {config.emergencySlots
          .filter((s) => s.active)
          .map((s) => (
            <li key={s.id} className="flex justify-between py-2">
              <span>
                {days[s.weekday]} {s.start} · {s.duration_min} min ·{" "}
                {config.chairs.find((c) => c.id === s.chair_id)?.name}
              </span>
              <button
                className="text-red-700 underline"
                onClick={() => void save("DELETE", `/v1/emergency-slots/${s.id}`)}
              >
                {tc("remove")}
              </button>
            </li>
          ))}
      </ul>
      <div className="grid grid-cols-2 gap-2">
        <Select value={chairId} onChange={(e) => setChairId(e.target.value)}>
          {config.chairs.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
        <Select value={weekday} onChange={(e) => setWeekday(Number(e.target.value))}>
          {days.map((d, i) => (
            <option key={i} value={i}>
              {d}
            </option>
          ))}
        </Select>
        <Input type="time" value={start} onChange={(e) => setStart(e.target.value)} />
        <Input
          type="number"
          min={10}
          max={240}
          step={5}
          value={duration}
          onChange={(e) => setDuration(Number(e.target.value))}
        />
      </div>
      <Button
        variant="secondary"
        onClick={() =>
          void save("POST", "/v1/emergency-slots", { chairId, weekday, start, durationMin: duration })
        }
      >
        + {t("addEmergency")}
      </Button>
    </>
  );
}

interface StaffRow {
  id: string;
  display_name: string;
  role: string;
  permissions: Record<string, boolean>;
  active: boolean;
  joined: boolean;
  invited_phone: string | null;
  invited_email: string | null;
  email: string | null;
}

function Staff({ save }: { save: Save }) {
  const t = useTranslations("settings");
  const tp = useTranslations("patients");
  const tc = useTranslations("common");
  const { api } = useSession();
  const [staff, setStaff] = useState<StaffRow[]>([]);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [role, setRole] = useState("receptionist");
  const load = () =>
    api<StaffRow[]>("/v1/staff")
      .then(setStaff)
      .catch(() => {});
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <>
      <ul className="divide-y divide-slate-100 text-sm">
        {staff.map((s) => (
          <li key={s.id} className="space-y-1 py-2">
            <div className="flex items-center justify-between">
              <div>
                <p className={s.active ? "font-medium" : "text-slate-400"}>{s.display_name}</p>
                <p className="text-xs text-slate-500">
                  {t(`roles.${s.role}`)} · {s.email ?? s.invited_email ?? displayPhone(s.invited_phone)}{" "}
                  {!s.joined ? `· ${t("notJoined")}` : ""}
                </p>
              </div>
              {s.role !== "owner" ? (
                <button
                  className="text-brand-700 underline"
                  onClick={() => void save("PATCH", `/v1/staff/${s.id}`, { active: !s.active }).then(load)}
                >
                  {s.active ? t("inactive") : tc("add")}
                </button>
              ) : null}
            </div>
            {s.role === "receptionist" ? (
              <label className="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  className="size-4"
                  checked={s.permissions["reports.revenue"] !== false}
                  onChange={(e) =>
                    void save("PATCH", `/v1/staff/${s.id}`, {
                      permissions: { ...s.permissions, "reports.revenue": e.target.checked },
                    }).then(load)
                  }
                />
                {t("canSeeRevenue")}
              </label>
            ) : null}
            {s.role === "receptionist" || s.role === "doctor" ? (
              <label className="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  className="size-4"
                  checked={s.permissions["billing.adjust"] === true}
                  onChange={(e) =>
                    void save("PATCH", `/v1/staff/${s.id}`, {
                      permissions: { ...s.permissions, "billing.adjust": e.target.checked },
                    }).then(load)
                  }
                />
                {t("canAdjustBills")}
              </label>
            ) : null}
          </li>
        ))}
      </ul>
      <div className="grid grid-cols-2 gap-2">
        <Input
          aria-label={tp("name")}
          placeholder={tp("name")}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <Input
          type="email"
          aria-label={t("staffEmail")}
          placeholder={t("staffEmail")}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <Input
          type="tel"
          aria-label={t("staffPhone")}
          placeholder={t("staffPhone")}
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
        />
        <Select value={role} onChange={(e) => setRole(e.target.value)}>
          {(["receptionist", "assistant", "doctor", "owner"] as const).map((r) => (
            <option key={r} value={r}>
              {t(`roles.${r}`)}
            </option>
          ))}
        </Select>
        <Button
          variant="secondary"
          className="col-span-2"
          disabled={!name.trim() || !email.trim()}
          onClick={async () => {
            if (await save("POST", "/v1/staff", { name, email, phone: phone || undefined, role })) {
              setName("");
              setEmail("");
              setPhone("");
              await load();
            }
          }}
        >
          + {t("addStaff")}
        </Button>
      </div>
    </>
  );
}

interface WhatsAppStatus {
  connected: boolean;
  phoneNumberId?: string;
  displayPhone?: string;
  templates: {
    id: string;
    purpose: string;
    name: string;
    language: string;
    body: string;
    meta_status: string;
  }[];
}

const TEMPLATE_STATUSES = ["draft", "submitted", "approved", "rejected", "paused"] as const;

function WhatsApp() {
  const t = useTranslations("whatsapp");
  const tc = useTranslations("common");
  const { api } = useSession();
  const toast = useToast();
  const [status, setStatus] = useState<WhatsAppStatus | null>(null);
  const [form, setForm] = useState({ phoneNumberId: "", displayPhone: "", accessToken: "" });
  const [busy, setBusy] = useState(false);
  const load = () =>
    api<WhatsAppStatus>("/v1/whatsapp")
      .then(setStatus)
      .catch(() => {});
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const call = async (method: string, path: string, body: unknown) => {
    setBusy(true);
    try {
      await api(path, { method, body });
      toast(tc("saved"));
      await load();
      return true;
    } catch (e) {
      toast(e instanceof ApiError ? e.message : tc("error"), "error");
      return false;
    } finally {
      setBusy(false);
    }
  };
  if (!status) return <Spinner />;
  return (
    <>
      <p className={status.connected ? "font-medium text-emerald-700" : "text-slate-600"}>
        {status.connected ? t("connected", { phone: status.displayPhone ?? "" }) : t("notConnected")}
      </p>
      <div className="grid gap-2">
        <Field label={t("phoneNumberId")}>
          {(id) => (
            <Input
              id={id}
              inputMode="numeric"
              value={form.phoneNumberId}
              onChange={(e) => setForm({ ...form, phoneNumberId: e.target.value })}
            />
          )}
        </Field>
        <Field label={t("displayPhone")}>
          {(id) => (
            <Input
              id={id}
              type="tel"
              placeholder="98765 43210"
              value={form.displayPhone}
              onChange={(e) => setForm({ ...form, displayPhone: e.target.value })}
            />
          )}
        </Field>
        <Field label={t("accessToken")}>
          {(id) => (
            <Input
              id={id}
              type="password"
              autoComplete="off"
              value={form.accessToken}
              onChange={(e) => setForm({ ...form, accessToken: e.target.value })}
            />
          )}
        </Field>
        <Button
          busy={busy}
          disabled={
            !form.phoneNumberId.trim() || !form.displayPhone.trim() || form.accessToken.trim().length < 20
          }
          onClick={async () => {
            if (await call("PUT", "/v1/whatsapp", form))
              setForm({ phoneNumberId: "", displayPhone: "", accessToken: "" });
          }}
        >
          {t("connect")}
        </Button>
      </div>
      {status.templates.length ? (
        <div className="space-y-2">
          <p className="font-medium">{t("templates")}</p>
          <p className="text-xs text-slate-500">{t("templatesHelp")}</p>
          <ul className="divide-y divide-slate-100 text-sm">
            {status.templates.map((tpl) => (
              <li key={tpl.id} className="flex items-center justify-between gap-2 py-2">
                <div className="min-w-0">
                  <p className="truncate font-mono text-xs">
                    {tpl.name} · {tpl.language}
                  </p>
                  <p className="truncate text-xs text-slate-500">{tpl.body}</p>
                </div>
                <Select
                  className="w-32 shrink-0"
                  value={tpl.meta_status}
                  onChange={(e) =>
                    void call("PATCH", `/v1/whatsapp/templates/${tpl.id}`, { metaStatus: e.target.value })
                  }
                >
                  {TEMPLATE_STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {t(`statuses.${s}`)}
                    </option>
                  ))}
                </Select>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </>
  );
}

interface VoiceConfig {
  enabled: boolean;
  answerMode: "all" | "after_hours";
  staffPhones: string[];
  outboundCalls: boolean;
  leadCalls: boolean;
  outboundFlowId: string | null;
  virtualNumber: string | null;
  clinicPhone: string | null;
  serviceHealthy: boolean;
}

function VoiceSettings() {
  const t = useTranslations("voice");
  const tc = useTranslations("common");
  const { api } = useSession();
  const toast = useToast();
  const [v, setV] = useState<VoiceConfig | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void api<VoiceConfig>("/v1/voice")
      .then((cfg) =>
        setV({ ...cfg, virtualNumber: cfg.virtualNumber ? displayPhone(cfg.virtualNumber) : "" }),
      )
      .catch(() => {});
  }, [api]);
  if (!v) return <Spinner />;
  return (
    <>
      <p className={v.serviceHealthy ? "text-sm text-emerald-700" : "text-sm text-amber-800"}>
        {v.serviceHealthy ? t("healthy") : t("unhealthy")}
      </p>
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          className="size-5"
          checked={v.enabled}
          onChange={(e) => setV({ ...v, enabled: e.target.checked })}
        />
        {t("enabled")}
      </label>
      <Field label={t("answerMode")}>
        {(id) => (
          <Select
            id={id}
            value={v.answerMode}
            onChange={(e) => setV({ ...v, answerMode: e.target.value as VoiceConfig["answerMode"] })}
          >
            <option value="all">{t("modes.all")}</option>
            <option value="after_hours">{t("modes.after_hours")}</option>
          </Select>
        )}
      </Field>
      <Field label={t("virtualNumber")}>
        {(id) => (
          <Input
            id={id}
            type="tel"
            value={v.virtualNumber ?? ""}
            onChange={(e) => setV({ ...v, virtualNumber: e.target.value })}
          />
        )}
      </Field>
      <div className="space-y-2">
        <p className="text-sm font-medium">{t("staffPhones")}</p>
        {v.staffPhones.map((p, i) => (
          <div key={i} className="flex gap-2">
            <Input
              type="tel"
              aria-label={`${t("staffPhones")} ${i + 1}`}
              value={p}
              onChange={(e) =>
                setV({ ...v, staffPhones: v.staffPhones.map((x, j) => (j === i ? e.target.value : x)) })
              }
            />
            <Button
              variant="secondary"
              onClick={() => setV({ ...v, staffPhones: v.staffPhones.filter((_, j) => j !== i) })}
            >
              ✕
            </Button>
          </div>
        ))}
        {v.staffPhones.length < 5 ? (
          <Button variant="secondary" onClick={() => setV({ ...v, staffPhones: [...v.staffPhones, ""] })}>
            + {t("addPhone")}
          </Button>
        ) : null}
        {v.clinicPhone ? (
          <p className="text-xs text-slate-500">
            {t("clinicPhoneNote", { phone: displayPhone(v.clinicPhone) })}
          </p>
        ) : null}
      </div>
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          className="size-5"
          checked={v.outboundCalls}
          onChange={(e) => setV({ ...v, outboundCalls: e.target.checked })}
        />
        {t("outboundCalls")}
      </label>
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          className="size-5"
          checked={v.leadCalls}
          onChange={(e) => setV({ ...v, leadCalls: e.target.checked })}
        />
        {t("leadCalls")}
      </label>
      <Field label={t("outboundFlowId")} hint={t("outboundFlowHint")}>
        {(id) => (
          <Input
            id={id}
            inputMode="numeric"
            value={v.outboundFlowId ?? ""}
            onChange={(e) => setV({ ...v, outboundFlowId: e.target.value })}
          />
        )}
      </Field>
      <Button
        busy={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await api("/v1/voice", {
              method: "PUT",
              body: {
                enabled: v.enabled,
                answerMode: v.answerMode,
                staffPhones: v.staffPhones.map((p) => p.trim()).filter(Boolean),
                virtualNumber: v.virtualNumber?.trim() || null,
                outboundCalls: v.outboundCalls,
                leadCalls: v.leadCalls,
                outboundFlowId: v.outboundFlowId?.trim() || null,
              },
            });
            toast(tc("saved"));
          } catch (e) {
            toast(e instanceof ApiError ? e.message : tc("error"), "error");
          } finally {
            setBusy(false);
          }
        }}
      >
        {t("save")}
      </Button>
    </>
  );
}

/** Recall, check-in, after-care and advance settings for one treatment (Phase 4 follow-ups). */
function ProcedureFollowups({
  editing,
  setEditing,
}: {
  editing: Procedure;
  setEditing: (p: Procedure) => void;
}) {
  const t = useTranslations("procedureExtra");
  const care = editing.aftercare ?? { en: "", hi: "", approved: false };
  return (
    <div className="space-y-3 rounded-xl bg-slate-50 p-3">
      <div className="grid grid-cols-2 gap-3">
        <Field label={t("recallMonths")}>
          {(id) => (
            <Input
              id={id}
              type="number"
              min={1}
              max={36}
              value={editing.recall_months ?? ""}
              onChange={(e) =>
                setEditing({ ...editing, recall_months: e.target.value ? Number(e.target.value) : null })
              }
            />
          )}
        </Field>
        <Field label={t("deposit")}>
          {(id) => (
            <Input
              id={id}
              type="number"
              min={0}
              value={editing.deposit_paise ? editing.deposit_paise / 100 : ""}
              onChange={(e) =>
                setEditing({
                  ...editing,
                  deposit_paise: e.target.value ? Math.round(Number(e.target.value) * 100) : null,
                })
              }
            />
          )}
        </Field>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          className="size-5"
          checked={!!editing.checkin}
          onChange={(e) => setEditing({ ...editing, checkin: e.target.checked })}
        />
        {t("checkin")}
      </label>
      {(["en", "hi"] as const).map((lang) => (
        <Field key={lang} label={t(lang === "en" ? "aftercareEn" : "aftercareHi")}>
          {(id) => (
            <textarea
              id={id}
              rows={3}
              maxLength={900}
              value={care[lang]}
              // Any change to the wording needs the doctor's approval again.
              onChange={(e) =>
                setEditing({ ...editing, aftercare: { ...care, [lang]: e.target.value, approved: false } })
              }
              className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
            />
          )}
        </Field>
      ))}
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          className="size-5"
          checked={care.approved}
          disabled={!care.en && !care.hi}
          onChange={(e) => setEditing({ ...editing, aftercare: { ...care, approved: e.target.checked } })}
        />
        {t("aftercareApproved")}
      </label>
    </div>
  );
}

interface Ladder {
  kind: string;
  active: boolean;
  steps: { afterHours: number; action: string; atLocalTime?: string; template?: string }[];
}

/** Each kind of automatic follow-up can be switched off (ladders are edited through the API for now). */
function Ladders() {
  const t = useTranslations("followups");
  const tc = useTranslations("common");
  const { api } = useSession();
  const toast = useToast();
  const [ladders, setLadders] = useState<Ladder[] | null>(null);
  const load = () =>
    api<Ladder[]>("/v1/followup-ladders")
      .then(setLadders)
      .catch(() => {});
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  if (!ladders) return <Spinner />;
  return (
    <ul className="divide-y divide-slate-100 text-sm">
      {ladders.map((l) => (
        <li key={l.kind} className="flex items-center justify-between py-2">
          <div>
            <p className="font-medium">{t(`kinds.${l.kind}`)}</p>
            <p className="text-xs text-slate-500">{t("ladderSteps", { count: l.steps.length })}</p>
          </div>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              className="size-5"
              checked={l.active}
              onChange={async (e) => {
                try {
                  await api(`/v1/followup-ladders/${l.kind}`, {
                    method: "PUT",
                    body: { active: e.target.checked, steps: l.steps },
                  });
                  toast(tc("saved"));
                  await load();
                } catch (err) {
                  toast(err instanceof ApiError ? err.message : tc("error"), "error");
                }
              }}
            />
            {t("ladderOn")}
          </label>
        </li>
      ))}
    </ul>
  );
}

/** The clinic's own Razorpay account: patients' payment links pay the clinic directly (Phase 5). */
function PaymentsAccount() {
  const t = useTranslations("payments");
  const tc = useTranslations("common");
  const { api, clinic } = useSession();
  const config = useRuntimeConfig();
  const toast = useToast();
  const [status, setStatus] = useState<{ connected: boolean; keyId?: string } | null>(null);
  const [keys, setKeys] = useState({ keyId: "", keySecret: "", webhookSecret: "" });
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void api<{ connected: boolean; keyId?: string }>("/v1/payments-account")
      .then(setStatus)
      .catch(() => {});
  }, [api]);
  if (!status) return <Spinner />;
  const webhookUrl = `${config.apiUrl}/webhooks/payments/clinic/${clinic?.id ?? ""}`;
  return (
    <div className="space-y-3">
      <p className="text-sm">
        {status.connected ? t("connected", { keyId: status.keyId ?? "" }) : t("notConnected")}
      </p>
      <Field label={t("keyId")}>
        {(id) => (
          <Input
            id={id}
            autoComplete="off"
            value={keys.keyId}
            onChange={(e) => setKeys({ ...keys, keyId: e.target.value })}
          />
        )}
      </Field>
      <Field label={t("keySecret")}>
        {(id) => (
          <Input
            id={id}
            type="password"
            autoComplete="off"
            value={keys.keySecret}
            onChange={(e) => setKeys({ ...keys, keySecret: e.target.value })}
          />
        )}
      </Field>
      <Field label={t("webhookSecret")} hint={t("webhookHint", { url: webhookUrl })}>
        {(id) => (
          <Input
            id={id}
            type="password"
            autoComplete="off"
            value={keys.webhookSecret}
            onChange={(e) => setKeys({ ...keys, webhookSecret: e.target.value })}
          />
        )}
      </Field>
      <Button
        busy={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await api("/v1/payments-account", { method: "PUT", body: keys });
            setStatus({ connected: true, keyId: keys.keyId });
            setKeys({ keyId: "", keySecret: "", webhookSecret: "" });
            toast(tc("saved"));
          } catch (e) {
            toast(e instanceof ApiError ? e.message : tc("error"), "error");
          } finally {
            setBusy(false);
          }
        }}
      >
        {t("connect")}
      </Button>
    </div>
  );
}

/** Facebook/Instagram lead forms: the clinic's Page, and a staff phone that gets hot-lead alerts. */
interface LeadSettings {
  page: { pageId: string; name: string } | null;
  datasetId: string | null;
  signals: { sent: number; failed: number; lastSentAt: string | null; lastError: string | null };
  alertPhone: string | null;
}

function LeadAds() {
  const t = useTranslations("leadAds");
  const tc = useTranslations("common");
  const { api } = useSession();
  const config = useRuntimeConfig();
  const toast = useToast();
  const [s, setS] = useState<LeadSettings | null>(null);
  const [page, setPage] = useState({ pageId: "", pageName: "", pageAccessToken: "" });
  const [alert, setAlert] = useState("");
  const [dataset, setDataset] = useState({ datasetId: "", accessToken: "" });
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void api<LeadSettings>("/v1/lead-settings")
      .then((r) => {
        setS(r);
        setAlert(r.alertPhone ? displayPhone(r.alertPhone) : "");
      })
      .catch(() => {});
  }, [api]);
  if (!s) return <Spinner />;
  const save = async (body: Record<string, unknown>) => {
    setBusy(true);
    try {
      setS(await api("/v1/lead-settings", { method: "PUT", body }));
      setPage({ pageId: "", pageName: "", pageAccessToken: "" });
      setDataset({ datasetId: "", accessToken: "" });
      toast(tc("saved"));
    } catch (e) {
      toast(e instanceof ApiError ? e.message : tc("error"), "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-3">
      <p className="text-sm">{s.page ? t("connected", { name: s.page.name }) : t("notConnected")}</p>
      <Field label={t("pageId")}>
        {(id) => (
          <Input
            id={id}
            inputMode="numeric"
            value={page.pageId}
            onChange={(e) => setPage({ ...page, pageId: e.target.value })}
          />
        )}
      </Field>
      <Field label={t("pageName")}>
        {(id) => (
          <Input
            id={id}
            value={page.pageName}
            onChange={(e) => setPage({ ...page, pageName: e.target.value })}
          />
        )}
      </Field>
      <Field label={t("token")} hint={t("tokenHint", { url: `${config.apiUrl}/webhooks/meta-leads` })}>
        {(id) => (
          <Input
            id={id}
            type="password"
            autoComplete="off"
            value={page.pageAccessToken}
            onChange={(e) => setPage({ ...page, pageAccessToken: e.target.value })}
          />
        )}
      </Field>
      <Button busy={busy} onClick={() => void save({ page })}>
        {t("connect")}
      </Button>
      {s.page ? (
        <div className="space-y-3 rounded-xl bg-slate-50 p-3" data-testid="lead-dataset">
          <p className="text-sm font-medium">{t("datasetTitle")}</p>
          <p className="text-xs text-slate-600">{t("datasetHelp")}</p>
          <p className="text-sm">
            {s.datasetId
              ? t("datasetConnected", { id: s.datasetId, sent: s.signals.sent })
              : t("datasetNotConnected")}
          </p>
          {s.signals.lastError ? (
            <p className="text-xs text-red-700">{t("datasetError", { error: s.signals.lastError })}</p>
          ) : null}
          <Field label={t("datasetId")}>
            {(id) => (
              <Input
                id={id}
                inputMode="numeric"
                value={dataset.datasetId}
                onChange={(e) => setDataset({ ...dataset, datasetId: e.target.value })}
              />
            )}
          </Field>
          <Field label={t("datasetToken")}>
            {(id) => (
              <Input
                id={id}
                type="password"
                autoComplete="off"
                value={dataset.accessToken}
                onChange={(e) => setDataset({ ...dataset, accessToken: e.target.value })}
              />
            )}
          </Field>
          <div className="flex gap-2">
            <Button variant="secondary" busy={busy} onClick={() => void save({ dataset })}>
              {t("datasetConnect")}
            </Button>
            {s.datasetId ? (
              <Button variant="ghost" busy={busy} onClick={() => void save({ dataset: null })}>
                {tc("remove")}
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
      <Field label={t("alertPhone")} hint={t("alertHint")}>
        {(id) => <Input id={id} type="tel" value={alert} onChange={(e) => setAlert(e.target.value)} />}
      </Field>
      <Button variant="secondary" busy={busy} onClick={() => void save({ alertPhone: alert.trim() || null })}>
        {tc("save")}
      </Button>
    </div>
  );
}

/** Google reviews: after each visit, "how was it?"; happy patients get the clinic's review link. */
function GoogleReviews() {
  const t = useTranslations("settings.reviews");
  const tc = useTranslations("common");
  const { api } = useSession();
  const toast = useToast();
  const [v, setV] = useState<{ enabled: boolean; link: string } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void api<{ enabled: boolean; link: string | null }>("/v1/reviews/settings")
      .then((r) => setV({ enabled: r.enabled, link: r.link ?? "" }))
      .catch(() => {});
  }, [api]);
  if (!v) return <Spinner />;
  return (
    <div className="space-y-3">
      <p className="text-sm text-slate-600">{t("help")}</p>
      <Field label={t("link")} hint={t("linkHint")}>
        {(id) => (
          <Input
            id={id}
            type="url"
            inputMode="url"
            placeholder="https://g.page/r/…/review"
            value={v.link}
            onChange={(e) => setV({ ...v, link: e.target.value })}
          />
        )}
      </Field>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          className="size-5"
          checked={v.enabled}
          onChange={(e) => setV({ ...v, enabled: e.target.checked })}
        />
        {t("enabled")}
      </label>
      <p className="text-xs text-slate-500">{t("policy")}</p>
      <Button
        busy={busy}
        onClick={async () => {
          setBusy(true);
          try {
            const r = await api<{ enabled: boolean; link: string | null }>("/v1/reviews/settings", {
              method: "PUT",
              body: { enabled: v.enabled, link: v.link.trim() || null },
            });
            setV({ enabled: r.enabled, link: r.link ?? "" });
            toast(tc("saved"));
          } catch (e) {
            toast(e instanceof ApiError ? e.message : tc("error"), "error");
          } finally {
            setBusy(false);
          }
        }}
      >
        {tc("save")}
      </Button>
    </div>
  );
}
