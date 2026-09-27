import { describe, expect, it } from "vitest";
import { storageContract } from "../testing";
import { SupabaseStorageProvider } from "./supabase";

/** An in-memory stand-in for Supabase Storage's REST API (the shapes our adapter relies on). */
function fakeSupabase() {
  const objects = new Map<string, { bytes: Uint8Array; type: string }>();
  const calls: { method: string; url: string; auth: string | null }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const headers = init.headers as Record<string, string>;
    calls.push({ method: init.method ?? "GET", url, auth: headers.authorization ?? null });
    const path = new URL(url).pathname.replace("/storage/v1/", "");
    if (path.startsWith("object/sign/")) {
      const key = decodeURIComponent(path.replace("object/sign/files/", ""));
      if (!objects.has(key)) return new Response(JSON.stringify({ error: "not found" }), { status: 400 });
      return Response.json({ signedURL: `/object/sign/files/${key}?token=abc` });
    }
    if (path === "object/files" && init.method === "DELETE") {
      for (const k of JSON.parse(String(init.body)).prefixes) objects.delete(k);
      return Response.json([]);
    }
    if (path.startsWith("bucket/")) return Response.json({ id: "files" });
    const key = decodeURIComponent(path.replace("object/files/", ""));
    if (init.method === "POST") {
      objects.set(key, { bytes: new Uint8Array(init.body as Uint8Array), type: headers["content-type"]! });
      return Response.json({ Key: key });
    }
    const o = objects.get(key);
    if (!o) return new Response(JSON.stringify({ error: "Object not found" }), { status: 400 });
    return new Response(o.bytes, { headers: { "content-type": o.type } });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

storageContract("supabase (recorded API shapes)", () => ({
  provider: new SupabaseStorageProvider({
    url: "https://abc.supabase.co",
    serviceRoleKey: "service",
    bucket: "files",
    fetchImpl: fakeSupabase().fetchImpl,
  }),
}));

describe("Supabase storage", () => {
  it("authenticates every call with the service key and returns absolute signed URLs", async () => {
    const api = fakeSupabase();
    const s = new SupabaseStorageProvider({
      url: "https://abc.supabase.co/",
      serviceRoleKey: "service",
      bucket: "files",
      fetchImpl: api.fetchImpl,
    });
    await s.put({ key: "recordings/c1/a b.mp3", bytes: new Uint8Array([1]), contentType: "audio/mpeg" });
    expect(await s.signedUrl("recordings/c1/a b.mp3", 60)).toBe(
      "https://abc.supabase.co/storage/v1/object/sign/files/recordings/c1/a b.mp3?token=abc",
    );
    expect(api.calls.every((c) => c.auth === "Bearer service")).toBe(true);
    expect((await s.healthCheck()).ok).toBe(true);
  });
});
