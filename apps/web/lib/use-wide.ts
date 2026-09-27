"use client";

import { useEffect, useState } from "react";

/** True on desk-sized screens (Tailwind's lg, 1024px and up), so wide-only parts aren't rendered on phones. */
export function useWide(): boolean {
  const [wide, setWide] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(min-width: 1024px)");
    const update = () => setWide(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return wide;
}
